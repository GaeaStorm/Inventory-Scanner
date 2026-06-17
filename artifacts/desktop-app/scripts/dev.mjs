import { spawn } from "node:child_process";
import process from "node:process";

const isWindows = process.platform === "win32";
const pnpmCommand = isWindows ? "pnpm.cmd" : "pnpm";
const spawnOptions = {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  shell: isWindows,
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function waitForServer(url, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

await run(pnpmCommand, ["run", "build:electron"]);

const vite = spawn(
  pnpmCommand,
  ["exec", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  spawnOptions,
);

let electron;
const stop = () => {
  electron?.kill();
  vite.kill();
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await waitForServer("http://127.0.0.1:5173");

  electron = spawn(pnpmCommand, ["exec", "electron", "."], {
    ...spawnOptions,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
    },
  });

  const exitCode = await new Promise((resolve, reject) => {
    electron.once("error", reject);
    electron.once("exit", (code) => resolve(code ?? 0));
  });

  process.exitCode = exitCode;
} finally {
  stop();
}
