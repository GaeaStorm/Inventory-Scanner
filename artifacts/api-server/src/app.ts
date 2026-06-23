import cors from "cors";
import express, { type Express } from "express";
import pinoHttp from "pino-http";

import { logger } from "./lib/logger";
import apiRouter from "./routes";
import dashboardRouter from "./routes/dashboard";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (request) =>
        request.url === "/api/dashboard" ||
        request.url === "/api/healthz",
    },
    serializers: {
      req(request) {
        return {
          id: request.id,
          method: request.method,
          url: request.url?.split("?")[0],
        };
      },
      res(response) {
        return {
          statusCode: response.statusCode,
        };
      },
    },
  }),
);

const allowedOrigins = new Set(
  String(process.env.ALLOWED_WEB_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("This browser origin is not allowed."));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(dashboardRouter);
app.use("/api", apiRouter);

export default app;
