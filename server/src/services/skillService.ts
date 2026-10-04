import { SkillDefinition, SkillRecord, SkillStep, SkillStore } from "../db/skillStore";
import { GoogleAccountRecord } from "../db/googleAccountStore";
import { GoogleService } from "./googleService";
import { info } from "../utils/logger";

export interface SkillToolResult {
  success: boolean;
  tool: string;
  data?: any;
  error?: string;
}

type ToolExecutor = (tool: string, payload: any) => Promise<SkillToolResult>;
type TokenPersister = (tokens: any) => Promise<void>;

export class SkillService {
  constructor(
    private store: SkillStore,
    private googleService: GoogleService,
    private getGoogleAccount: (userId: number) => Promise<GoogleAccountRecord | undefined>,
    private persistGoogleTokens: (userId: number, tokens: any) => Promise<void>
  ) {}

  async createOrRevise(userId: number, definition: SkillDefinition, status: "active" | "draft" = "active"): Promise<SkillRecord> {
    this.validateDefinition(definition);
    const account = await this.getGoogleAccount(userId);
    if (!account) throw new Error("Connect Google before saving a skill to Drive.");
    const persistTokens: TokenPersister = (tokens) => this.persistGoogleTokens(userId, tokens);
    const file = await this.googleService.uploadDriveFile(
      account,
      `aris-skill-${definition.name}-v${Date.now()}.json`,
      "application/json",
      Buffer.from(JSON.stringify(definition, null, 2), "utf8"),
      persistTokens,
      false
    );
    const saved = await this.store.upsert(userId, definition, status, file.id ?? undefined);
    info(`[skillService] saved skill=${saved.name} version=${saved.version} userId=${userId}`);
    return saved;
  }

  async revise(userId: number, existingName: string, update: Partial<SkillDefinition>, status: "active" | "draft" = "active"): Promise<SkillRecord> {
    const current = await this.store.getByName(existingName, userId);
    if (!current) throw new Error(`Skill not found: ${existingName}`);
    const nextDefinition: SkillDefinition = {
      ...current,
      ...update,
      name: update.name || current.name,
      triggers: update.triggers || current.triggers,
      steps: update.steps || current.steps,
      constraints: update.constraints || current.constraints,
      metadata: {
        ...(current.metadata || {}),
        ...(update.metadata || {}),
      },
    };
    return this.createOrRevise(userId, nextDefinition, status);
  }

  async list(userId: number): Promise<SkillRecord[]> {
    return this.store.list(userId);
  }

  async execute(userId: number, name: string, input: Record<string, unknown>, executeTool: ToolExecutor) {
    const skill = await this.store.getByName(name, userId);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    if (skill.status !== "active") throw new Error(`Skill is not active: ${name}`);

    const context: Record<string, unknown> = { input };
    const trace: unknown[] = [];
    try {
      for (let index = 0; index < skill.steps.length; index += 1) {
        const step = skill.steps[index];
        const payload = this.resolveTemplates(step.payload || {}, context);
        const result = await executeTool(step.tool, payload);
        trace.push({ index, tool: step.tool, payload, result });
        if (!result.success) throw new Error(`${step.tool} failed: ${result.error || "unknown error"}`);
        if (step.saveAs) context[step.saveAs] = result.data;
      }
      await this.store.recordRun(skill, userId, input, context, true, undefined, trace);
      return { skill: skill.name, version: skill.version, output: context, trace };
    } catch (error: any) {
      const message = error?.message || String(error);
      await this.store.recordRun(skill, userId, input, context, false, message, trace);
      return { skill: skill.name, version: skill.version, output: context, trace, success: false, error: message };
    }
  }

  private validateDefinition(definition: SkillDefinition) {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(definition.name)) throw new Error("Skill name must be 2-64 characters using letters, numbers, underscores, or hyphens.");
    if (!definition.description?.trim()) throw new Error("Skill description is required.");
    if (!Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > 20) throw new Error("A skill must contain 1 to 20 steps.");
    for (const step of definition.steps) {
      if (!step || typeof step.tool !== "string" || !step.tool.trim()) throw new Error("Every skill step requires a tool name.");
      if (step.tool === "skill_create" || step.tool === "skill_revise") throw new Error("Skills cannot mutate skill definitions.");
      if (step.tool === "skill_run" && step.payload?.name === definition.name) throw new Error("A skill cannot call itself.");
    }
  }

  private resolveTemplates(value: any, context: Record<string, unknown>): any {
    if (typeof value === "string") {
      return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
        const parts = path.split(".");
        let current: any = context;
        for (const part of parts) current = current?.[part];
        return current === undefined || current === null ? "" : typeof current === "string" ? current : JSON.stringify(current);
      });
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveTemplates(item, context));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveTemplates(item, context)]));
    return value;
  }
}
