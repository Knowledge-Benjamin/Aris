import { Router } from "express";
import { acknowledgeAppOutboxMessage, pollAppOutbox } from "../controllers/appOutboxController";
import { arisChat, arisChatStream, arisVoice, arisWelcome, companionAudio, updateCompanionLocation, downloadArisMedia, downloadArisMediaByDriveId } from "../controllers/arisController";
import { enqueueCommand, pollCommands, evaluateScreen } from "../controllers/autonomyController";
import { storeSecret, retrieveSecret } from "../controllers/vaultController";
import { enrollVoice, verifyVoice } from "../controllers/voiceController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.post("/chat", authenticate, arisChat);
router.post("/chat/stream", authenticate, arisChatStream);
router.get("/outbox", authenticate, pollAppOutbox);
router.post("/outbox/:messageId/ack", authenticate, acknowledgeAppOutboxMessage);
router.get("/media/drive/:driveFileId/download", authenticate, downloadArisMediaByDriveId);
router.get("/media/:mediaId/download", authenticate, downloadArisMedia);
router.post("/location", authenticate, updateCompanionLocation);
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
