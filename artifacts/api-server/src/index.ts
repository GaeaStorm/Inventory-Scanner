import { networkInterfaces } from "node:os";

import app from "./app";
import { logger } from "./lib/logger";

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

  urls.add(`http://localhost:${port}`);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.add(`http://${address.address}:${port}`);
      }
    }
  }

  return [...urls];
}

const port = parsePort(process.env["PORT"], 5050);
const host = process.env["HOST"]?.trim() || "0.0.0.0";

const server = app.listen(port, host, () => {
  logger.info(
    {
      host,
      port,
      urls: getLanUrls(port),
    },
    "Inventory server listening",
  );
});

server.on("error", (error) => {
  logger.error({ error }, "Inventory server failed");
  process.exitCode = 1;
});