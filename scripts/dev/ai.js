const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const pythonCommand =
  process.platform === "win32"
    ? path.join(rootDir, "ai-service-python", "venv", "Scripts", "python.exe")
    : path.join(rootDir, "ai-service-python", "venv", "bin", "python");

const child = spawn(
  pythonCommand,
  [
    "-m",
    "uvicorn",
    "app.main:app",
    "--port",
    "8000",
    "--log-level",
    "warning",
  ],
  {
    cwd: path.join(rootDir, "ai-service-python"),
    stdio: "inherit",
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
