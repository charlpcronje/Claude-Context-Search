"use strict";

const fs = require("fs");
const readline = require("readline");

/* Quote a bare term for FTS5 MATCH. Supports trailing `*` for prefix queries. */
function ftsTerm(t) {
  const s = String(t).trim();
  if (!s) return "";
  const isPrefix = s.endsWith("*") && s.length > 1;
  const core = isPrefix ? s.slice(0, -1) : s;
  const quoted = `"${core.replace(/"/g, '""')}"`;
  return isPrefix ? `${quoted}*` : quoted;
}

/* Session-level boolean: each include term must match SOMEWHERE in the session;
   exclude terms remove sessions that contain them. */
function searchSessions(db, opts = {}) {
  const include = (opts.include || []).filter((t) => t && String(t).trim());
  const exclude = (opts.exclude || []).filter((t) => t && String(t).trim());
  const match = opts.match === "any" ? "any" : "all";
  const fromIso = opts.from || null;
  const toIso = opts.to || null;
  const projectIds = (opts.project_ids || []).filter(Number.isFinite);
  const projectFolders = opts.project_folders || [];
  const includeBackups = !!opts.include_backups;
  const includeSubagents = !!opts.include_subagents;
  const onlyUser = !!opts.only_user;
  const limit = Math.min(Math.max(parseInt(opts.limit ?? 30, 10) || 30, 1), 200);

  // Resolve project_folders → ids
  let allProjectIds = projectIds.slice();
  if (projectFolders.length) {
    const placeholders = projectFolders.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id FROM projects WHERE folder IN (${placeholders})`)
      .all(...projectFolders);
    for (const r of rows) allProjectIds.push(r.id);
  }

  const sessionFilters = [];
  const params = {};
  if (!includeBackups) sessionFilters.push("s.is_backup = 0");
  if (!includeSubagents) sessionFilters.push("s.is_subagent = 0");
  if (fromIso) {
    sessionFilters.push("(s.ended_at >= @fromIso OR s.started_at >= @fromIso)");
    params.fromIso = fromIso;
  }
  if (toIso) {
    sessionFilters.push("(s.started_at <= @toIso OR s.ended_at <= @toIso)");
    params.toIso = toIso;
  }
  if (allProjectIds.length) {
    sessionFilters.push(`s.project_id IN (${allProjectIds.map((_, i) => `@pi${i}`).join(",")})`);
    allProjectIds.forEach((id, i) => (params[`pi${i}`] = id));
  }

  const t0 = Date.now();
  const hasInclude = include.length > 0;

  if (!hasInclude) {
    // No FTS terms — just return sessions matching the filters
    const where = sessionFilters.length ? `WHERE ${sessionFilters.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT s.id AS session_pk, s.session_id, s.cwd, s.git_branch, s.started_at, s.ended_at,
                s.message_count, s.user_message_count, s.is_subagent, s.is_backup,
                s.first_user_message,
                p.folder AS project_folder, p.id AS project_id
         FROM sessions s JOIN projects p ON p.id = s.project_id
         ${where}
         ORDER BY s.ended_at DESC NULLS LAST
         LIMIT ${limit}`
      )
      .all(params);
    return { results: rows.map((r) => ({ ...r, hits: 0, rank: 0, snippets: [] })), took_ms: Date.now() - t0 };
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
  const includeSets = include.map(sessionsMatching).filter(Boolean);
  if (!includeSets.length) matched = new Set();
  else if (match === "any") {
    matched = new Set();
    for (const s of includeSets) for (const x of s) matched.add(x);
  } else {
    matched = includeSets.reduce((acc, s) => new Set([...acc].filter((x) => s.has(x))));
  }
  for (const term of exclude) {
    const ex = sessionsMatching(term);
    if (ex) for (const x of ex) matched.delete(x);
  }
  if (!matched.size) return { results: [], took_ms: Date.now() - t0 };

  // Apply session-level filters on top of FTS-matched ids
  const allowed = [...matched];
  const placeholders = allowed.map((_, i) => `@sp${i}`).join(",");
  const sParams = { ...params };
  allowed.forEach((id, i) => (sParams[`sp${i}`] = id));
  const extra = sessionFilters.join(" AND ");
  const sWhere = extra ? `AND ${extra}` : "";

  const sessionRows = db
    .prepare(
      `SELECT s.id AS session_pk, s.session_id, s.cwd, s.git_branch, s.started_at, s.ended_at,
              s.message_count, s.user_message_count, s.is_subagent, s.is_backup,
              s.first_user_message,
              p.folder AS project_folder, p.id AS project_id
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id IN (${placeholders}) ${sWhere}
       ORDER BY ended_at DESC NULLS LAST`
    )
    .all(sParams);
  const sessionMap = new Map(sessionRows.map((r) => [r.session_pk, r]));
  if (!sessionMap.size) return { results: [], took_ms: Date.now() - t0 };

  const orExpr = include.map(ftsTerm).filter(Boolean).join(" OR ");
  const filteredIds = [...sessionMap.keys()];
  const fp = filteredIds.map((_, i) => `@fp${i}`).join(",");
  const sParams2 = { fts2: orExpr };
  filteredIds.forEach((id, i) => (sParams2[`fp${i}`] = id));

  const snippetLimit = Math.min(Math.max(limit * 20, 200), 4000);
  const snippetRows = db
    .prepare(
      `SELECT session_pk, role, timestamp, msg_index,
              snippet(messages_fts, 0, '«', '»', '…', 18) AS snippet,
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
      g = { ...s, rank: h.rank, hits: 0, snippets: [] };
      groups.set(h.session_pk, g);
    }
    g.hits++;
    if (g.snippets.length < 3) {
      g.snippets.push({ role: h.role, timestamp: h.timestamp, msg_index: h.msg_index, snippet: h.snippet });
    }
  }
  const results = [...groups.values()]
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, limit);
  return { results, took_ms: Date.now() - t0 };
}

/* Flatten one message's content into plain text (good enough for LLM consumption). */
function renderMessageText(content, opts = {}) {
  const maxChars = opts.max_chars || 0;
  function clip(s) {
    if (!maxChars || s.length <= maxChars) return s;
    return s.slice(0, maxChars) + ` …[+${s.length - maxChars} chars]`;
  }
  if (content == null) return "";
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) {
    try { return clip(JSON.stringify(content)); } catch { return ""; }
  }
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(b.text || "");
    else if (b.type === "thinking") parts.push("[thinking] " + (b.thinking || ""));
    else if (b.type === "tool_use") {
      let inp = "";
      try { inp = JSON.stringify(b.input ?? {}); } catch {}
      parts.push(`[tool_use ${b.name || ""}${b.id ? " id=" + b.id : ""}] ${inp}`);
    } else if (b.type === "tool_result") {
      const c = b.content;
      const txt = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((x) => (typeof x === "string" ? x : (x.text || JSON.stringify(x)))).join("\n")
          : JSON.stringify(c || "");
      parts.push(`[tool_result${b.tool_use_id ? " ↳" + b.tool_use_id : ""}] ${txt}`);
    } else if (b.type === "image") parts.push("[image]");
    else if (b.text) parts.push(b.text);
  }
  return clip(parts.join("\n"));
}

/* Read messages from a session JSONL, paginated.
   Skips non-message events (permission-mode, file-history-snapshot, …). */
async function getSessionMessages(db, sessionPk, opts = {}) {
  const offset = Math.max(0, parseInt(opts.offset ?? 0, 10) || 0);
  const limit = Math.min(Math.max(parseInt(opts.limit ?? 10, 10) || 10, 1), 200);
  const roleFilter = opts.role_filter || "all"; // "user" | "assistant" | "all"
  const maxChars = parseInt(opts.max_chars_per_message ?? 800, 10) || 800;

  const sess = db
    .prepare(
      `SELECT s.id AS session_pk, s.session_id, s.cwd, s.git_branch, s.started_at, s.ended_at,
              s.message_count, s.user_message_count, s.assistant_message_count, s.file_path,
              p.folder AS project_folder
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`
    )
    .get(sessionPk);
  if (!sess) return { error: "session not found" };
  if (!fs.existsSync(sess.file_path)) return { error: "file missing", session: sess };

  const rl = readline.createInterface({
    input: fs.createReadStream(sess.file_path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const collected = [];
  let totalMessages = 0;
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (roleFilter !== "all" && obj.type !== roleFilter) {
      totalMessages++;
      continue;
    }
    const idx = totalMessages;
    if (idx >= offset && collected.length < limit) {
      const rendered = renderMessageText(obj.message?.content, { max_chars: maxChars });
      const fullLen = renderMessageText(obj.message?.content).length;
      collected.push({
        idx,
        role: obj.type,
        timestamp: obj.timestamp || null,
        uuid: obj.uuid || null,
        content: rendered,
        truncated: fullLen > rendered.length,
        full_chars: fullLen,
      });
    }
    totalMessages++;
    if (collected.length >= limit) {
      // Continue counting so we know total_messages / next_offset
    }
  }

  const consumedThrough = Math.min(offset + limit, totalMessages);
  const nextOffset = consumedThrough < totalMessages ? consumedThrough : null;

  // Strip file_path from session info to keep noise low for LLM
  delete sess.file_path;

  return {
    session: sess,
    messages: collected,
    total_messages: totalMessages,
    offset,
    next_offset: nextOffset,
  };
}

async function getSessionAround(db, sessionPk, msgIndex, opts = {}) {
  const before = Math.max(0, parseInt(opts.before ?? 3, 10) || 0);
  const after = Math.max(0, parseInt(opts.after ?? 7, 10) || 0);
  const offset = Math.max(0, msgIndex - before);
  const limit = before + after + 1;
  return getSessionMessages(db, sessionPk, {
    offset,
    limit,
    role_filter: opts.role_filter,
    max_chars_per_message: opts.max_chars_per_message,
  });
}

function listProjects(db, opts = {}) {
  const filter = (opts.filter || "").toLowerCase();
  const limit = Math.min(Math.max(parseInt(opts.limit ?? 200, 10) || 200, 1), 1000);
  const rows = db
    .prepare(
      `SELECT p.id, p.folder, p.cwd, p.last_activity,
              COUNT(s.id) AS session_count,
              COALESCE(SUM(s.message_count), 0) AS message_count,
              MAX(s.ended_at) AS last_activity_eff
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id AND s.is_backup = 0
       GROUP BY p.id
       HAVING session_count > 0
       ORDER BY last_activity_eff DESC NULLS LAST`
    )
    .all();
  const filtered = filter
    ? rows.filter((r) => (r.folder || "").toLowerCase().includes(filter) || (r.cwd || "").toLowerCase().includes(filter))
    : rows;
  return filtered.slice(0, limit);
}

module.exports = {
  ftsTerm,
  searchSessions,
  getSessionMessages,
  getSessionAround,
  listProjects,
  renderMessageText,
};
