"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const Database = require("better-sqlite3");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

/* DB location: prefer ~/.claude-contexts/index.db so the dev process and the packaged exe
   share the same index. Override with CCS_DATA_DIR if you want. */
function getDataDir() {
  return process.env.CCS_DATA_DIR || path.join(os.homedir(), ".claude-contexts");
}
function getDbPath() {
  return path.join(getDataDir(), "index.db");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function openDb() {
  const DB_PATH = getDbPath();
  ensureDir(path.dirname(DB_PATH));
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000"); // 64MB
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT UNIQUE NOT NULL,
      cwd TEXT,
      first_seen TEXT,
      last_activity TEXT,
      message_count INTEGER DEFAULT 0,
      session_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_id INTEGER REFERENCES projects(id),
      file_path TEXT UNIQUE NOT NULL,
      file_mtime INTEGER,
      file_size INTEGER,
      message_count INTEGER DEFAULT 0,
      user_message_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      first_user_message TEXT,
      cwd TEXT,
      git_branch TEXT,
      started_at TEXT,
      ended_at TEXT,
      is_subagent INTEGER DEFAULT 0,
      is_backup INTEGER DEFAULT 0,
      indexed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      role UNINDEXED,
      session_pk UNINDEXED,
      timestamp UNINDEXED,
      msg_index UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 1'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    /* Per-block content backups. Created when a block is blanked, edited, sent to
       external, or deleted. The actual content lives at file_path on disk; rows
       can be soft-deleted (deleted=1) without removing the file. */
    CREATE TABLE IF NOT EXISTS block_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_pk INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      msg_uuid TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      file_path TEXT NOT NULL,
      action TEXT,
      block_type TEXT,
      bytes INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      deleted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_block_backups_loc
      ON block_backups(session_pk, msg_uuid, block_index);

    /* Whole-file backups taken before a save operation. */
    CREATE TABLE IF NOT EXISTS file_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_pk INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      file_path TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      bytes INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_file_backups_session ON file_backups(session_pk);
  `);
}

/* Extract a plain-text rendering of a message content (string or array of blocks). */
function renderContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const t = block.type;
    if (t === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (t === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    } else if (t === "tool_use") {
      // Tool name + a compact rendering of input
      const name = block.name || "tool";
      let inputStr = "";
      try {
        inputStr = JSON.stringify(block.input ?? {});
      } catch {
        inputStr = "";
      }
      parts.push(`[tool_use:${name}] ${inputStr}`);
    } else if (t === "tool_result") {
      const c = block.content;
      if (typeof c === "string") parts.push(`[tool_result] ${c}`);
      else if (Array.isArray(c)) parts.push(`[tool_result] ${renderContent(c)}`);
    } else if (t === "image") {
      parts.push("[image]");
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/* Walk projects dir, return all .jsonl files. */
function findJsonlFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

/* Derive the top-level project folder (under PROJECTS_DIR) for a file. */
function projectFolderFor(filePath) {
  const rel = path.relative(PROJECTS_DIR, filePath);
  const parts = rel.split(path.sep);
  return parts[0] || "(unknown)";
}

/* Heuristic for "is this a subagent transcript?" */
function isSubagentPath(filePath) {
  return /[\\/](subagents|agents)[\\/]/.test(filePath) ||
    /[\\/]agent-[A-Za-z0-9]+\.jsonl$/.test(filePath);
}

function isBackupPath(filePath) {
  return /[\\/]backups[\\/]/.test(filePath);
}

/* Parse one JSONL file and return { meta, messages }. */
async function parseJsonl(filePath) {
  const messages = [];
  let firstUserText = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let cwd = null;
  let gitBranch = null;
  let sessionId = null;
  let userCount = 0;
  let assistantCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let idx = 0;
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
    const ts = obj.timestamp;
    if (ts) {
      if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
      if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
    }

    const t = obj.type;
    if (t === "user" || t === "assistant") {
      const role = t;
      const text = renderContent(obj.message && obj.message.content);
      if (!text || !text.trim()) continue;
      if (role === "user") {
        userCount++;
        // Skip tool-result-only user messages for the "first prompt" preview
        const isToolResultOnly = Array.isArray(obj.message?.content) &&
          obj.message.content.every(b => b && (b.type === "tool_result" || b.type === "image"));
        if (!firstUserText && !isToolResultOnly) {
          firstUserText = text.slice(0, 600);
        }
      } else {
        assistantCount++;
      }
      messages.push({
        idx: idx++,
        role,
        timestamp: ts || null,
        content: text,
      });
    }
  }

  return {
    sessionId,
    cwd,
    gitBranch,
    firstUserText,
    firstTimestamp,
    lastTimestamp,
    userCount,
    assistantCount,
    messageCount: messages.length,
    messages,
  };
}

function getOrCreateProject(db, folder) {
  let row = db.prepare("SELECT id FROM projects WHERE folder = ?").get(folder);
  if (row) return row.id;
  const info = db
    .prepare("INSERT INTO projects (folder, first_seen) VALUES (?, ?)")
    .run(folder, new Date().toISOString());
  return info.lastInsertRowid;
}

function deleteSessionRows(db, sessionPk) {
  db.prepare("DELETE FROM messages_fts WHERE session_pk = ?").run(sessionPk);
}

async function indexFile(db, filePath, opts = {}) {
  const stat = fs.statSync(filePath);
  const mtime = stat.mtimeMs | 0;
  const size = stat.size;

  const existing = db
    .prepare("SELECT id, file_mtime, file_size FROM sessions WHERE file_path = ?")
    .get(filePath);

  if (
    existing &&
    !opts.force &&
    existing.file_mtime === mtime &&
    existing.file_size === size
  ) {
    return { status: "skip" };
  }

  const parsed = await parseJsonl(filePath);
  const folder = projectFolderFor(filePath);
  const projectId = getOrCreateProject(db, folder);
  const isSub = isSubagentPath(filePath) ? 1 : 0;
  const isBak = isBackupPath(filePath) ? 1 : 0;

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      session_id, project_id, file_path, file_mtime, file_size,
      message_count, user_message_count, assistant_message_count,
      first_user_message, cwd, git_branch, started_at, ended_at,
      is_subagent, is_backup, indexed_at
    ) VALUES (
      @session_id, @project_id, @file_path, @file_mtime, @file_size,
      @message_count, @user_message_count, @assistant_message_count,
      @first_user_message, @cwd, @git_branch, @started_at, @ended_at,
      @is_subagent, @is_backup, @indexed_at
    )
    ON CONFLICT(file_path) DO UPDATE SET
      session_id = excluded.session_id,
      project_id = excluded.project_id,
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size,
      message_count = excluded.message_count,
      user_message_count = excluded.user_message_count,
      assistant_message_count = excluded.assistant_message_count,
      first_user_message = excluded.first_user_message,
      cwd = excluded.cwd,
      git_branch = excluded.git_branch,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      is_subagent = excluded.is_subagent,
      is_backup = excluded.is_backup,
      indexed_at = excluded.indexed_at
  `);

  const insertMsg = db.prepare(`
    INSERT INTO messages_fts (content, role, session_pk, timestamp, msg_index)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    if (existing) deleteSessionRows(db, existing.id);
    insertSession.run({
      session_id: parsed.sessionId || path.basename(filePath, ".jsonl"),
      project_id: projectId,
      file_path: filePath,
      file_mtime: mtime,
      file_size: size,
      message_count: parsed.messageCount,
      user_message_count: parsed.userCount,
      assistant_message_count: parsed.assistantCount,
      first_user_message: parsed.firstUserText,
      cwd: parsed.cwd,
      git_branch: parsed.gitBranch,
      started_at: parsed.firstTimestamp,
      ended_at: parsed.lastTimestamp,
      is_subagent: isSub,
      is_backup: isBak,
      indexed_at: new Date().toISOString(),
    });
    const sessionPk = existing
      ? existing.id
      : db.prepare("SELECT id FROM sessions WHERE file_path = ?").get(filePath).id;

    for (const m of parsed.messages) {
      insertMsg.run(m.content, m.role, sessionPk, m.timestamp, m.idx);
    }
  });
  tx();

  return { status: existing ? "update" : "add", messages: parsed.messageCount };
}

function recomputeProjectStats(db) {
  db.exec(`
    UPDATE projects SET
      message_count = COALESCE((SELECT SUM(message_count) FROM sessions WHERE sessions.project_id = projects.id), 0),
      session_count = COALESCE((SELECT COUNT(*) FROM sessions WHERE sessions.project_id = projects.id), 0),
      last_activity = (SELECT MAX(ended_at) FROM sessions WHERE sessions.project_id = projects.id),
      cwd = COALESCE(
        (SELECT cwd FROM sessions WHERE sessions.project_id = projects.id AND cwd IS NOT NULL ORDER BY ended_at DESC LIMIT 1),
        projects.cwd
      )
  `);
}

async function runIndex(opts = {}) {
  const db = openDb();
  initSchema(db);

  const t0 = Date.now();
  const files = findJsonlFiles(PROJECTS_DIR);
  let added = 0, updated = 0, skipped = 0, errored = 0;

  // Drop sessions whose files no longer exist
  const presentSet = new Set(files);
  const existingRows = db.prepare("SELECT id, file_path FROM sessions").all();
  for (const r of existingRows) {
    if (!presentSet.has(r.file_path)) {
      db.prepare("DELETE FROM messages_fts WHERE session_pk = ?").run(r.id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(r.id);
    }
  }

  const onProgress = opts.onProgress || (() => {});
  let i = 0;
  for (const f of files) {
    i++;
    try {
      const r = await indexFile(db, f, { force: opts.force });
      if (r.status === "add") added++;
      else if (r.status === "update") updated++;
      else skipped++;
    } catch (err) {
      errored++;
      console.error("index error", f, err.message);
    }
    if (i % 25 === 0 || i === files.length) {
      onProgress({ done: i, total: files.length, added, updated, skipped, errored });
    }
  }

  recomputeProjectStats(db);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_at', ?)")
    .run(new Date().toISOString());

  const elapsed = Date.now() - t0;
  const summary = { files: files.length, added, updated, skipped, errored, elapsed_ms: elapsed };
  db.close();
  return summary;
}

module.exports = { runIndex, openDb, initSchema, PROJECTS_DIR, getDbPath, getDataDir };

if (require.main === module) {
  const force = process.argv.includes("--full");
  console.log("Indexing", PROJECTS_DIR, "→", getDbPath());
  runIndex({
    force,
    onProgress: (p) =>
      process.stdout.write(
        `\r${p.done}/${p.total}  +${p.added} ~${p.updated} =${p.skipped} !${p.errored}    `
      ),
  })
    .then((s) => {
      process.stdout.write("\n");
      console.log("Done:", s);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
