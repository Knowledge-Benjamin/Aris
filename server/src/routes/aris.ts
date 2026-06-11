import { Router } from "express";
import { arisChat, arisVoice, arisWelcome } from "../controllers/arisController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.post("/chat", authenticate, arisChat);
router.post("/voice", authenticate, arisVoice);
router.post("/welcome", authenticate, arisWelcome);

export default router;
