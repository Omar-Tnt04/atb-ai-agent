const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const internalServicesDir = path.join(rootDir, "internal-services-demo");
const aiServicePort = process.env.AI_SERVICE_PORT || "8000";
const verbose = String(process.env.DEV_VERBOSE || "").toLowerCase() === "true";
const devMode = String(process.env.DEV_MODE || "").toLowerCase().trim();
const isHostedBrowser = devMode === "hosted-browser";
const DEMO_CONSOLE = ["1", "true", "yes", "on"].includes(String(process.env.DEMO_CONSOLE || "").trim().toLowerCase());
const DEV_LAUNCHER_DEBUG = ["1", "true", "yes", "on"].includes(String(process.env.DEV_LAUNCHER_DEBUG || "").trim().toLowerCase());
const OUTPUT_BUFFER_LIMIT = 200;
// In DEMO_CONSOLE mode only forward clean [DEMO] step lines + essential markers.
// In debug mode forward all low-level markers so every routing/agent detail is visible.
const FORCE_FORWARD_PREFIXES = DEMO_CONSOLE
  ? ["[DEMO]", "[REQUEST_SUMMARY]", "[ANSWER_PROOF]"]
  : [
      "[BACKEND_DEBUG_BOOT]",
      "[BACKEND_CODE_VERSION]",
      "[REQUEST_SUMMARY]",
      "[WIDGET_REQUEST_ENTERED]",
      "[CHAT_REQUEST_ENTERED]",
      "[ANSWER_PROOF]",
      "[ROUTE_TRACE]",
      "[BROWSER_AGENT]",
      "[BROWSER_USE_AGENT]",
      "[DOM_AGENT]",
      "[DOM_AGENT_JOB]",
      "[INTENT_PARSER]",
      "[DOM_PLANNER]",
      "[DOM_EXECUTOR]",
      "[SITE_INDEX]",
      "[SITE_SEARCH]",
      "[DOM_FAST_PATH]",
      "[INTENT]",
      "[ROUTER_DECISION]",
      "[RUN_AGENT]",
      "[PYTHON_BIN_USED]",
      "[PYTHON_ARGS_USED]",
      "[PYTHON_ENV]",
      "[PYTHON_ENV_ERROR]",
      "[PYTHON_BIN_WARNING]",
      "[START_HANDLER_REACHED]",
      "[SUBPROCESS_STDERR]",
      "[DEV_LAUNCHER]",
    ];

const allServices = [
  {
    name: "api",
    url: "http://localhost:5000",
    script: path.join(__dirname, "backend.js"),
    readyPattern: /backend running on port 5000|running on port 5000/i,
  },
  {
    name: "ai",
    url: `http://localhost:${aiServicePort}`,
    script: path.join(__dirname, "ai.js"),
    readyPattern: /verified .+Python on port/i,
    startupFailureMessage:
      "AI service failed to start. Check ai-service-python dependencies or traceback above.",
  },
  {
    name: "web",
    url: "http://localhost:5173",
    script: path.join(__dirname, "web.js"),
    readyPattern: /local:|localhost:5173|127\.0\.0\.1:5173/i,
  },
  {
    name: "widget",
    url: "http://localhost:5174",
    script: path.join(__dirname, "widget.js"),
    readyPattern: /local:|localhost:5174|127\.0\.0\.1:5174/i,
    skipIfRunning: true,
  },
  {
    name: "pay",
    url: "http://localhost:7101",
    script: path.join(internalServicesDir, "payment-service", "server.js"),
    readyPattern: /running on port 7101/i,
  },
  {
    name: "doc",
    url: "http://localhost:7102",
    script: path.join(internalServicesDir, "document-service", "server.js"),
    readyPattern: /running on port 7102/i,
  },
  {
    name: "atb",
    url: "http://localhost:7106",
    script: path.join(internalServicesDir, "atb-service", "server.js"),
    readyPattern: /running on port 7106/i,
  },
  {
    name: "apt",
    url: "http://localhost:7104",
    script: path.join(internalServicesDir, "appointment-service", "server.js"),
    readyPattern: /running on port 7104/i,
  },
  {
    name: "acc",
    url: "http://localhost:7105",
    script: path.join(internalServicesDir, "account-service", "server.js"),
    readyPattern: /running on port 7105/i,
  },
];

// Hosted-browser mode: only backend + widget-agent. No AI service, web client, or demo services.
const services = isHostedBrowser
  ? allServices.filter((s) => s.name === "api" || s.name === "widget")
  : allServices;

const children = new Map();
let shuttingDown = false;
let readyBannerPrinted = false;
let activeAiModel = null;
let tunnelApiUrl = null;
let tunnelWidgetUrl = null;

{
  const SEP = "==================================================";
  console.log(SEP);
  if (isHostedBrowser) {
    console.log(" ATB AI Agent — Hosted Browser Demo");
  } else {
    console.log(" ATB AI Agent - Local MVP");
  }
  console.log(SEP);
  if (verbose) {
    console.log(" Verbose mode active.");
    console.log(SEP);
  }
  console.log(" Starting services...");
  console.log("");
}

function stripAnsi(value) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isSimulatedSms(line) {
  return line.includes("[SIMULATED SMS]");
}

function isNoisyLine(line) {
  const text = stripAnsi(line).trim();

  return (
    text === "" ||
    text.startsWith("> ") ||
    text.startsWith("npm notice") ||
    text.startsWith("npm info") ||
    text.startsWith("[nodemon]") ||
    text.includes("watching path(s)") ||
    text.includes("watching extensions") ||
    text.includes("to restart at any time") ||
    text.includes("starting `node") ||
    text.includes("VITE v") ||
    text.includes("Local:") ||
    text.includes("Network:") ||
    text.includes("use --host to expose") ||
    text.includes("Re-optimizing dependencies") ||
    text.includes("injected env")
  );
}

function isErrorLine(line) {
  const text = stripAnsi(line).toLowerCase();

  return (
    text.includes("error") ||
    text.includes("failed") ||
    text.includes("exception") ||
    text.includes("traceback") ||
    text.includes("eaddrinuse") ||
    text.includes("enoent") ||
    text.includes("syntaxerror") ||
    text.includes("typeerror") ||
    text.includes("referenceerror") ||
    text.includes("modulenotfounderror") ||
    text.includes("cannot find module") ||
    text.includes("address already in use")
  );
}

function captureAiModel(line) {
  const match = stripAnsi(line).match(/using Ollama model\s+([^\s]+)\s+at/i);
  if (match) {
    activeAiModel = match[1];
  }
}

function bufferOutput(state, service, line, streamName) {
  if (!line.trim()) {
    return;
  }

  state.outputBuffer.push({ serviceName: service.name, line, streamName });
  if (state.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
    state.outputBuffer.shift();
  }
}

function printBufferedOutput(state) {
  if (!state.outputBuffer.length) {
    return;
  }

  console.error(`[${state.serviceName}] recent output before failure:`);
  for (const item of state.outputBuffer) {
    const output = item.streamName === "stderr" ? process.stderr : process.stdout;
    output.write(`[${item.serviceName}] ${item.line}\n`);
  }
}

function startHostedTunnels() {
  const configPath = path.join(rootDir, "widget-injector-extension", "widget-config.js");
  const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  function spawnTunnel(label, port) {
    const child = spawn(
      `npx cloudflared tunnel --url http://localhost:${port}`,
      { shell: true, cwd: rootDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } },
    );

    const state = { child, serviceName: `tunnel:${label}`, ready: false, readyTimer: null, exited: false, healthProbeStarted: false, outputBuffer: [] };
    children.set(`tunnel:${label}`, state);

    function onData(chunk) {
      const m = URL_RE.exec(chunk.toString());
      if (!m || state.ready) return;
      state.ready = true;
      if (label === "api") tunnelApiUrl = m[0];
      else tunnelWidgetUrl = m[0];
      if (!DEMO_CONSOLE || DEV_LAUNCHER_DEBUG) {
        console.log(`[DEV_LAUNCHER] ${label} tunnel ready: ${m[0]}`);
      }
      if (tunnelApiUrl && tunnelWidgetUrl) {
        // Write .tunnel-urls.json so the backend can serve /dev/widget-config to the extension.
        const tunnelUrlsPath = path.join(rootDir, ".tunnel-urls.json");
        fs.writeFileSync(tunnelUrlsPath, JSON.stringify({ widgetUrl: tunnelWidgetUrl, apiUrl: tunnelApiUrl }), "utf8");
        // Also patch widget-config.js as a static fallback when the backend is unreachable.
        if (fs.existsSync(configPath)) {
          let raw = fs.readFileSync(configPath, "utf8");
          raw = raw.replace(/(widgetUrl:\s*)'[^']*'/, `$1'${tunnelWidgetUrl}'`);
          raw = raw.replace(/(apiUrl:\s*)'[^']*'/, `$1'${tunnelApiUrl}'`);
          fs.writeFileSync(configPath, raw, "utf8");
        }
        if (!DEMO_CONSOLE || DEV_LAUNCHER_DEBUG) {
          console.log("[DEV_LAUNCHER] tunnel URLs written");
        }
      }
      printReadyBanner().catch((err) => console.error(`[banner] ${err.message}`));
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => console.error(`[tunnel:${label}] ${err.message}`));
    child.on("exit", (code, signal) => {
      state.exited = true;
      children.delete(`tunnel:${label}`);
      if (!shuttingDown) {
        console.error(`[tunnel:${label}] exited unexpectedly${signal ? ` with ${signal}` : ` code ${code}`}`);
      }
    });
  }

  spawnTunnel("api", 5000);
  spawnTunnel("widget", 5174);
}

async function printReadyBanner() {
  if (readyBannerPrinted || shuttingDown) {
    return;
  }

  const allReady = services.every((service) => {
    const state = Array.from(children.values()).find(
      (item) => item.serviceName === service.name,
    );
    return state?.ready ?? false;
  });

  if (!allReady) {
    return;
  }

  // Hosted-browser mode also waits for both tunnel URLs before printing the banner.
  if (isHostedBrowser && (!tunnelApiUrl || !tunnelWidgetUrl)) {
    return;
  }

  // Set synchronously before any await to prevent duplicate banners
  readyBannerPrinted = true;

  if (isHostedBrowser) {
    const SEP = "==================================================";
    const row = (label, value) => `  ${label.padEnd(14)}: ${value}`;
    console.log("");
    console.log(SEP);
    console.log(" ATB AI Agent — Hosted Browser Demo Ready");
    console.log(SEP);
    console.log("");
    console.log("Local services");
    console.log(row("Backend API", "http://localhost:5000"));
    console.log(row("Widget", "http://localhost:5174"));
    console.log("");
    console.log("Public tunnels");
    console.log(row("API tunnel", tunnelApiUrl));
    console.log(row("Widget tunnel", tunnelWidgetUrl));
    console.log("");
    console.log("Demo");
    console.log("  Open hosted demo:");
    console.log("  http://localhost:5000/dev/open-hosted-demo");
    console.log("");
    console.log("Notes");
    console.log("  Use the Chrome window opened by the demo launcher.");
    console.log("  Do not use a normal Chrome window for browser actions.");
    console.log("");
    console.log(SEP);
    return;
  }

  const cdpConnected = await requestHealth("http://127.0.0.1:9222/json/version", 500);

  const SEP = "==================================================";
  const row = (label, value) => `  ${label.padEnd(17)}: ${value}`;
  console.log("");
  console.log(SEP);
  console.log(" ATB AI Banking Agent — All services ready");
  console.log(SEP);
  if (activeAiModel) {
    console.log(row("AI Model", activeAiModel));
    console.log("");
  }
  console.log("[APPLICATIONS]");
  console.log(row("Web App", "http://localhost:5173"));
  console.log(row("Demo Page", "http://localhost:5173/bank-widget-demo.html"));
  console.log(row("Widget", "http://localhost:5174"));
  console.log("");
  console.log("[CORE SERVICES]");
  console.log(row("Backend API", "http://localhost:5000/health"));
  console.log(row("AI Service", `http://localhost:${aiServicePort}/health`));
  console.log("");
  console.log("[INTERNAL DEMO SERVICES]");
  console.log(row("Payment", "http://localhost:7101/health"));
  console.log(row("Document", "http://localhost:7102/health"));
  console.log(row("ATB", "http://localhost:7106/health"));
  console.log(row("Appointment", "http://localhost:7104/health"));
  console.log(row("Account", "http://localhost:7105/health"));
  console.log("");
  console.log("[BROWSER CONTROL]");
  console.log(row("Mode", "CDP same-tab navigation (deterministic site index)"));
  console.log(row("CDP endpoint", "http://127.0.0.1:9222"));
  console.log(row("CDP status", cdpConnected ? "connected" : "NOT connected"));
  if (!cdpConnected) {
    console.log("");
    console.log("  !! Open the ATB Agent Chrome shortcut before using Act-mode widget control.");
    console.log("  !! Then type: https://atb.tn");
    console.log("  !! Run scripts\\create-chrome-shortcut.ps1 once to create the shortcut.");
  }
  console.log("");
  console.log(SEP);
}

function markReady(service, state) {
  if (state.ready || shuttingDown) {
    return;
  }

  state.ready = true;
  if (verbose) {
    console.log(`[${service.name}] ready: ${service.healthUrl || service.url}`);
  }
  printReadyBanner().catch((err) => {
    console.error(`[banner] ${err.message}`);
  });
}

function requestHealth(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(parsedUrl, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(service, state) {
  const startedAt = Date.now();
  const timeoutMs = service.healthTimeoutMs || 30000;

  while (!shuttingDown && !state.exited && Date.now() - startedAt < timeoutMs) {
    if (await requestHealth(service.healthUrl)) {
      markReady(service, state);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!shuttingDown && !state.ready && !state.exited) {
    console.error(`[${service.name}] ${service.startupFailureMessage || "Service failed to start."}`);
    printBufferedOutput(state);
    shutdown(1);
  }
}

function startHealthProbe(service, state) {
  if (!service.healthUrl || state.healthProbeStarted) {
    return;
  }

  state.healthProbeStarted = true;
  waitForHealth(service, state).catch((error) => {
    console.error(`[${service.name}] health check failed: ${error.message}`);
    shutdown(1);
  });
}

function handleLine(service, state, line, streamName) {
  const cleanLine = stripAnsi(line).trimEnd();
  captureAiModel(cleanLine);
  bufferOutput(state, service, cleanLine, streamName);

  const isAiStartup = cleanLine.startsWith("[ai:startup]");

  // Print [ai:startup] lines first so they appear before the ready banner
  if (isAiStartup) {
    console.log(cleanLine.slice("[ai:startup]".length));
  }

  if (service.readyPattern.test(cleanLine)) {
    if (service.healthUrl) {
      startHealthProbe(service, state);
    } else {
      markReady(service, state);
    }
  }

  if (isAiStartup) return;

  // In DEMO_CONSOLE mode, [DEMO] step lines are printed without any service prefix so they
  // look exactly like the clean output the user specified (timestamps + label: message).
  if (DEMO_CONSOLE && cleanLine.startsWith("[DEMO] ")) {
    console.log(cleanLine.slice("[DEMO] ".length));
    return;
  }

  if (FORCE_FORWARD_PREFIXES.some((prefix) => cleanLine.startsWith(prefix))) {
    console.log(`[${service.name}] ${cleanLine}`);
    return;
  }

  if (verbose && cleanLine.trim()) {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(`[${service.name}] ${cleanLine}\n`);
    return;
  }

  if (isSimulatedSms(cleanLine)) {
    console.log(cleanLine);
    return;
  }

  if (isErrorLine(cleanLine)) {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(`[${service.name}] ${cleanLine}\n`);
    return;
  }

  if (streamName === "stderr" && !isNoisyLine(cleanLine) && isErrorLine(cleanLine)) {
    process.stderr.write(`[${service.name}] ${cleanLine}\n`);
  }
}

function watchStream(service, state, stream, streamName) {
  let buffered = "";

  stream.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      handleLine(service, state, line, streamName);
    }
  });

  stream.on("end", () => {
    if (buffered) {
      handleLine(service, state, buffered, streamName);
    }
  });
}

function killProcessTree(child) {
  if (!child) return;
  if (child.killed) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  child.kill("SIGTERM");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const state of children.values()) {
    clearTimeout(state.readyTimer);
    killProcessTree(state.child);
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 300);
}

async function spawnAll() {
  for (const service of services) {
    if (service.skipIfRunning) {
      const alreadyUp = await requestHealth(service.url);
      if (alreadyUp) {
        const state = { child: null, serviceName: service.name, ready: true, readyTimer: null, exited: false, healthProbeStarted: false, outputBuffer: [] };
        children.set(service.name, state);
        if (verbose) console.log(`[${service.name}] already running at ${service.url} — skipping`);
        printReadyBanner();
        continue;
      }
    }

    const child = spawn(process.execPath, [service.script], {
      cwd: rootDir,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });

    const state = {
      child,
      serviceName: service.name,
      ready: false,
      readyTimer: null,
      exited: false,
      healthProbeStarted: false,
      outputBuffer: [],
    };

    children.set(child.pid, state);
    watchStream(service, state, child.stdout, "stdout");
    watchStream(service, state, child.stderr, "stderr");

    startHealthProbe(service, state);

    child.on("error", (error) => {
      console.error(`[${service.name}] ${error.message}`);
      if (service.startupFailureMessage) {
        console.error(`[${service.name}] ${service.startupFailureMessage}`);
      }
      shutdown(1);
    });

    child.on("exit", (code, signal) => {
      state.exited = true;
      children.delete(child.pid);
      clearTimeout(state.readyTimer);

      if (!shuttingDown) {
        console.error(`[${service.name}] exited${signal ? ` with ${signal}` : ` with code ${code}`}`);
        if (!state.ready && service.startupFailureMessage) {
          console.error(`[${service.name}] ${service.startupFailureMessage}`);
        }
        shutdown(code || 1);
      }
    });
  }
}

spawnAll();
if (isHostedBrowser) startHostedTunnels();

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
