import pino from "pino";

const usePrettyLogs =
  process.stdout.isTTY && process.env["LOG_FORMAT"] !== "json";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(usePrettyLogs
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }
    : {}),
});