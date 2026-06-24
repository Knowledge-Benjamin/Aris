import { Router } from "express";
import { arisChat, arisChatStream, arisVoice, arisWelcome } from "../controllers/arisController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.post("/chat", authenticate, arisChat);
router.post("/chat/stream", authenticate, arisChatStream);
router.post("/voice", authenticate, arisVoice);
router.post("/welcome", authenticate, arisWelcome);

export default router;
