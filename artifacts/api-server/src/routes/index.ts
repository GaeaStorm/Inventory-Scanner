import { Router, type IRouter } from "express";
import healthRouter from "./health";
import productsRouter from "./products";
import transactionsRouter from "./transactions";
import { EXCEL_PATH } from "./transactions";
import { logger } from "../lib/logger";

const router: IRouter = Router();

logger.info({ path: EXCEL_PATH }, "Excel file will be saved to");

router.use(healthRouter);
router.use(productsRouter);
router.use(transactionsRouter);

export default router;
