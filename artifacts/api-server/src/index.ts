import app from "./app";
import { logger } from "./lib/logger";
import { getServiceUrls } from "./lib/network";
import {
  ensureWorkbookExists,
  getWorkbookPath,
} from "./lib/workbook";

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

const port = parsePort(process.env["PORT"], 5050);
const host = process.env["HOST"]?.trim() || "0.0.0.0";

try {
  const workbook = ensureWorkbookExists();
  logger.info(
    {
      path: workbook.path,
      created: workbook.created,
    },
    workbook.created
      ? "Excel workbook created"
      : "Excel workbook ready",
  );
} catch (error) {
  logger.warn(
    {
      err: error,
      path: getWorkbookPath(),
    },
    "Excel workbook could not be initialized; choose another location in the dashboard",
  );
}

const server = app.listen(port, host, () => {
  logger.info(
    {
      host,
      port,
      urls: getServiceUrls(port),
    },
    "Inventory server listening",
  );
});

server.on("error", (error) => {
  logger.error({ err: error }, "Inventory server failed");
  process.exitCode = 1;
});
