import { Request, Response } from "express";
import { GemmaService } from "../services/gemmaService";
import { info, error } from "../utils/logger";

const gemmaService = new GemmaService();

// Simple in-memory queue for commands coming from the ambient audio
// In production, this would be in Redis or Postgres
const commandQueue: string[] = [];

export function enqueueCommand(req: Request, res: Response) {
  const { command } = req.body;
  commandQueue.push(command);
  info(`[Autonomy] Enqueued command: ${command}`);
  res.json({ success: true });
}

export function pollCommands(req: Request, res: Response) {
  if (commandQueue.length > 0) {
    const command = commandQueue.shift();
    res.json({ command });
  } else {
    res.json({ command: null });
  }
}

export async function evaluateScreen(req: Request, res: Response) {
  try {
    const { goal, uiTree, imageBase64, userId } = req.body;
    if (!goal || !uiTree) {
      return res.status(400).json({ error: "Missing goal or uiTree" });
    }

    info(`[Autonomy] Evaluating screen for goal: "${goal}"`);

    // Pull phone PIN from vault so Aris can unlock autonomously
    let phonePin: string | null = null;
    if (userId) {
      const { getSecretInternal } = await import("./vaultController");
      phonePin = await getSecretInternal(Number(userId), "phone_pin");
    }

    const resultStr = await gemmaService.inferNextUiAction(goal, uiTree, imageBase64, phonePin ?? undefined);
    
    try {
      const resultJson = JSON.parse(resultStr);
      res.json(resultJson);
    } catch (parseErr) {
      const match = resultStr.match(/\{.*\}/s);
      if (match) {
        res.json(JSON.parse(match[0]));
      } else {
        res.json({ action: "complete", reason: "failed_to_parse" });
      }
    }
  } catch (err) {
    error("[Autonomy] Error evaluating screen", err);
    res.status(500).json({ error: "Failed to evaluate screen" });
  }
}
