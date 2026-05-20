const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");

const child = spawn("npm run dev", {
  cwd: path.join(rootDir, "backend-node"),
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    npm_config_loglevel: "silent",
  },
});

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
