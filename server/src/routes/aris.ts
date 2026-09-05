import { Router } from "express";
import { arisChat, arisChatStream, arisVoice, arisWelcome, companionAudio } from "../controllers/arisController";
import { enqueueCommand, pollCommands, evaluateScreen } from "../controllers/autonomyController";
import { storeSecret, retrieveSecret } from "../controllers/vaultController";
import { enrollVoice, verifyVoice } from "../controllers/voiceController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.post("/chat", authenticate, arisChat);
router.post("/chat/stream", authenticate, arisChatStream);
router.post("/voice", authenticate, arisVoice);
router.post("/welcome", authenticate, arisWelcome);
router.post("/companion/audio-chunk", companionAudio);

router.post("/autonomy/queue", enqueueCommand);
router.get("/autonomy/poll", pollCommands);
router.post("/autonomy/actuate", evaluateScreen);

// Vault tools (internal – secured by server-side token in production)
router.post("/vault/store", storeSecret);
router.post("/vault/retrieve", retrieveSecret);

// Voice print – enrollment (call 3-5 times) and live verification
router.post("/voice/enroll", enrollVoice);
router.post("/voice/verify", verifyVoice);

export default router;
