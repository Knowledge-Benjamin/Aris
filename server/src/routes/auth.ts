import { Router } from "express";
import { loginUser, registerUser, completeOnboarding } from "../controllers/authController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/onboarding/complete", authenticate, completeOnboarding);

export default router;
