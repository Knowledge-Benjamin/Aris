import { Router } from "express";
import { summarizeWhatsappMessages } from "../controllers/whatsappController";

const router = Router();
router.get("/summary", summarizeWhatsappMessages);

export default router;
