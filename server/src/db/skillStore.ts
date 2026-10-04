import { Pool } from "pg";

export interface SkillStep {
  tool: string;
  payload?: Record<string, unknown>;
  saveAs?: string;
  requiresApproval?: boolean;
}

export interface SkillLearningMeta {
  preferredTools?: string[];
  successRate?: number;
  failurePatterns?: string[];
  lastUpdated?: string;
  lastOutcome?: "success" | "failure";
  relatedSkills?: string[];
  sideEffectTools?: string[];
}

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  steps: SkillStep[];
  constraints?: string[];
  metadata?: SkillLearningMeta;
}

export interface SkillRecord extends SkillDefinition {
  id: number;
  userId?: number;
  version: number;
  status: "active" | "draft" | "disabled";
  driveFileId?: string;
  successCount: number;
  failureCount: number;
  lastError?: string;
}

export class SkillStore {
  constructor(private pool: Pool) {}

  async list(userId?: number): Promise<SkillRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM skills WHERE status = 'active' AND (user_id IS NULL OR user_id = $1) ORDER BY updated_at DESC`,
      [userId ?? null]
    );
    return result.rows.map((row) => this.map(row));
  }

  async getByName(name: string, userId?: number): Promise<SkillRecord | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM skills WHERE name = $1 AND (user_id IS NULL OR user_id = $2) ORDER BY user_id NULLS LAST, version DESC LIMIT 1`,
      [name, userId ?? null]
    );
    return result.rows[0] ? this.map(result.rows[0]) : undefined;
  }

  async upsert(userId: number | undefined, definition: SkillDefinition, status: SkillRecord["status"] = "active", driveFileId?: string): Promise<SkillRecord> {
    const result = await this.pool.query(
      `INSERT INTO skills (user_id, name, description, version, status, definition, drive_file_id)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6)
       ON CONFLICT (user_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         version = skills.version + 1,
         status = EXCLUDED.status,
         definition = EXCLUDED.definition,
         drive_file_id = COALESCE(EXCLUDED.drive_file_id, skills.drive_file_id),
         updated_at = NOW()
       RETURNING *`,
      [userId ?? null, definition.name, definition.description, status, JSON.stringify(definition), driveFileId ?? null]
    );
    return this.map(result.rows[0]);
  }

  async recordRun(skill: SkillRecord, userId: number | undefined, input: unknown, output: unknown, success: boolean, error: string | undefined, trace: unknown[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO skill_runs (skill_id, user_id, input, output, success, error, trace)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::jsonb)`,
      [skill.id, userId ?? null, JSON.stringify(input ?? {}), JSON.stringify(output ?? null), success, error ?? null, JSON.stringify(trace)]
    );
    await this.pool.query(
      `UPDATE skills SET success_count = success_count + $2, failure_count = failure_count + $3, last_error = $4, updated_at = NOW() WHERE id = $1`,
      [skill.id, success ? 1 : 0, success ? 0 : 1, error ?? null]
    );
  }

  private map(row: any): SkillRecord {
    const definition = row.definition || {};
    return {
      id: row.id,
      userId: row.user_id ?? undefined,
      name: row.name,
      description: row.description || definition.description || "",
      triggers: Array.isArray(definition.triggers) ? definition.triggers : [],
      steps: Array.isArray(definition.steps) ? definition.steps : [],
      constraints: Array.isArray(definition.constraints) ? definition.constraints : [],
      metadata: definition.metadata || {
        preferredTools: [],
        successRate: 0,
        failurePatterns: [],
      },
      version: row.version,
      status: row.status,
      driveFileId: row.drive_file_id ?? undefined,
      successCount: row.success_count,
      failureCount: row.failure_count,
    };
  }
}
