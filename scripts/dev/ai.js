const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const aiServiceDir = path.join(rootDir, "ai-service-python");
const venvPython =
  process.platform === "win32"
    ? path.join(aiServiceDir, "venv", "Scripts", "python.exe")
    : path.join(aiServiceDir, "venv", "bin", "python");
const pythonCommand = fs.existsSync(venvPython) ? venvPython : "python";
const aiServicePort = process.env.AI_SERVICE_PORT || "8000";

const child = spawn(
  pythonCommand,
  [
    "-m",
    "uvicorn",
    "app.main:app",
    "--host",
    "0.0.0.0",
    "--port",
    aiServicePort,
  ],
  {
    cwd: aiServiceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      AI_SERVICE_PORT: aiServicePort,
    },
  },
);

function stopChild() {
  if (!child.killed) {
    child.kill();
  }
}

process.on("SIGINT", stopChild);
process.on("SIGTERM", stopChild);

child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 0;
});
