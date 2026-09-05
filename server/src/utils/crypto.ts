import crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

// Must be exactly 32 bytes (256 bits)
const MASTER_KEY = process.env.VAULT_MASTER_KEY 
  ? Buffer.from(process.env.VAULT_MASTER_KEY, 'hex') 
  : crypto.scryptSync("aris_default_secure_vault_secret", "salt", 32);

const ALGORITHM = "aes-256-gcm";

export function encryptVaultData(text: string): { iv: string; encryptedData: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    iv: iv.toString("hex"),
    encryptedData: encrypted,
    authTag: authTag
  };
}

export function decryptVaultData(ivHex: string, encryptedData: string, authTagHex: string): string {
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  
  const decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedData, "hex", "utf8");
  decrypted += decipher.final("utf8");
  
  return decrypted;
}
