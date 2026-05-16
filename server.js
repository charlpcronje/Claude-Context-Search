"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const Database = require("better-sqlite3");
const readline = require("readline");

const { runIndex, getDbPath, PROJECTS_DIR } = require("./indexer");

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
