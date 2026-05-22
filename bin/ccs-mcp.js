#!/usr/bin/env node
"use strict";

/* Claude Code Contexts — MCP stdio server.

   Lets another Claude session search across the user's full conversation
   history and read sessions back in small, paginated chunks so it can
   discover what it needs without burning context.

   Protocol: JSON-RPC 2.0 over stdio (MCP). Implemented directly without the
   SDK so we can ship in the same `ccs.exe` pkg bundle.

   Logging goes to stderr only — stdout is reserved for JSON-RPC frames. */

const readline = require("readline");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const { getDbPath, getDataDir, initSchema } = require("../indexer");
const {
  searchSessions,
  getSessionMessages,
  getSessionAround,
  listProjects,
} = require("../lib/search");

const SERVER_INFO = { name: "claude-contexts", version: "0.2.0" };
const PROTOCOL_VERSION = "2024-11-05";

function log(...a) {
  process.stderr.write(
    a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ") + "\n"
  );
}

/* ---- DB ---- */
const dbPath = getDbPath();
if (!fs.existsSync(dbPath)) {
  log(`No index found at ${dbPath}. Run \`ccs\` once (or \`node indexer.js\`) to build it first.`);
  process.exit(2);
}
const db = new Database(dbPath, { readonly: false }); // we don't write but block_backups/file_backups may be referenced
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
initSchema(db);

/* ---- Tools ---- */

const tools = [
  {
    name: "search_contexts",
    description:
      "Search the user's full Claude Code conversation history (indexed under ~/.claude/projects) " +
      "by free-text terms. Returns ranked sessions with short snippets and msg_index pointers so you can drill in. " +
      "AND/OR boolean across terms (session-level: each include term must appear SOMEWHERE in the session). " +
      "Use this first to locate relevant sessions, then `read_session` or `read_around` to inspect content.",
    inputSchema: {
      type: "object",
      properties: {
        include: {
          type: "array",
          items: { type: "string" },
          description: "Terms that must appear in matching sessions (session-level, order-independent).",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "Sessions containing ANY of these terms are dropped.",
        },
        match: {
          type: "string",
          enum: ["all", "any"],
          description: "How to combine include terms. Default 'all'.",
        },
        project_folders: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to these projects by folder name (use `list_projects` first).",
        },
        from: { type: "string", description: "ISO date — only sessions touching this range." },
        to: { type: "string", description: "ISO date." },
        only_user: { type: "boolean", description: "Restrict to user messages only." },
        include_subagents: { type: "boolean", description: "Include subagent transcripts (default false)." },
        include_backups: { type: "boolean", description: "Include backup snapshots (default false)." },
        limit: { type: "number", description: "Max sessions to return (default 20, max 100)." },
      },
      required: ["include"],
    },
  },
  {
    name: "list_projects",
    description:
      "List indexed projects (top-level folders inside ~/.claude/projects). Useful for picking a project_folders filter for search_contexts.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Substring filter on folder/cwd." },
        limit: { type: "number", description: "Max projects (default 100)." },
      },
    },
  },
  {
    name: "read_session",
    description:
      "Read messages from a session in small chunks. Returns up to `limit` messages starting at `offset`. " +
      "Each message includes its `idx` (use it for read_around). Long messages are truncated to `max_chars_per_message`. " +
      "Use this to scan a session linearly without loading the entire transcript.",
    inputSchema: {
      type: "object",
      properties: {
        session_pk: { type: "number", description: "Session primary key from search_contexts." },
        offset: { type: "number", description: "Message index to start at (default 0)." },
        limit: { type: "number", description: "Messages per chunk (default 10, max 200)." },
        role_filter: {
          type: "string",
          enum: ["user", "assistant", "all"],
          description: "Filter by role (default 'all').",
        },
        max_chars_per_message: {
          type: "number",
          description: "Truncate each message to this many chars (default 800; pass 0 for none).",
        },
      },
      required: ["session_pk"],
    },
  },
  {
    name: "read_around",
    description:
      "Read messages around a specific msg_index in a session (great for expanding a snippet from search_contexts). " +
      "Returns `before` messages before and `after` messages after the target.",
    inputSchema: {
      type: "object",
      properties: {
        session_pk: { type: "number" },
        msg_index: { type: "number", description: "Center index (from a search hit's snippets[].msg_index)." },
        before: { type: "number", description: "Default 3." },
        after: { type: "number", description: "Default 7." },
        role_filter: { type: "string", enum: ["user", "assistant", "all"] },
        max_chars_per_message: { type: "number", description: "Default 800." },
      },
      required: ["session_pk", "msg_index"],
    },
  },
  {
    name: "get_session_info",
    description:
      "Metadata about a session: project, cwd, started/ended times, message counts. No content.",
    inputSchema: {
      type: "object",
      properties: { session_pk: { type: "number" } },
      required: ["session_pk"],
    },
  },
];

/* ---- Tool implementations ---- */

async function toolSearchContexts(args) {
  const result = searchSessions(db, args || {});
  const compact = {
    took_ms: result.took_ms,
    count: result.results.length,
    results: result.results.map((r) => ({
      session_pk: r.session_pk,
      session_id: r.session_id,
      project_folder: r.project_folder,
      cwd: r.cwd,
      started_at: r.started_at,
      ended_at: r.ended_at,
      message_count: r.message_count,
      hits: r.hits,
      first_user_message: (r.first_user_message || "").slice(0, 240),
      snippets: r.snippets,
    })),
  };
  return jsonText(compact);
}

async function toolListProjects(args) {
  const rows = listProjects(db, args || {});
  return jsonText({
    count: rows.length,
    projects: rows.map((r) => ({
      id: r.id,
      folder: r.folder,
      cwd: r.cwd,
      session_count: r.session_count,
      message_count: r.message_count,
      last_activity: r.last_activity_eff || r.last_activity,
    })),
  });
}

async function toolReadSession(args) {
  if (!args?.session_pk) return jsonText({ error: "session_pk required" });
  const result = await getSessionMessages(db, parseInt(args.session_pk, 10), args);
  return jsonText(result);
}

async function toolReadAround(args) {
  if (!args?.session_pk || args?.msg_index == null) {
    return jsonText({ error: "session_pk and msg_index required" });
  }
  const result = await getSessionAround(
    db,
    parseInt(args.session_pk, 10),
    parseInt(args.msg_index, 10),
    args
  );
  return jsonText(result);
}

async function toolGetSessionInfo(args) {
  if (!args?.session_pk) return jsonText({ error: "session_pk required" });
  const row = db
    .prepare(
      `SELECT s.id AS session_pk, s.session_id, s.cwd, s.git_branch, s.started_at, s.ended_at,
              s.message_count, s.user_message_count, s.assistant_message_count,
              s.is_subagent, s.is_backup, s.first_user_message,
              p.folder AS project_folder, p.cwd AS project_cwd
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`
    )
    .get(parseInt(args.session_pk, 10));
  if (!row) return jsonText({ error: "not found" });
  return jsonText(row);
}

const dispatch = {
  search_contexts: toolSearchContexts,
  list_projects: toolListProjects,
  read_session: toolReadSession,
  read_around: toolReadAround,
  get_session_info: toolGetSessionInfo,
};

function jsonText(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

/* ---- JSON-RPC plumbing ---- */

async function handleRequest(req) {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case "notifications/initialized":
      return null; // notifications never reply
    case "tools/list":
      return { tools };
    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments || {};
      const fn = dispatch[name];
      if (!fn) {
        return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
      }
      try {
        return await fn(args);
      } catch (err) {
        log("tool error", name, err && err.stack);
        return {
          isError: true,
          content: [{ type: "text", text: `tool ${name} failed: ${err.message}` }],
        };
      }
    }
    case "ping":
      return {};
    default:
      throw { code: -32601, message: "method not found: " + req.method };
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line || !line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch (err) { log("bad json:", line.slice(0, 200)); return; }
  if (req.method && req.id == null) {
    // notification — fire and forget
    try { await handleRequest(req); } catch (err) { log("notif error:", err.message); }
    return;
  }
  try {
    const result = await handleRequest(req);
    if (result === null) return; // notification-style with id (shouldn't happen)
    send({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: err.code || -32000, message: err.message || String(err) },
    });
  }
});

rl.on("close", () => {
  try { db.close(); } catch {}
  process.exit(0);
});

log(`ccs-mcp ready (db: ${dbPath})`);
