const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const internalServicesDir = path.join(rootDir, "internal-services-demo");
const aiServicePort = process.env.AI_SERVICE_PORT || "8000";
const verbose = String(process.env.DEV_VERBOSE || "").toLowerCase() === "true";
const OUTPUT_BUFFER_LIMIT = 200;
const services = [
  {
    name: "api",
    url: "http://localhost:5000",
    script: path.join(__dirname, "backend.js"),
    readyPattern: /backend running on port 5000|running on port 5000/i,
  },
  {
    name: "ai",
    url: `http://localhost:${aiServicePort}`,
    healthUrl: `http://localhost:${aiServicePort}/health`,
    script: path.join(__dirname, "ai.js"),
    readyPattern: /application startup complete|uvicorn running|localhost:8000|127\.0\.0\.1:8000/i,
    healthTimeoutMs: 45000,
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

const children = new Map();
let shuttingDown = false;
let readyBannerPrinted = false;
let activeAiModel = null;

if (verbose) {
  console.log("========================================");
  console.log(" ATB AI Banking Agent - Local MVP");
  console.log("========================================");
  console.log(" Starting local services...");
  console.log(" Verbose logging is enabled.");
  console.log("========================================");
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

function printReadyBanner() {
  if (readyBannerPrinted || shuttingDown) {
    return;
  }

  const allReady = services.every((service) => {
    const state = Array.from(children.values()).find(
      (item) => item.serviceName === service.name,
    );
    return state?.ready;
  });

  if (!allReady) {
    return;
  }

  readyBannerPrinted = true;
  console.log("========================================");
  console.log(" ATB AI Banking Agent - Local MVP");
  console.log("========================================");
  if (activeAiModel) {
    console.log(`AI model: ${activeAiModel}`);
    console.log("");
  }
  console.log(" Open the apps:");
  console.log("[web]     http://localhost:5173");
  console.log("[demo]    http://localhost:5173/bank-widget-demo.html");
  console.log("[widget]  http://localhost:5174");
  console.log("");
  console.log(" Core services:");
  console.log(" Backend API: http://localhost:5000/health");
  console.log(` AI Service:  http://localhost:${aiServicePort}/health`);
  console.log("");
  console.log(" Internal demo services:");
  console.log(" Payment:     http://localhost:7101/health");
  console.log(" Document:    http://localhost:7102/health");
  console.log(" ATB:         http://localhost:7106/health");
  console.log(" Appointment: http://localhost:7104/health");
  console.log(" Account:     http://localhost:7105/health");
  console.log("========================================");
}

function markReady(service, state) {
  if (state.ready || shuttingDown) {
    return;
  }

  state.ready = true;
  if (verbose) {
    console.log(`[${service.name}] ready: ${service.healthUrl || service.url}`);
  }
  printReadyBanner();
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

  if (service.readyPattern.test(cleanLine)) {
    if (service.healthUrl) {
      startHealthProbe(service, state);
    } else {
      markReady(service, state);
    }
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

for (const service of services) {
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

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
