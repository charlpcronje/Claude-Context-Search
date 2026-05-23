"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const Database = require("better-sqlite3");
const readline = require("readline");
const { spawn } = require("child_process");

const { runIndex, getDbPath, getDataDir, initSchema, PROJECTS_DIR } = require("./indexer");
const crypto = require("crypto");

const DEFAULT_PORT = parseInt(process.env.PORT || "5179", 10);

/* ------------ helpers ------------ */

function ftsTerm(t) {
  const s = String(t).trim();
  if (!s) return "";
  const isPrefix = s.endsWith("*") && s.length > 1;
  const core = isPrefix ? s.slice(0, -1) : s;
  const quoted = `"${core.replace(/"/g, '""')}"`;
  return isPrefix ? `${quoted}*` : quoted;
}

function buildFtsMatch({ include = [], exclude = [], match = "all" }) {
  include = include.filter((t) => t && t.trim());
  if (!include.length) return null;
  const joiner = match === "any" ? " OR " : " AND ";
  const inc = include.map(ftsTerm).filter(Boolean).join(joiner);
  if (!inc) return null;
  const excPart = (exclude || []).map(ftsTerm).filter(Boolean).map((q) => ` NOT ${q}`).join("");
  return `${inc}${excPart}`;
}

function parseList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}
function parseIntList(v) {
  return parseList(v).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
}

/* Memory-cached static handler — works inside pkg snapshots. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
function makeStaticHandler() {
  const dir = path.join(__dirname, "public");
  const isPkg = !!process.pkg;
  const cache = {};
  function typeFor(name) {
    return MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
  }
  function loadAll() {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) {
        cache["/" + name] = { buf: fs.readFileSync(full), type: typeFor(name) };
      }
    }
    cache["/"] = cache["/index.html"];
  }
  if (isPkg) loadAll();
  return (req, res, next) => {
    let entry;
    if (isPkg) {
      entry = cache[req.path];
    } else {
      // dev: read fresh each request so edits to public/*.js,*.css show up without restart
      const name = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) entry = { buf: fs.readFileSync(full), type: typeFor(name) };
      } catch {}
    }
    if (entry) {
      res.setHeader("content-type", entry.type);
      res.setHeader("cache-control", "no-cache");
      res.end(entry.buf);
    } else next();
  };
}

/* ------------ app factory ------------ */

function buildApp(db) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(makeStaticHandler());

  app.get("/api/stats", (req, res) => {
    const last = db.prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'").get();
    const sess = db.prepare("SELECT COUNT(*) AS c, SUM(message_count) AS m FROM sessions").get();
    const proj = db.prepare("SELECT COUNT(*) AS c FROM projects").get();
    res.json({
      last_indexed_at: last?.value || null,
      indexing: indexing.running,
      indexing_progress: indexing.progress,
      sessions: sess.c || 0,
      messages: sess.m || 0,
      projects: proj.c || 0,
      projects_dir: PROJECTS_DIR,
      db_path: getDbPath(),
    });
  });

  app.get("/api/projects", (req, res) => {
    const includeBackups = req.query.include_backups === "1";
    const rows = db
      .prepare(
        `
        SELECT
          p.id, p.folder, p.cwd, p.first_seen, p.last_activity,
          COUNT(s.id) AS session_count,
          COALESCE(SUM(s.message_count), 0) AS message_count,
          COALESCE(SUM(s.file_size), 0) AS bytes,
          MAX(s.ended_at) AS last_activity_eff
        FROM projects p
        LEFT JOIN sessions s ON s.project_id = p.id
          ${includeBackups ? "" : "AND s.is_backup = 0"}
        GROUP BY p.id
        HAVING session_count > 0
        ORDER BY last_activity_eff DESC NULLS LAST
      `
      )
      .all();
    res.json({ projects: rows });
  });

  app.get("/api/sessions", (req, res) => {
    const projectId = parseInt(req.query.project_id || "0", 10);
    const includeBackups = req.query.include_backups === "1";
    const includeSubagents = req.query.include_subagents === "1";
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 1000);

    const filters = [];
    const params = {};
    if (projectId) { filters.push("s.project_id = @projectId"); params.projectId = projectId; }
    if (!includeBackups) filters.push("s.is_backup = 0");
    if (!includeSubagents) filters.push("s.is_subagent = 0");

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT s.*, p.folder AS project_folder
         FROM sessions s JOIN projects p ON p.id = s.project_id
         ${where}
         ORDER BY ended_at DESC NULLS LAST
         LIMIT ${limit}`
      )
      .all(params);
    res.json({ sessions: rows });
  });

  app.get("/api/search", (req, res) => {
    const include = parseList(req.query.include);
    const exclude = parseList(req.query.exclude);
    const match = req.query.match === "any" ? "any" : "all";
    const fromIso = req.query.from || null;
    const toIso = req.query.to || null;
    const projectIds = parseIntList(req.query.project_ids);
    const includeBackups = req.query.include_backups === "1";
    const includeSubagents = req.query.include_subagents === "1";
    const onlyUser = req.query.only_user === "1";
    const limit = Math.min(parseInt(req.query.limit || "60", 10), 500);
    const groupBy = req.query.group === "message" ? "message" : "session";

    const t0 = Date.now();

    const sessionFilters = [];
    const params = {};
    if (!includeBackups) sessionFilters.push("s.is_backup = 0");
    if (!includeSubagents) sessionFilters.push("s.is_subagent = 0");
    if (fromIso) { sessionFilters.push("(s.ended_at >= @fromIso OR s.started_at >= @fromIso)"); params.fromIso = fromIso; }
    if (toIso) { sessionFilters.push("(s.started_at <= @toIso OR s.ended_at <= @toIso)"); params.toIso = toIso; }
    if (projectIds.length) {
      sessionFilters.push(`s.project_id IN (${projectIds.map((_, i) => `@pi${i}`).join(",")})`);
      projectIds.forEach((id, i) => (params[`pi${i}`] = id));
    }

    const hasInclude = include.some((t) => t && t.trim());

    if (!hasInclude) {
      const where = sessionFilters.length ? `WHERE ${sessionFilters.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT s.*, p.folder AS project_folder, NULL AS snippet, 0 AS hits, 0 AS rank
           FROM sessions s JOIN projects p ON p.id = s.project_id
           ${where}
           ORDER BY ended_at DESC NULLS LAST
           LIMIT ${limit}`
        )
        .all(params);
      return res.json({
        results: rows, mode: "session", took_ms: Date.now() - t0,
        query: { include, exclude, match, fromIso, toIso, projectIds },
      });
    }

    const roleClause = onlyUser ? " AND role = 'user'" : "";

    function sessionsMatching(term) {
      const expr = ftsTerm(term);
      if (!expr) return null;
      const rows = db
        .prepare(`SELECT DISTINCT session_pk FROM messages_fts WHERE messages_fts MATCH ?${roleClause}`)
        .all(expr);
      return new Set(rows.map((r) => r.session_pk));
    }

    let matched;
    try {
      const includeSets = include.map(sessionsMatching).filter(Boolean);
      if (!includeSets.length) {
        matched = new Set();
      } else if (match === "any") {
        matched = new Set();
        for (const s of includeSets) for (const x of s) matched.add(x);
      } else {
        matched = includeSets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))));
      }
      for (const term of exclude) {
        const ex = sessionsMatching(term);
        if (ex) for (const x of ex) matched.delete(x);
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!matched.size) {
      return res.json({
        results: [], mode: groupBy, took_ms: Date.now() - t0,
        query: { include, exclude, match, fromIso, toIso, projectIds },
      });
    }

    const allowedIds = [...matched];
    const placeholders = allowedIds.map((_, i) => `@sp${i}`).join(",");
    const sParams = { ...params };
    allowedIds.forEach((id, i) => (sParams[`sp${i}`] = id));
    const extraFilters = sessionFilters.join(" AND ");
    const sWhere = extraFilters ? `AND ${extraFilters}` : "";

    const sessionRows = db
      .prepare(
        `SELECT s.id, s.session_id, s.file_path, s.cwd, s.git_branch, s.started_at, s.ended_at,
                s.message_count, s.user_message_count, s.is_subagent, s.is_backup,
                s.first_user_message,
                p.folder AS project_folder, p.id AS project_id
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.id IN (${placeholders}) ${sWhere}
         ORDER BY ended_at DESC NULLS LAST`
      )
      .all(sParams);
    const sessionMap = new Map(sessionRows.map((r) => [r.id, r]));
    if (!sessionMap.size) {
      return res.json({
        results: [], mode: groupBy, took_ms: Date.now() - t0,
        query: { include, exclude, match, fromIso, toIso, projectIds },
      });
    }

    const orExpr = include.map(ftsTerm).filter(Boolean).join(" OR ");
    const filteredIds = [...sessionMap.keys()];
    const fp = filteredIds.map((_, i) => `@fp${i}`).join(",");
    const sParams2 = { fts2: orExpr };
    filteredIds.forEach((id, i) => (sParams2[`fp${i}`] = id));

    const snippetLimit = Math.min(Math.max(limit * 20, 400), 4000);
    const snippetRows = db
      .prepare(
        `SELECT session_pk, role, timestamp, msg_index,
                snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
                bm25(messages_fts) AS rank
         FROM messages_fts
         WHERE messages_fts MATCH @fts2
           AND session_pk IN (${fp})
           ${onlyUser ? "AND role = 'user'" : ""}
         ORDER BY rank
         LIMIT ${snippetLimit}`
      )
      .all(sParams2);

    const groups = new Map();
    for (const h of snippetRows) {
      let g = groups.get(h.session_pk);
      if (!g) {
        const s = sessionMap.get(h.session_pk);
        if (!s) continue;
        g = { ...s, session_pk: s.id, rank: h.rank, hits: 0, snippets: [] };
        groups.set(h.session_pk, g);
      }
      g.hits++;
      if (g.snippets.length < 3) {
        g.snippets.push({ role: h.role, timestamp: h.timestamp, msg_index: h.msg_index, snippet: h.snippet });
      }
    }
    for (const s of sessionMap.values()) {
      if (!groups.has(s.id)) {
        groups.set(s.id, { ...s, session_pk: s.id, rank: 999, hits: 0, snippets: [] });
      }
    }

    if (groupBy === "message") {
      const out = [];
      for (const h of snippetRows) {
        const s = sessionMap.get(h.session_pk);
        if (!s) continue;
        out.push({ ...s, session_pk: s.id, ...h });
        if (out.length >= limit) break;
      }
      return res.json({
        results: out, mode: "message", took_ms: Date.now() - t0,
        query: { include, exclude, match, fromIso, toIso, projectIds },
      });
    }

    const results = [...groups.values()]
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .slice(0, limit);
    res.json({
      results, mode: "session", took_ms: Date.now() - t0,
      query: { include, exclude, match, fromIso, toIso, projectIds },
    });
  });

  app.get("/api/session/:pk", async (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    if (!pk) return res.status(400).json({ error: "bad id" });
    const sess = db
      .prepare(
        `SELECT s.*, p.folder AS project_folder
         FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`
      )
      .get(pk);
    if (!sess) return res.status(404).json({ error: "not found" });

    const limit = Math.min(parseInt(req.query.limit || "1500", 10), 5000);
    const offset = parseInt(req.query.offset || "0", 10);

    if (!fs.existsSync(sess.file_path)) {
      return res.status(410).json({ error: "file missing", session: sess });
    }

    const messages = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(sess.file_path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let i = 0;
    for await (const line of rl) {
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      if (i >= offset && messages.length < limit) {
        messages.push({
          idx: i, role: obj.type, timestamp: obj.timestamp || null,
          content: obj.message?.content ?? null, uuid: obj.uuid || null,
        });
      }
      i++;
      if (messages.length >= limit) break;
    }
    res.json({ session: sess, messages, total: i, has_more: messages.length >= limit });
  });

  const indexing = { running: false, progress: null, last_summary: null };

  app.post("/api/reindex", async (req, res) => {
    if (indexing.running) return res.status(409).json({ error: "already running", progress: indexing.progress });
    indexing.running = true;
    indexing.progress = { done: 0, total: 0 };
    res.json({ started: true });
    try {
      indexing.last_summary = await runIndex({
        force: !!req.body?.force,
        onProgress: (p) => { indexing.progress = p; },
      });
    } catch (err) {
      indexing.last_summary = { error: err.message };
    } finally {
      indexing.running = false;
    }
  });

  app.get("/api/reindex/status", (req, res) => {
    res.json({ running: indexing.running, progress: indexing.progress, last_summary: indexing.last_summary });
  });

  app._indexing = indexing;

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  /* ---- Edit / backup helpers ---- */

  function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }
  function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

  function backupRoot() { return path.join(getDataDir(), "backups"); }
  function sessionBackupDir(sessionId) { return path.join(backupRoot(), sessionId); }
  function fileBackupDir(sessionId) { return path.join(backupRoot(), "files", sessionId); }
  function externalDir(sessionId) { return path.join(backupRoot(), "external", sessionId); }

  function blockToText(block) {
    if (block == null) return "";
    if (typeof block === "string") return block;
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
    if (block.type === "tool_result") {
      const c = block.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.text || JSON.stringify(x))).join("\n");
    }
    try { return JSON.stringify(block, null, 2); } catch { return String(block); }
  }

  function blockToFullJson(block) {
    try { return JSON.stringify(block, null, 2); } catch { return String(block); }
  }

  function applyAction(block, action) {
    if (block == null) return block;
    if (typeof block === "string") {
      if (action.action === "blank" || action.action === "delete") return "";
      if (action.action === "edit") return String(action.new_text ?? "");
      return block;
    }
    const out = JSON.parse(JSON.stringify(block));
    switch (action.action) {
      case "blank":
        if (out.type === "text") out.text = "";
        else if (out.type === "thinking") out.thinking = "";
        else if (out.type === "tool_use") out.input = {};
        else if (out.type === "tool_result") out.content = "";
        break;
      case "edit":
        if (out.type === "text") out.text = String(action.new_text ?? "");
        else if (out.type === "thinking") out.thinking = String(action.new_text ?? "");
        else if (out.type === "tool_result") out.content = String(action.new_text ?? "");
        else if (out.type === "tool_use") {
          try { out.input = JSON.parse(action.new_text || "{}"); }
          catch { out.input = { _raw: String(action.new_text ?? "") }; }
        }
        break;
      case "external":
        // Caller writes the external file and passes the marker text via new_text
        if (out.type === "text") out.text = String(action.new_text ?? "");
        else if (out.type === "thinking") out.thinking = String(action.new_text ?? "");
        else if (out.type === "tool_result") out.content = String(action.new_text ?? "");
        else if (out.type === "tool_use") out.input = { _summary: String(action.new_text ?? "") };
        break;
    }
    return out;
  }

  /* ---- Block-level backup listing ---- */

  app.get("/api/session/:pk/backups", (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const rows = db
      .prepare(
        `SELECT id, msg_uuid, block_index, content_hash, file_path, action, block_type, bytes, created_at, deleted
         FROM block_backups WHERE session_pk = ? ORDER BY created_at DESC`
      )
      .all(pk);
    const fileRows = db
      .prepare(
        `SELECT id, file_path, backup_path, bytes, created_at, note
         FROM file_backups WHERE session_pk = ? ORDER BY created_at DESC`
      )
      .all(pk);
    res.json({ block_backups: rows, file_backups: fileRows });
  });

  app.get("/api/backup/:id/content", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare("SELECT file_path, block_type FROM block_backups WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: "not found" });
    try {
      const buf = fs.readFileSync(row.file_path, "utf8");
      res.json({ content: buf, block_type: row.block_type });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/backup/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = db.prepare("UPDATE block_backups SET deleted = 1 WHERE id = ?").run(id);
    res.json({ ok: true, soft_deleted: r.changes });
  });

  /* ---- Restore: bring back the original JSONL from the oldest file backup ---- */
  /* This is the emergency "undo everything" path — used when edits broke the
     session (e.g. API rejects empty text blocks). It:
       1. Finds the OLDEST file_backups row (= state before the first edit)
       2. Takes a fresh safety backup of the CURRENT (broken) state
       3. Copies the original over the current file
       4. Marks the session for re-index so FTS catches up                          */
  app.post("/api/session/:pk/restore-original", (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const sess = db.prepare("SELECT id, session_id, file_path FROM sessions WHERE id = ?").get(pk);
    if (!sess) return res.status(404).json({ error: "session not found" });
    if (!fs.existsSync(sess.file_path)) return res.status(410).json({ error: "session file missing" });

    const oldest = db
      .prepare(
        `SELECT id, backup_path, created_at, bytes FROM file_backups
         WHERE session_pk = ? AND note IS NOT 'auto: pre-restore safety'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(pk);
    if (!oldest) return res.status(404).json({ error: "no file backups recorded for this session" });
    if (!fs.existsSync(oldest.backup_path)) {
      return res.status(500).json({ error: "oldest backup missing on disk", backup_path: oldest.backup_path });
    }

    // Safety backup of the current (broken) state — keeps an escape hatch
    ensureDir(fileBackupDir(sess.session_id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = path.join(fileBackupDir(sess.session_id), `${stamp}-pre-restore.jsonl`);
    try { fs.copyFileSync(sess.file_path, safety); } catch (e) {
      return res.status(500).json({ error: "safety backup failed: " + e.message });
    }
    const safetyStat = fs.statSync(safety);
    db.prepare(
      `INSERT INTO file_backups (session_pk, file_path, backup_path, bytes, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pk, sess.file_path, safety, safetyStat.size, new Date().toISOString(), "auto: pre-restore safety");

    // Restore
    try { fs.copyFileSync(oldest.backup_path, sess.file_path); } catch (e) {
      return res.status(500).json({ error: "restore copy failed: " + e.message });
    }
    db.prepare("UPDATE sessions SET file_mtime = 0 WHERE id = ?").run(pk);

    res.json({
      ok: true,
      restored_from: oldest.backup_path,
      restored_from_created: oldest.created_at,
      restored_bytes: oldest.bytes,
      safety_backup: safety,
    });
  });

  /* List file-level backups for a session, newest first. */
  app.get("/api/session/:pk/file-backups", (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const rows = db
      .prepare(
        `SELECT id, backup_path, bytes, created_at, note FROM file_backups
         WHERE session_pk = ? ORDER BY created_at DESC`
      )
      .all(pk);
    res.json({ backups: rows });
  });

  /* Restore from a specific file backup (lets the user pick a known-good revision). */
  app.post("/api/session/:pk/restore-file-backup", (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const backupId = parseInt(req.body?.backup_id || "0", 10);
    if (!backupId) return res.status(400).json({ error: "backup_id required" });
    const sess = db.prepare("SELECT id, session_id, file_path FROM sessions WHERE id = ?").get(pk);
    if (!sess) return res.status(404).json({ error: "session not found" });
    const bk = db.prepare("SELECT * FROM file_backups WHERE id = ? AND session_pk = ?").get(backupId, pk);
    if (!bk) return res.status(404).json({ error: "backup not found for this session" });
    if (!fs.existsSync(bk.backup_path)) return res.status(500).json({ error: "backup file missing", path: bk.backup_path });

    ensureDir(fileBackupDir(sess.session_id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = path.join(fileBackupDir(sess.session_id), `${stamp}-pre-restore.jsonl`);
    try { fs.copyFileSync(sess.file_path, safety); } catch (e) {
      return res.status(500).json({ error: "safety backup failed: " + e.message });
    }
    const safetyStat = fs.statSync(safety);
    db.prepare(
      `INSERT INTO file_backups (session_pk, file_path, backup_path, bytes, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pk, sess.file_path, safety, safetyStat.size, new Date().toISOString(), `auto: pre-restore (backup ${backupId})`);

    try { fs.copyFileSync(bk.backup_path, sess.file_path); } catch (e) {
      return res.status(500).json({ error: "restore copy failed: " + e.message });
    }
    db.prepare("UPDATE sessions SET file_mtime = 0 WHERE id = ?").run(pk);
    res.json({ ok: true, restored_from: bk.backup_path, safety_backup: safety });
  });

  /* Restore a SINGLE block from a per-block backup. Always takes a file-level
     safety backup first so it can be undone via /restore-original.            */
  app.post("/api/backup/:id/restore", (req, res) => {
    const backupId = parseInt(req.params.id, 10);
    const b = db.prepare("SELECT * FROM block_backups WHERE id = ?").get(backupId);
    if (!b) return res.status(404).json({ error: "backup not found" });
    if (!fs.existsSync(b.file_path)) return res.status(500).json({ error: "backup file missing on disk", file_path: b.file_path });
    const sess = db.prepare("SELECT * FROM sessions WHERE id = ?").get(b.session_pk);
    if (!sess) return res.status(404).json({ error: "session not found" });
    if (!fs.existsSync(sess.file_path)) return res.status(410).json({ error: "session file missing" });

    // Read backup and strip the metadata header we wrote at save time.
    let backupText = fs.readFileSync(b.file_path, "utf8");
    backupText = backupText.replace(/^<!--[\s\S]*?-->\s*\n?/, "");

    // File-level safety backup before mutating
    ensureDir(fileBackupDir(sess.session_id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safety = path.join(fileBackupDir(sess.session_id), `${stamp}-pre-block-restore.jsonl`);
    fs.copyFileSync(sess.file_path, safety);
    const safetyStat = fs.statSync(safety);
    db.prepare(
      `INSERT INTO file_backups (session_pk, file_path, backup_path, bytes, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(b.session_pk, sess.file_path, safety, safetyStat.size, new Date().toISOString(), `auto: pre block restore ${backupId}`);

    // Find the message, restore the block in place
    const lines = fs.readFileSync(sess.file_path, "utf8").split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
      if (obj.uuid !== b.msg_uuid || !obj.message) continue;
      const content = obj.message.content;
      if (typeof content === "string") {
        if (b.block_index !== 0) continue;
        obj.message.content = backupText;
      } else if (Array.isArray(content)) {
        const cur = content[b.block_index];
        if (cur == null) continue;
        if (cur.type === "text") cur.text = backupText;
        else if (cur.type === "thinking") cur.thinking = backupText;
        else if (cur.type === "tool_result") cur.content = backupText;
        else if (cur.type === "tool_use") {
          // For tool_use the saved text was JSON of the block; parse and restore .input
          try { const parsed = JSON.parse(backupText); cur.input = parsed.input ?? {}; }
          catch { cur.input = { _raw: backupText }; }
        } else {
          // unknown — best effort: keep the block, attach text
          cur._restored_text = backupText;
        }
      }
      lines[i] = JSON.stringify(obj);
      found = true;
      break;
    }
    if (!found) return res.status(404).json({ error: "message uuid not found in current file" });

    const tmp = sess.file_path + ".tmp_restore";
    fs.writeFileSync(tmp, lines.join("\n"), "utf8");
    fs.renameSync(tmp, sess.file_path);
    db.prepare("UPDATE sessions SET file_mtime = 0 WHERE id = ?").run(b.session_pk);
    res.json({ ok: true, restored_chars: backupText.length, safety_backup: safety });
  });

  /* ---- Save: apply changes to a session, with per-block + file-level backups ---- */

  app.post("/api/session/:pk/save", async (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const changes = req.body?.changes;
    if (!Array.isArray(changes) || !changes.length) {
      return res.status(400).json({ error: "changes array required" });
    }
    const sess = db.prepare("SELECT id, session_id, file_path FROM sessions WHERE id = ?").get(pk);
    if (!sess) return res.status(404).json({ error: "session not found" });
    if (!fs.existsSync(sess.file_path)) return res.status(410).json({ error: "file missing" });

    // Index changes by msg_uuid for fast lookup
    const byUuid = new Map();
    for (const c of changes) {
      if (!c.msg_uuid || !Array.isArray(c.blocks)) continue;
      byUuid.set(c.msg_uuid, c.blocks);
    }

    // 1. File-level backup BEFORE any modification
    ensureDir(fileBackupDir(sess.session_id));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileBackup = path.join(fileBackupDir(sess.session_id), `${stamp}.jsonl`);
    try {
      fs.copyFileSync(sess.file_path, fileBackup);
    } catch (e) {
      return res.status(500).json({ error: "file backup failed: " + e.message });
    }
    const stat = fs.statSync(fileBackup);
    db.prepare(
      `INSERT INTO file_backups (session_pk, file_path, backup_path, bytes, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pk, sess.file_path, fileBackup, stat.size, new Date().toISOString(), req.body?.note || null);

    // 2. Walk lines, apply edits, save block backups, build new file
    const lines = fs.readFileSync(sess.file_path, "utf8").split(/\r?\n/);
    const out = [];
    let appliedCount = 0;
    const blockBackups = [];

    ensureDir(sessionBackupDir(sess.session_id));
    ensureDir(externalDir(sess.session_id));

    const insertBlockBackup = db.prepare(
      `INSERT INTO block_backups (session_pk, msg_uuid, block_index, content_hash, file_path, action, block_type, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { out.push(line); continue; }
      let obj;
      try { obj = JSON.parse(line); } catch { out.push(line); continue; }

      const blockChanges = byUuid.get(obj.uuid);
      if (!blockChanges || !obj.message) {
        out.push(line);
        continue;
      }

      let content = obj.message.content;
      const isString = typeof content === "string";

      // Sort changes: deletes last (so indices for other actions stay valid)
      const sorted = [...blockChanges].sort((a, b) => {
        const da = a.action === "delete" ? 1 : 0;
        const db_ = b.action === "delete" ? 1 : 0;
        if (da !== db_) return da - db_;
        return (a.index || 0) - (b.index || 0);
      });

      // Apply non-delete actions first
      for (const ch of sorted) {
        if (ch.action === "delete") continue;
        const idx = ch.index || 0;
        let originalBlock;
        if (isString) {
          if (idx !== 0) continue;
          originalBlock = content;
        } else if (Array.isArray(content)) {
          originalBlock = content[idx];
          if (originalBlock === undefined) continue;
        } else continue;

        const text = blockToText(originalBlock);
        const json = blockToFullJson(originalBlock);
        const hash = sha1(json);
        const backupFile = path.join(sessionBackupDir(sess.session_id), `${hash}.md`);

        // Write backup file (idempotent — same hash = same content = same file)
        if (!fs.existsSync(backupFile)) {
          const meta = [
            `<!-- ccs:backup`,
            `   session_id: ${sess.session_id}`,
            `   msg_uuid:   ${obj.uuid}`,
            `   block:      ${idx}`,
            `   type:       ${typeof originalBlock === "string" ? "string" : originalBlock?.type || "?"}`,
            `   action:     ${ch.action}`,
            `   created:    ${new Date().toISOString()}`,
            `-->`,
            ``,
            text,
          ].join("\n");
          fs.writeFileSync(backupFile, meta, "utf8");
        }

        const info = insertBlockBackup.run(
          pk, obj.uuid, idx, hash, backupFile, ch.action,
          typeof originalBlock === "string" ? "string" : originalBlock?.type || null,
          Buffer.byteLength(text, "utf8"),
          new Date().toISOString()
        );
        blockBackups.push({ id: info.lastInsertRowid, msg_uuid: obj.uuid, block_index: idx, hash, action: ch.action });

        // Handle "external" specially: write the full content out, build a marker
        if (ch.action === "external") {
          const summaryHead = Math.max(0, parseInt(ch.summary_head ?? 300, 10));
          const summaryTail = Math.max(0, parseInt(ch.summary_tail ?? 300, 10));
          const extFile = path.join(externalDir(sess.session_id), `${hash}.md`);
          if (!fs.existsSync(extFile)) fs.writeFileSync(extFile, text, "utf8");
          const head = text.slice(0, summaryHead);
          const tail = text.length > summaryHead + summaryTail ? text.slice(-summaryTail) : "";
          const marker = `${head}\n\n--- Full context available at: ${extFile} ---\n\n${tail}`;
          ch.new_text = marker;
        }

        // Apply the modification
        const newBlock = applyAction(originalBlock, ch);
        if (isString) {
          content = newBlock;
        } else {
          content[idx] = newBlock;
        }
      }

      // Apply deletes (highest index first to keep lower indices valid)
      const deletes = sorted.filter((c) => c.action === "delete").sort((a, b) => (b.index || 0) - (a.index || 0));
      if (deletes.length && Array.isArray(content)) {
        for (const ch of deletes) {
          const idx = ch.index || 0;
          const originalBlock = content[idx];
          if (originalBlock === undefined) continue;
          const text = blockToText(originalBlock);
          const json = blockToFullJson(originalBlock);
          const hash = sha1(json);
          const backupFile = path.join(sessionBackupDir(sess.session_id), `${hash}.md`);
          if (!fs.existsSync(backupFile)) {
            fs.writeFileSync(backupFile, `<!-- deleted block backup -->\n\n${text}`, "utf8");
          }
          const info = insertBlockBackup.run(
            pk, obj.uuid, idx, hash, backupFile, "delete",
            originalBlock?.type || null,
            Buffer.byteLength(text, "utf8"),
            new Date().toISOString()
          );
          blockBackups.push({ id: info.lastInsertRowid, msg_uuid: obj.uuid, block_index: idx, hash, action: "delete" });
          content.splice(idx, 1);
        }
      }

      obj.message.content = content;
      appliedCount++;
      out.push(JSON.stringify(obj));
    }

    if (!appliedCount) {
      return res.status(400).json({ error: "no matching messages for the given changes", file_backup: fileBackup });
    }

    // 3. Write the new file
    const tmp = sess.file_path + ".tmp_save";
    fs.writeFileSync(tmp, out.join("\n"), "utf8");
    fs.renameSync(tmp, sess.file_path);

    // 4. Mark file as needing re-index (mtime is now newer; indexer will pick it up
    //    naturally on the next run). Re-index this single file now in-process so FTS
    //    snippets reflect the edit.
    try {
      const { runIndex } = require("./indexer");
      // We don't want to run the full walk; just bump mtime so a future full
      // reindex catches it. Simplest: set file_mtime to 0 in db so next pass updates.
      db.prepare("UPDATE sessions SET file_mtime = 0 WHERE id = ?").run(pk);
    } catch {}

    res.json({
      ok: true,
      messages_changed: appliedCount,
      block_backups: blockBackups,
      file_backup: fileBackup,
    });
  });

  /* Reconstruct a real path from the encoded project folder name.
     `.claude/projects` uses `C--dev-AI-forms` for `C:\dev\AI\forms`. */
  function reconstructPathFromFolder(folder) {
    if (!folder || !/^[A-Za-z]--/.test(folder)) return null;
    return folder[0] + ":\\" + folder.slice(3).replaceAll("-", "\\");
  }

  /* Resolve the project working folder for a session: try the session's own cwd,
     then the project's cwd, then reconstruct from the folder name. Returns the
     first one that exists on disk (or the best guess if none exist). */
  function resolveProjectCwd(sessionPk) {
    const row = db
      .prepare(
        `SELECT s.session_id, s.cwd AS s_cwd, p.cwd AS p_cwd, p.folder AS folder
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`
      )
      .get(sessionPk);
    if (!row) return null;
    const reconstructed = reconstructPathFromFolder(row.folder);
    const candidates = [row.s_cwd, row.p_cwd, reconstructed].filter(Boolean);
    let resolved = null;
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { resolved = c; break; } } catch {}
    }
    return {
      session_id: row.session_id,
      session_cwd: row.s_cwd || null,
      project_cwd: row.p_cwd || null,
      reconstructed,
      resolved: resolved || row.s_cwd || row.p_cwd || reconstructed || null,
      exists: !!resolved,
    };
  }

  app.get("/api/session/:pk/path", (req, res) => {
    const pk = parseInt(req.params.pk, 10);
    const info = resolveProjectCwd(pk);
    if (!info) return res.status(404).json({ error: "session not found" });
    res.json(info);
  });

  /* ---- Run Claude in a new terminal window pointed at a session's cwd ---- */
  app.post("/api/run-claude", (req, res) => {
    const sessionPk = parseInt(req.body?.session_pk || "0", 10);
    if (!sessionPk) return res.status(400).json({ error: "session_pk required" });

    const info = resolveProjectCwd(sessionPk);
    if (!info) return res.status(404).json({ error: "session not found" });

    const sessionId = String(info.session_id || "");
    const cwd = info.resolved;
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ error: "session_id invalid (refusing to spawn)" });
    }
    if (!cwd) {
      return res.status(400).json({
        error: "no usable cwd for this session (tried session.cwd, project.cwd, folder reconstruction)",
        tried: info,
      });
    }
    if (!info.exists) {
      return res.status(400).json({
        error: `cwd not found on disk: ${cwd}`,
        tried: info,
      });
    }

    // Use `start "" /D <cwd>` to launch a new cmd window already chdir'd to the
    // project folder, then run `clauded --resume <hash>` there. This avoids the
    // && parsing problem (where && would otherwise run in the launching shell).
    const cwdEsc = cwd.replace(/"/g, '""');
    const cmdLine = `start "" /D "${cwdEsc}" cmd /k clauded --resume ${sessionId}`;

    try {
      const child = spawn(cmdLine, [], {
        shell: true,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      res.json({ ok: true, cwd, session_id: sessionId, cmd: `clauded --resume ${sessionId}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

/* ------------ start ------------ */

function start({ port = DEFAULT_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // First-time setup: if the db doesn't exist yet, do an initial index synchronously
    // so the UI has something to show. Subsequent reindexes happen via the button.
    const isFirstRun = !fs.existsSync(dbPath);
    if (isFirstRun) {
      console.log("first run — building initial index…");
      // require here to avoid circular load
      const { runIndex } = require("./indexer");
      // fire-and-await synchronously via deasync trick? simpler: do it async then resolve.
      runIndex({
        onProgress: (p) => process.stdout.write(`\r  indexing ${p.done}/${p.total}    `),
      }).then(() => {
        process.stdout.write("\n");
        _open(resolve, reject, dbPath, port);
      }).catch(reject);
      return;
    }
    _open(resolve, reject, dbPath, port);
  });
}

function _open(resolve, reject, dbPath, port) {
  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -64000");
    initSchema(db); // idempotent — picks up any new tables added since the db was created

    const app = buildApp(db);

    const server = app.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      console.log(`claude-contexts ready: http://127.0.0.1:${actual}`);
      console.log(`projects dir: ${PROJECTS_DIR}`);
      console.log(`db: ${getDbPath()}`);
      resolve({ port: actual, server, app, db });
    });
    server.on("error", reject);
  } catch (err) {
    reject(err);
  }
}

module.exports = { start, buildApp };

if (require.main === module) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
