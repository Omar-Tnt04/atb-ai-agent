const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const aiServiceDir = path.join(rootDir, "ai-service-python");
const aiServicePort = process.env.AI_SERVICE_PORT || "8000";
const portNum = Number(aiServicePort);
const healthUrl = `http://127.0.0.1:${aiServicePort}/health`;
const verbose = String(process.env.DEV_VERBOSE || "").toLowerCase() === "true";

const candidates =
  process.platform === "win32"
    ? [
        path.join(aiServiceDir, ".venv", "Scripts", "python.exe"),
        path.join(aiServiceDir, "venv", "Scripts", "python.exe"),
      ]
    : [
        path.join(aiServiceDir, ".venv", "bin", "python"),
        path.join(aiServiceDir, "venv", "bin", "python"),
      ];

const pythonCommand = candidates.find((c) => fs.existsSync(c));

if (!pythonCommand) {
  console.error("[ai] Python virtual environment not found.");
  console.error("[ai] Please run:");
  console.error("[ai]   cd ai-service-python");
  console.error("[ai]   python -m venv .venv");
  console.error("[ai]   .\\.venv\\Scripts\\Activate.ps1");
  console.error("[ai]   python -m pip install -r requirements.txt");
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────

const _SFX = "[ai:startup]";
const slog = (s = "") => console.log(`${_SFX}${s}`);
const srow = (label, value) => slog(`  ${label.padEnd(17)}: ${value}`);
const vlog = (s = "") => { if (verbose) slog(s); };
const vrow = (label, value) => { if (verbose) srow(label, value); };

const ownSafeIds = new Set([process.pid]);
if (process.ppid) ownSafeIds.add(process.ppid);

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

function killPidTree(pid) {
  if (!pid || ownSafeIds.has(pid)) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 5000, encoding: "utf8",
      });
    } else {
      spawnSync("kill", ["-9", String(pid)], { timeout: 3000 });
    }
  } catch { /* ignore */ }
}

// Kill every process whose CommandLine contains both "uvicorn" and "app.main:app"
function killAllUvicornInstances() {
  if (process.platform !== "win32") return 0;
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
       `(Get-CimInstance Win32_Process | Where-Object { ` +
       `$_.CommandLine -ne $null -and ` +
       `$_.CommandLine -like '*uvicorn*' -and ` +
       `$_.CommandLine -like '*app.main:app*' ` +
       `}).ProcessId`],
      { timeout: 10000, encoding: "utf8" }
    );
    const pids = (r.stdout || "")
      .trim()
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0 && !ownSafeIds.has(n));
    for (const pid of pids) {
      vlog(`  Killing uvicorn PID ${pid}...`);
      killPidTree(pid);
    }
    return pids.length;
  } catch { return 0; }
}

// Poll until port is free or timeout (Windows only; POSIX: always returns true)
function isPortFree(port) {
  if (process.platform !== "win32") return true;
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command",
       `$null -eq (Get-NetTCPConnection -LocalPort ${port} -State Listen ` +
       `-ErrorAction SilentlyContinue | Select-Object -First 1)`],
      { timeout: 5000, encoding: "utf8" }
    );
    return (r.stdout || "").trim().toLowerCase() === "true";
  } catch { return true; }
}

function waitForPortFree(port, maxMs) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (isPortFree(port)) return true;
    sleepSync(600);
  }
  return isPortFree(port);
}

// Async HTTP health check — does not block event loop
function checkHealth() {
  return new Promise((resolve) => {
    try {
      const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}

// ── startup info (verbose only) ───────────────────────────────────────

vlog();
vlog("[AI SERVICE]");
vrow("Using Python", pythonCommand);
vrow("Working Directory", aiServiceDir);
vrow("Port", aiServicePort);
vlog();

// ── pre-start: kill stale uvicorn processes ───────────────────────────

const killedCount = killAllUvicornInstances();
if (killedCount > 0) {
  vlog("[PRE-START CLEANUP]");
  vlog(`  Killed ${killedCount} uvicorn process(es).`);
  vlog(`  Waiting for port ${aiServicePort} to free...`);
  if (!waitForPortFree(portNum, 8000)) {
    slog(`  ERROR: Port ${aiServicePort} still occupied. Kill manually and retry.`);
    process.exit(1);
  }
  vlog(`  Port ${aiServicePort} is free.`);
  vlog();
}

// ── spawn uvicorn — NO --reload (single stable process) ──────────────

const spawnEnv = { ...process.env, AI_SERVICE_PORT: aiServicePort };
if (process.platform === "win32") {
  // Ensure Tesseract-OCR is on PATH so pytesseract can find the binary
  const tesseractDir = "C:\\Program Files\\Tesseract-OCR";
  spawnEnv.PATH = [tesseractDir, process.env.PATH].filter(Boolean).join(";");
}

const child = spawn(
  pythonCommand,
  ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", aiServicePort],
  {
    cwd: aiServiceDir,
    stdio: "inherit",
    env: spawnEnv,
  }
);

// ── post-start verification via HTTP health poll ──────────────────────

let verifyDone = false;
const verifyStart = Date.now();
const VERIFY_MAX_MS = 40000;

(async function verifyAndSignalReady() {
  while (!verifyDone && Date.now() - verifyStart < VERIFY_MAX_MS) {
    if (await checkHealth()) {
      if (!verifyDone) {
        verifyDone = true;
        // Verbose: full diagnostic block
        vlog("[LISTENER VERIFIED]");
        vrow("  URL", healthUrl);
        vrow("  Status", "HTTP 200 — responding");
        vlog();
        // Always: compact summary (also triggers readyPattern in start.js)
        slog(`[ai] verified .venv Python on port ${aiServicePort}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!verifyDone) {
    verifyDone = true;
    slog(`  ERROR: No response on ${healthUrl} after ${VERIFY_MAX_MS / 1000}s.`);
    slog(`  Check that ${pythonCommand} can start uvicorn.`);
    slog();
    if (!child.killed) child.kill();
    process.exit(1);
  }
})();

// ── lifecycle ─────────────────────────────────────────────────────────

function stopChild() {
  verifyDone = true;
  if (!child.killed) child.kill();
}

process.on("SIGINT", stopChild);
process.on("SIGTERM", stopChild);

child.on("error", (error) => {
  verifyDone = true;
  console.error(error.message);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  verifyDone = true;
  if (signal) { process.exitCode = 1; return; }
  process.exitCode = code ?? 0;
});
