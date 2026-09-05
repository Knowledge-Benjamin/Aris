import { Request, Response } from "express";
import { getDatabasePool } from "../db/db";
import { VaultStore } from "../db/vaultStore";
import { info, error } from "../utils/logger";

const pool = getDatabasePool();
const vaultStore = new VaultStore(pool);

// Tool: store_secret
export async function storeSecret(req: Request, res: Response) {
  try {
    const { userId, keyName, value } = req.body;
    if (!userId || !keyName || !value) {
      return res.status(400).json({ error: "Missing userId, keyName or value" });
    }
    const success = await vaultStore.storeSecret(userId, keyName, value);
    res.json({ success, message: success ? `Stored "${keyName}" securely in vault.` : "Failed to store." });
  } catch (err) {
    error("[Vault] storeSecret error", err);
    res.status(500).json({ error: "Vault store failed" });
  }
}

// Tool: retrieve_secret
export async function retrieveSecret(req: Request, res: Response) {
  try {
    const { userId, keyName } = req.body;
    if (!userId || !keyName) {
      return res.status(400).json({ error: "Missing userId or keyName" });
    }
    const value = await vaultStore.retrieveSecret(userId, keyName);
    if (value === null) {
      return res.status(404).json({ error: `No vault entry found for key: ${keyName}` });
    }
    res.json({ value });
  } catch (err) {
    error("[Vault] retrieveSecret error", err);
    res.status(500).json({ error: "Vault retrieval failed" });
  }
}

// Helper for internal services (e.g. autonomy loop fetching the phone PIN)
export async function getSecretInternal(userId: number, keyName: string): Promise<string | null> {
  return vaultStore.retrieveSecret(userId, keyName);
}
