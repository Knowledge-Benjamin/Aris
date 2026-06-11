import { Request, Response } from "express";
import { getDatabasePool } from "../db/db";
import { UserStore } from "../db/userStore";

const pool = getDatabasePool();
const userStore = new UserStore(pool);

export async function registerUser(req: Request, res: Response) {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required." });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const existingUser = await userStore.findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "A user with that email already exists." });
    }

    const user = await userStore.createUser(email, password);
    const token = await userStore.createSession(user.id);

    return res.json({ token, email: user.email, onboardingRequired: true });
  } catch (error) {
    console.error("registerUser error", error);
    return res.status(500).json({ error: "Unable to register user." });
  }
}

export async function loginUser(req: Request, res: Response) {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await userStore.verifyPassword(email, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = await userStore.createSession(user.id);
    return res.json({
      token,
      email: user.email,
      onboardingRequired: !Boolean(user.onboarding_complete),
    });
  } catch (error) {
    console.error("loginUser error", error);
    return res.status(500).json({ error: "Unable to log in." });
  }
}

export async function completeOnboarding(req: Request, res: Response) {
  try {
    const authReq = req as Request & { authUserId?: number };
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    await userStore.markOnboardingComplete(userId);
    return res.json({ success: true });
  } catch (error) {
    console.error("completeOnboarding error", error);
    return res.status(500).json({ error: "Unable to complete onboarding." });
  }
}
