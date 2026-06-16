import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const children = new Set<ChildProcess>();

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${value}"`);
  }

  return port;
}

function getLanUrls(port: number): string[] {
  const urls = new Set<string>();

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        entry.address !== "0.0.0.0" &&
        !entry.address.startsWith("169.254.")
      ) {
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }

  return [...urls];
}

function getPnpmInvocation(): {
  command: string;
  prefixArguments: string[];
} {
  const npmExecPath = process.env["npm_execpath"];

  if (npmExecPath && npmExecPath.toLowerCase().includes("pnpm")) {
    return {
      command: process.execPath,
      prefixArguments: [npmExecPath],
    };
  }

  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    prefixArguments: [],
  };
}

function startService(
  label: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = {},
): ChildProcess {
  const pnpm = getPnpmInvocation();
  const child = spawn(
    pnpm.command,
    [...pnpm.prefixArguments, ...arguments_],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...environment,
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: false,
    },
  );

  children.add(child);

  child.once("error", (error) => {
    console.error(`\n${label} failed to start:`, error);
  });

  child.once("exit", (code, signal) => {
    children.delete(child);

    if (!shuttingDown) {
      console.error(
        `\n${label} stopped unexpectedly` +
          ` (code: ${String(code)}, signal: ${String(signal)}).`,
      );
      void shutdown(code ?? 1);
    }
  });

  return child;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(
        new Error(
          `Port ${port} is already in use. Stop the existing service or set ` +
            `a different PORT value.`,
          { cause: error },
        ),
      );
    });

    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}

async function waitForApi(url: string, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await sleep(400);
  }

  throw new Error(`The API did not become ready at ${url}.`);
}

function openBrowser(url: string): void {
  let command: string;
  let arguments_: string[];

  if (process.platform === "win32") {
    command = "cmd";
    arguments_ = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    arguments_ = [url];
  } else {
    command = "xdg-open";
    arguments_ = [url];
  }

  const opener = spawn(command, arguments_, {
    detached: true,
    stdio: "ignore",
  });

  opener.once("error", () => {
    console.log(`Open this dashboard manually: ${url}`);
  });

  opener.unref();
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );

      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }

  await sleep(1_500);

  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group exited after SIGTERM.
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log("\nStopping Inventory Scanner…");
    await Promise.all([...children].map(terminateChild));
    process.exitCode = exitCode;
  })();

  return shutdownPromise;
}

async function main(): Promise<void> {
  const port = parsePort(process.env["PORT"], 5050);
  const localDashboardUrl = `http://localhost:${port}`;
  const healthUrl = `${localDashboardUrl}/api/healthz`;

  await assertPortAvailable(port);

  console.log("\nInventory Scanner launcher");
  console.log("──────────────────────────");
  console.log("Starting API server…");

  startService(
    "API server",
    ["--filter", "@workspace/api-server", "run", "dev"],
    {
      PORT: String(port),
      HOST: "0.0.0.0",
    },
  );

  await waitForApi(healthUrl, 30_000);

  console.log("Starting Expo scanner server…");
  startService(
    "Expo scanner server",
    ["--filter", "@workspace/scanner-app", "run", "dev"],
    {
      EXPO_NO_TELEMETRY: "1",
      EXPO_PUBLIC_API_PORT: String(port),
    },
  );

  const lanUrls = getLanUrls(port);

  console.log("\nReady");
  console.log(`Dashboard: ${localDashboardUrl}`);

  if (lanUrls.length > 0) {
    console.log("Scanner server URLs (normally detected automatically):");
    for (const url of lanUrls) {
      console.log(`  ${url}`);
    }
  } else {
    console.log("No LAN address was detected.");
    console.log("Check that this computer is connected to Wi-Fi or Ethernet.");
  }

  console.log("\nPress Ctrl+C to stop both servers.\n");
  openBrowser(localDashboardUrl);
}

process.once("SIGINT", () => {
  void shutdown(0);
});

process.once("SIGTERM", () => {
  void shutdown(0);
});

main().catch((error: unknown) => {
  console.error("\nLauncher failed:", error);
  void shutdown(1);
});
