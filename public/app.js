"use strict";

/* ----------------- state ----------------- */

const state = {
  chips: [], // {term: string, mode: 'include' | 'exclude'}
  match: "all", // 'all' | 'any'
  fromDate: "",
  toDate: "",
  includeBackups: false,
  includeSubagents: false,
  onlyUser: false,
  projectIds: new Set(), // selected project IDs to restrict search
  projects: [],
  projectFilterText: "",
  lastQueryKey: "",
};

const searchCache = new Map(); // queryKey -> {ts, data}
const CACHE_TTL = 30_000;

/* ----------------- persistence ----------------- */

const STORAGE_KEY = "ccs:state:v1";

function snapshotState() {
  return {
    chips: state.chips,
    match: state.match,
    fromDate: state.fromDate,
    toDate: state.toDate,
    includeBackups: state.includeBackups,
    includeSubagents: state.includeSubagents,
    onlyUser: state.onlyUser,
    projectIds: [...state.projectIds],
    projectFilterText: state.projectFilterText,
    scroll: {
      results: $("#results")?.scrollTop || 0,
      projects: $("#projects")?.scrollTop || 0,
    },
    viewer: viewerStateForSave(),
  };
}

function viewerStateForSave() {
  if ($("#viewer").classList.contains("hidden")) return null;
  return {
    session_pk: window._viewerPk || null,
    title: $("#viewer-title")?.innerHTML || "",
    scroll: $("#viewer-body")?.scrollTop || 0,
  };
}

const saveStateNow = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotState()));
  } catch {}
};

const saveState = debounce(saveStateNow, 150);

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ----------------- utilities ----------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

function fmtBytes(n) {
  if (!n) return "0";
  const u = ["B", "K", "M", "G"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + u[i];
}

function fmtRelTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + "d ago";
  return d.toLocaleDateString();
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/* ----------------- chips ----------------- */

function renderChips() {
  const box = $("#chips");
  box.innerHTML = "";
  for (const c of state.chips) {
    const chip = el("span", { class: `chip ${c.mode === "exclude" ? "exclude" : ""}`, title: "click to toggle include/exclude" },
      el("span", { class: "chip-sign" }),
      c.term,
      el("span", {
        class: "chip-x", title: "remove", onclick: (e) => {
          e.stopPropagation();
          state.chips = state.chips.filter((x) => x !== c);
          renderChips(); triggerSearch(); saveState();
        }
      }, "×")
    );
    chip.addEventListener("click", () => {
      c.mode = c.mode === "include" ? "exclude" : "include";
      renderChips(); triggerSearch(); saveState();
    });
    box.append(chip);
  }
}

function addChip(term) {
  term = term.trim();
  if (!term) return;
  // Negative prefix support: "-foo" creates an exclude chip
  let mode = "include";
  if (term.startsWith("-")) { mode = "exclude"; term = term.slice(1); }
  if (!term) return;
  if (state.chips.some((c) => c.term === term)) return;
  state.chips.push({ term, mode });
  renderChips();
  triggerSearch();
  saveState();
}

/* ----------------- search ----------------- */

function buildQuery() {
  const include = state.chips.filter((c) => c.mode === "include").map((c) => c.term);
  const exclude = state.chips.filter((c) => c.mode === "exclude").map((c) => c.term);
  const params = new URLSearchParams();
  for (const t of include) params.append("include", t);
  for (const t of exclude) params.append("exclude", t);
  params.set("match", state.match);
  if (state.fromDate) params.set("from", state.fromDate + "T00:00:00.000Z");
  if (state.toDate) params.set("to", state.toDate + "T23:59:59.999Z");
  if (state.includeBackups) params.set("include_backups", "1");
  if (state.includeSubagents) params.set("include_subagents", "1");
  if (state.onlyUser) params.set("only_user", "1");
  for (const id of state.projectIds) params.append("project_ids", id);
  return params;
}

function queryKey(params) { return params.toString(); }

async function runSearch() {
  const params = buildQuery();
  const key = queryKey(params);
  state.lastQueryKey = key;

  // skip if no chips and no filters
  const hasAny = state.chips.length || state.fromDate || state.toDate || state.projectIds.size;
  if (!hasAny) {
    renderResults({ results: [], mode: "session", took_ms: 0 }, null);
    $("#results-meta").textContent = "type tags above to search";
    return;
  }

  // cache
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    renderResults(cached.data, params);
    $("#results-meta").innerHTML = `<span class="dim">${cached.data.results.length} results · ${cached.data.took_ms}ms (cached)</span>`;
    return;
  }

  $("#results-meta").innerHTML = `<span class="spinner"></span><span class="dim">searching…</span>`;
  try {
    const res = await fetch("/api/search?" + params.toString());
    const data = await res.json();
    if (state.lastQueryKey !== key) return; // stale
    searchCache.set(key, { ts: Date.now(), data });
    renderResults(data, params);
    $("#results-meta").innerHTML =
      `<span class="dim">${data.results.length} results · ${data.took_ms}ms</span>`;
  } catch (e) {
    $("#results-meta").textContent = "search failed: " + e.message;
  }
}

const triggerSearch = debounce(runSearch, 180);

function renderResults(data, params) {
  const box = $("#results");
  box.innerHTML = "";
  if (!data.results.length) {
    box.append(el("div", { class: "empty" }, "no matches"));
    return;
  }
  for (const r of data.results) {
    const head = el("div", { class: "result-head" },
      el("span", {
        class: "proj-badge",
        title: "filter to this project only",
        onclick: (e) => {
          e.stopPropagation();
          state.projectIds = new Set([r.project_id]);
          renderProjects();
          triggerSearch();
          saveState();
        }
      }, r.project_folder),
      el("span", { class: "result-title", title: r.first_user_message || "" }, r.first_user_message || "(no user prompt captured)"),
      el("span", { class: "result-meta" },
        r.hits ? el("span", { class: "hit-count" }, `${r.hits} hit${r.hits === 1 ? "" : "s"}`) : null,
        r.message_count ? el("span", {}, `${r.message_count} msg`) : null,
        el("span", { title: fmtDate(r.ended_at) }, fmtRelTime(r.ended_at))
      )
    );

    const snippets = el("div");
    const snList = r.snippets || (r.snippet ? [{ snippet: r.snippet, role: r.role, timestamp: r.timestamp }] : []);
    for (const s of snList) {
      snippets.append(el("div", { class: "snippet", html:
        `<span class="role">${s.role || ""}</span>${s.snippet}`
      }));
    }

    const card = el("div", { class: "result", onclick: () => openViewer(r) },
      head,
      snList.length ? snippets : null,
      r.is_subagent ? el("div", { class: "result-meta dim" }, "subagent transcript") : null,
      r.is_backup ? el("div", { class: "result-meta dim" }, "backup snapshot") : null,
    );
    box.append(card);
  }
}

/* ----------------- projects sidebar ----------------- */

async function loadProjects() {
  const r = await fetch("/api/projects?include_backups=" + (state.includeBackups ? "1" : "0"));
  const j = await r.json();
  state.projects = j.projects;
  renderProjects();
}

function renderProjects() {
  const box = $("#projects");
  box.innerHTML = "";
  const ft = state.projectFilterText.toLowerCase();
  const items = state.projects.filter((p) =>
    !ft || p.folder.toLowerCase().includes(ft) || (p.cwd || "").toLowerCase().includes(ft)
  );
  $("#proj-count").textContent = `${items.length}/${state.projects.length}`;
  for (const p of items) {
    const active = state.projectIds.has(p.id);
    box.append(el("div", {
      class: "proj-item" + (active ? " active" : ""),
      onclick: () => {
        if (state.projectIds.has(p.id)) state.projectIds.delete(p.id);
        else state.projectIds.add(p.id);
        renderProjects();
        triggerSearch();
        saveState();
      },
      title: p.cwd || p.folder,
    },
      el("div", { class: "proj-name" }, prettyFolder(p)),
      el("div", { class: "proj-meta" },
        el("span", {}, `${p.session_count} sess`),
        el("span", {}, `${p.message_count} msg`),
        el("span", {}, fmtRelTime(p.last_activity_eff || p.last_activity)),
      )
    ));
  }
}

function prettyFolder(p) {
  if (p.cwd) return p.cwd;
  // Folder names are paths with \ → -- and / → -
  // Try to reconstruct: "C--dev-AI-forms" -> "C:\dev\AI\forms"
  const f = p.folder;
  if (/^[A-Za-z]--/.test(f)) {
    return f[0] + ":\\" + f.slice(3).replaceAll("-", "\\");
  }
  return f;
}

/* ----------------- viewer ----------------- */

async function openViewer(r, restoreScroll) {
  const v = $("#viewer");
  v.classList.remove("hidden");
  const pk = r.session_pk || r.id;
  window._viewerPk = pk;
  $("#viewer-title").innerHTML = `<div class="v-folder">${escapeHtml(r.project_folder)}</div><div class="v-file">${escapeHtml(r.file_path || r.session_id || "")}</div>`;
  $("#viewer-body").innerHTML = `<div class="empty"><span class="spinner"></span>loading…</div>`;
  saveState();

  const res = await fetch(`/api/session/${pk}?limit=1500`);
  if (!res.ok) {
    $("#viewer-body").innerHTML = `<div class="empty">failed to load (${res.status})</div>`;
    return;
  }
  const data = await res.json();
  const includeTerms = state.chips.filter((c) => c.mode === "include").map((c) => c.term);
  renderViewer(data, includeTerms, r);

  // Attach scroll listener for state save (idempotent — replace each time).
  const body = $("#viewer-body");
  body.onscroll = debounce(saveStateNow, 250);

  if (typeof restoreScroll === "number") {
    setTimeout(() => {
      void body.scrollHeight;
      body.scrollTop = restoreScroll;
      // Save immediately so a concurrent save (from results scroll restore) doesn't
      // snapshot viewer.scroll=0 before this one applies.
      saveStateNow();
    }, 30);
  }
}

function closeViewer() {
  $("#viewer").classList.add("hidden");
  $("#viewer-body").innerHTML = "";
  window._viewerPk = null;
  saveState();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function highlightHtml(text, terms) {
  let h = escapeHtml(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(escapeRe(t), "gi");
    h = h.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return h;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function renderViewer(data, terms, summary) {
  const body = $("#viewer-body");
  body.innerHTML = "";
  body.append(el("div", { class: "result-meta dim", style: "margin-bottom:12px;" },
    `${data.session.message_count} messages · `,
    `started ${fmtDate(data.session.started_at)} · `,
    `ended ${fmtDate(data.session.ended_at)}`,
    data.session.cwd ? ` · ${data.session.cwd}` : ""
  ));

  for (const m of data.messages) {
    const head = el("div", { class: "msg-head" },
      el("span", { class: "msg-role" }, m.role),
      el("span", {}, fmtDate(m.timestamp)),
    );
    const blocks = renderBlocks(m.content, terms);
    body.append(el("div", { class: "msg " + m.role }, head, blocks));
  }
  if (data.has_more) {
    body.append(el("button", { class: "viewer-load-more ghost" }, "(showing first 1500 messages)"));
  }
}

function renderBlocks(content, terms) {
  const out = document.createDocumentFragment();
  if (content == null) return out;
  if (typeof content === "string") {
    out.append(el("div", { class: "msg-content", html: highlightHtml(content, terms) }));
    return out;
  }
  if (!Array.isArray(content)) {
    out.append(el("div", { class: "msg-content", html: highlightHtml(JSON.stringify(content, null, 2), terms) }));
    return out;
  }
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      out.append(el("div", { class: "msg-content", html: highlightHtml(b.text || "", terms) }));
    } else if (b.type === "thinking") {
      out.append(el("div", { class: "block-meta" }, "thinking"));
      out.append(el("div", { class: "msg-content", html: highlightHtml(b.thinking || "", terms) }));
    } else if (b.type === "tool_use") {
      const inputStr = JSON.stringify(b.input ?? {}, null, 2);
      out.append(el("div", { class: "block-meta" }, `tool_use · ${b.name || ""}`));
      out.append(el("div", { class: "tool-use", html: highlightHtml(inputStr, terms) }));
    } else if (b.type === "tool_result") {
      out.append(el("div", { class: "block-meta" }, "tool_result"));
      const txt = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c) => (typeof c === "string" ? c : (c.text || JSON.stringify(c)))).join("\n")
          : JSON.stringify(b.content || "");
      out.append(el("div", { class: "tool-result", html: highlightHtml(txt, terms) }));
    } else if (b.type === "image") {
      out.append(el("div", { class: "block-meta" }, "[image]"));
    } else if (b.text) {
      out.append(el("div", { class: "msg-content", html: highlightHtml(b.text, terms) }));
    } else {
      out.append(el("div", { class: "block-meta" }, b.type || "(unknown)"));
    }
  }
  return out;
}

/* ----------------- stats ----------------- */

async function refreshStats() {
  try {
    const r = await fetch("/api/stats");
    const j = await r.json();
    const pill = $("#stat-pill");
    if (j.indexing) {
      const p = j.indexing_progress || {};
      pill.innerHTML = `<span class="spinner"></span>indexing ${p.done || 0}/${p.total || "?"}`;
    } else {
      pill.textContent = `${j.projects} projects · ${j.sessions} sessions · ${j.messages.toLocaleString()} msgs`;
    }
  } catch {}
}

/* ----------------- wire-up ----------------- */

function attachHandlers() {
  const inp = $("#search-input");
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const txt = inp.value;
      // Allow comma/space separated multi-tag
      const parts = txt.split(/[,]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length) parts.forEach(addChip);
      else if (txt.trim()) addChip(txt.trim());
      inp.value = "";
    } else if (e.key === "Backspace" && !inp.value && state.chips.length) {
      state.chips.pop();
      renderChips();
      triggerSearch();
    }
  });

  $("#match-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    state.match = btn.dataset.mode;
    $$("#match-toggle button").forEach((b) => b.classList.toggle("active", b === btn));
    triggerSearch(); saveState();
  });

  $("#from-date").addEventListener("change", (e) => { state.fromDate = e.target.value; triggerSearch(); saveState(); });
  $("#to-date").addEventListener("change", (e) => { state.toDate = e.target.value; triggerSearch(); saveState(); });
  $("#inc-backups").addEventListener("change", (e) => {
    state.includeBackups = e.target.checked; loadProjects(); triggerSearch(); saveState();
  });
  $("#inc-subagents").addEventListener("change", (e) => { state.includeSubagents = e.target.checked; triggerSearch(); saveState(); });
  $("#only-user").addEventListener("change", (e) => { state.onlyUser = e.target.checked; triggerSearch(); saveState(); });

  $("#clear-btn").addEventListener("click", () => {
    state.chips = [];
    state.fromDate = state.toDate = "";
    state.projectIds.clear();
    state.includeBackups = state.includeSubagents = state.onlyUser = false;
    $("#from-date").value = ""; $("#to-date").value = "";
    $("#inc-backups").checked = false;
    $("#inc-subagents").checked = false;
    $("#only-user").checked = false;
    renderChips(); renderProjects(); triggerSearch(); saveState();
  });

  $("#reindex-btn").addEventListener("click", async () => {
    $("#reindex-btn").disabled = true;
    try {
      await fetch("/api/reindex", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      pollIndexing();
    } finally {
      $("#reindex-btn").disabled = false;
    }
  });

  $("#proj-filter").addEventListener("input", (e) => {
    state.projectFilterText = e.target.value;
    renderProjects();
    saveState();
  });

  // Scroll-position persistence (debounced).
  const scrollSave = debounce(saveStateNow, 250);
  $("#results").addEventListener("scroll", scrollSave, { passive: true });
  $("#projects").addEventListener("scroll", scrollSave, { passive: true });
  // viewer-body scroll is attached lazily inside renderViewer

  // Save final state on unload (covers window close).
  window.addEventListener("beforeunload", saveStateNow);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveStateNow(); });

  $$("[data-close]").forEach((b) => b.addEventListener("click", closeViewer));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeViewer();
  });

  $("#copy-path").addEventListener("click", async () => {
    const fileEl = $("#viewer-title .v-file");
    if (fileEl) {
      try { await navigator.clipboard.writeText(fileEl.textContent); } catch {}
    }
  });
}

async function pollIndexing() {
  const r = await fetch("/api/reindex/status");
  const j = await r.json();
  refreshStats();
  if (j.running) setTimeout(pollIndexing, 700);
  else {
    searchCache.clear();
    loadProjects();
    triggerSearch();
  }
}

/* ----------------- init ----------------- */

function applySaved(saved) {
  if (!saved) return null;
  state.chips = Array.isArray(saved.chips) ? saved.chips : [];
  state.match = saved.match === "any" ? "any" : "all";
  state.fromDate = saved.fromDate || "";
  state.toDate = saved.toDate || "";
  state.includeBackups = !!saved.includeBackups;
  state.includeSubagents = !!saved.includeSubagents;
  state.onlyUser = !!saved.onlyUser;
  state.projectIds = new Set(Array.isArray(saved.projectIds) ? saved.projectIds : []);
  state.projectFilterText = saved.projectFilterText || "";

  // Apply to DOM inputs
  $("#from-date").value = state.fromDate;
  $("#to-date").value = state.toDate;
  $("#inc-backups").checked = state.includeBackups;
  $("#inc-subagents").checked = state.includeSubagents;
  $("#only-user").checked = state.onlyUser;
  $("#proj-filter").value = state.projectFilterText;
  $$("#match-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.match));

  renderChips();
  return saved;
}

async function restoreScrollPositions(saved) {
  if (!saved) return;
  // Use setTimeout instead of rAF — rAF doesn't fire when tab is backgrounded/hidden,
  // which would leave the restore hung forever.
  await new Promise((r) => setTimeout(r, 30));

  const proj = $("#projects");
  const res = $("#results");
  if (saved.scroll?.projects != null && proj) {
    void proj.scrollHeight;
    proj.scrollTop = saved.scroll.projects;
  }
  if (saved.scroll?.results != null && res) {
    void res.scrollHeight;
    res.scrollTop = saved.scroll.results;
  }
}

async function restoreViewer(saved) {
  if (!saved?.viewer?.session_pk) return;
  // Synthesize a minimal "result" object for openViewer (it only needs ids + project name from title)
  const pk = saved.viewer.session_pk;
  await openViewer({ session_pk: pk, project_folder: "", file_path: "" }, saved.viewer.scroll);
  // openViewer rewrites the title; restore the saved one to avoid a flash of empty project name.
  if (saved.viewer.title) $("#viewer-title").innerHTML = saved.viewer.title;
}

async function init() {
  attachHandlers();
  const saved = applySaved(loadSavedState());

  refreshStats();
  setInterval(refreshStats, 5000);

  const projectsPromise = loadProjects();
  const hasAny = state.chips.length || state.fromDate || state.toDate || state.projectIds.size;
  if (hasAny) await runSearch();
  await projectsPromise;

  await restoreScrollPositions(saved);
  await restoreViewer(saved);
}

init();
