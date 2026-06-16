import { Router, type IRouter } from "express";

import healthRouter from "./health";
import productsRouter from "./products";
import transactionsRouter from "./transactions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(productsRouter);
router.use(transactionsRouter);

export default router;
