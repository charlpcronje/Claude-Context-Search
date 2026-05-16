#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const http = require("http");

const { start } = require("../server");

const PORT = parseInt(process.env.CCS_PORT || "5179", 10);

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft\\Edge\\Application\\msedge.exe"),
].filter(Boolean);

function findEdge() {
  for (const c of EDGE_CANDIDATES) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(true);
      else resolve(false);
    });
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

function pingHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      if (res.statusCode === 200) {
        res.resume();
        resolve(true);
      } else { res.resume(); resolve(false); }
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function spawnEdge(edgePath, url) {
  const userData = path.join(os.homedir(), ".claude-contexts", "edge-app-data");
  fs.mkdirSync(userData, { recursive: true });
  const args = [
    `--app=${url}`,
    `--user-data-dir=${userData}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,860",
  ];
  const child = spawn(edgePath, args, {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  return child;
}

async function main() {
  const url = `http://127.0.0.1:${PORT}`;

  // Single-instance: if port is busy AND it's already our server, just open Edge to it.
  const busy = await portInUse(PORT);
  if (busy) {
    const ours = await pingHealth(PORT);
    if (ours) {
      const edge = findEdge();
      if (edge) {
        const child = spawnEdge(edge, url);
        child.on("exit", () => process.exit(0));
      } else {
        console.log(`already running: ${url}`);
        process.exit(0);
      }
      return;
    }
    // Port busy but not us — try a different port.
    let alt = PORT + 1;
    while (alt < PORT + 50 && (await portInUse(alt))) alt++;
    return startAndOpen(alt);
  }

  return startAndOpen(PORT);
}

async function startAndOpen(port) {
  const url = `http://127.0.0.1:${port}`;
  await start({ port });

  const edge = findEdge();
  if (!edge) {
    console.log(`Edge not found — open ${url} in your browser`);
    return; // keep server running
  }
  const child = spawnEdge(edge, url);
  child.on("exit", () => {
    // When the app window closes, exit the launcher (which kills the server).
    process.exit(0);
  });
  // Forward SIGINT to ourselves so Ctrl-C in the console also closes the app.
  process.on("SIGINT", () => { try { child.kill(); } catch {}; process.exit(0); });
  process.on("SIGTERM", () => { try { child.kill(); } catch {}; process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
