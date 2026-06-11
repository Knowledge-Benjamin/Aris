import { NextFunction, Request, Response } from "express";
import { getDatabasePool } from "../db/db";
import { UserStore } from "../db/userStore";

const pool = getDatabasePool();
const userStore = new UserStore(pool);

export interface AuthenticatedRequest extends Request {
  authUserId?: number;
  authUserEmail?: string;
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ error: "Authorization header missing or invalid." });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ error: "Authorization token is required." });
  }

  try {
    const user = await userStore.findUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: "Invalid or expired token." });
    }

    const authReq = req as AuthenticatedRequest;
    authReq.authUserId = user.id;
    authReq.authUserEmail = user.email;
    next();
  } catch (error) {
    console.error("authenticate error", error);
    return res.status(500).json({ error: "Authentication failure." });
  }
}
