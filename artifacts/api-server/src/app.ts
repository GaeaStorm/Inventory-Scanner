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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(dashboardRouter);
app.use("/api", apiRouter);

export default app;
