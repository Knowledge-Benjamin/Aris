import { Pool } from "pg";
import { encryptVaultData, decryptVaultData } from "../utils/crypto";
import { info, error } from "../utils/logger";

export class VaultStore {
  constructor(private pool: Pool) {
    this.initializeTable();
  }

  private async initializeTable() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS secure_vault (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        key_name VARCHAR(255) NOT NULL,
        iv_hex TEXT NOT NULL,
        auth_tag_hex TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, key_name)
      );
    `).catch(err => error("Failed to create secure_vault table", err));
  }

  public async storeSecret(userId: number, keyName: string, plainText: string): Promise<boolean> {
    try {
      const { iv, encryptedData, authTag } = encryptVaultData(plainText);
      
      await this.pool.query(`
        INSERT INTO secure_vault (user_id, key_name, iv_hex, auth_tag_hex, encrypted_data, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id, key_name) 
        DO UPDATE SET 
          iv_hex = EXCLUDED.iv_hex,
          auth_tag_hex = EXCLUDED.auth_tag_hex,
          encrypted_data = EXCLUDED.encrypted_data,
          updated_at = NOW();
      `, [userId, keyName, iv, authTag, encryptedData]);
      
      info(`[Vault] Stored encrypted secret for key: ${keyName}`);
      return true;
    } catch (err) {
      error("[Vault] Error storing secret", err);
      return false;
    }
  }

  public async retrieveSecret(userId: number, keyName: string): Promise<string | null> {
    try {
      const result = await this.pool.query(
        `SELECT iv_hex, auth_tag_hex, encrypted_data FROM secure_vault WHERE user_id = $1 AND key_name = $2`,
        [userId, keyName]
      );
      
      if (result.rows.length === 0) return null;
      
      const { iv_hex, auth_tag_hex, encrypted_data } = result.rows[0];
      const decrypted = decryptVaultData(iv_hex, encrypted_data, auth_tag_hex);
      
      info(`[Vault] Decrypted secret for key: ${keyName}`);
      return decrypted;
    } catch (err) {
      error("[Vault] Error retrieving secret", err);
      return null;
    }
  }
}
