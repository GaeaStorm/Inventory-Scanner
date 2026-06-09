import { Router, type Request, type Response } from "express";
import { products } from "../data/products";

const router = Router();

router.get("/products", (_req: Request, res: Response) => {
  res.json(products);
});

export default router;
