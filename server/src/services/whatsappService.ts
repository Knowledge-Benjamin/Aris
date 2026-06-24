import {
  getPendingWhatsappMessages,
  getRecentWhatsappMessages,
  getWhatsappConversationBySenders,
  getWhatsappMessageStats,
  markWhatsappMessagesAnalyzed,
} from "../db/whatsappStore";
import { resolvePhoneNumbers, resolveNameToPhones, linkWhatsappIdsToContact, jidToDisplayFallback } from "../db/contactsStore";
import { GemmaService } from "./gemmaService";
import { info } from "../utils/logger";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

interface WhatsappSummaryResult {
  summary: string;
  messages: Array<{ from: string; text: string; time: string }>;
  analyzedMessageIds: number[];
}

interface WhatsappConversationResult {
  contactName: string;
  profileSummary?: string;
  messages: Array<{ from: string; text: string; time: string; isAnalyzed: boolean }>;
  raw: string;
}

export class WhatsappService {
  constructor(private gemmaService: GemmaService) {}

  // ─── Internal: run the WhatsApp service once to pull fresh messages ───────────
  private runWhatsappServiceBackground(): void {
    const projectRoot = path.resolve(__dirname, "../../../");
    const whatsappServiceDir = path.join(projectRoot, "whatsapp-service");
    const builtEntrypoint = path.join(whatsappServiceDir, "dist", "src", "index.js");
    const tsEntrypoint = path.join(whatsappServiceDir, "src", "index.ts");
    const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmCommand = process.platform === "win32" ? "cmd.exe" : npmExecutable;
    const npmArgs =
      process.platform === "win32"
        ? ["/c", npmExecutable, "--prefix", whatsappServiceDir, "run", "dev:once"]
        : ["--prefix", whatsappServiceDir, "run", "dev:once"];

    let command = "";
    let args: string[] = [];

    if (existsSync(builtEntrypoint)) {
      command = process.execPath;
      args = [builtEntrypoint, "once"];
    } else if (existsSync(tsEntrypoint)) {
      command = npmCommand;
      args = npmArgs;
    } else {
      throw new Error("Unable to find whatsapp-service entrypoint or build artifact.");
    }

    const child = spawn(command, args, {
      cwd: whatsappServiceDir,
      env: process.env,
      stdio: "ignore", // don't buffer output, let it run silently
      detached: true,  // run independently
    });
    child.unref(); // don't block node from exiting
  }

  // ─── Tool: summarize PENDING (unread) messages ─────────────────────────────
  async summarizePendingMessages(userId?: number): Promise<WhatsappSummaryResult> {
    let messages = await getPendingWhatsappMessages(100);

    if (!messages.length) {
      info("No pending WhatsApp messages found. Spawning WhatsApp service to refresh inbox...");
      this.runWhatsappServiceBackground();

      // Poll the DB for up to 10 seconds to see if live messages arrive
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        messages = await getPendingWhatsappMessages(100);
        if (messages.length > 0) {
          info(`Found ${messages.length} new messages after ${i + 1} seconds.`);
          break;
        }
      }
    }

    if (!messages.length) {
      return { summary: "No new WhatsApp messages were received.", messages: [], analyzedMessageIds: [] };
    }

    const nameMap: Record<string, string> = userId
      ? await resolvePhoneNumbers(userId, [...new Set(messages.map((m) => m.senderId))]).catch(() => ({}))
      : {};

    const formatted = messages.map((m) => {
    const from = nameMap[m.senderId] || jidToDisplayFallback(m.senderId);
      const time = new Date(m.receivedAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return { from, text: m.messageText, time };
    });

    const raw = formatted.map((msg) => `[${msg.time}] ${msg.from}: ${msg.text}`).join("\n");

    const ids = messages.map((m) => m.id);
    await markWhatsappMessagesAnalyzed(ids);

    info(`Fetched ${ids.length} new WhatsApp messages.`);
    return { summary: raw, messages: formatted, analyzedMessageIds: ids };
  }

  // ─── Tool: read a specific contact's conversation from history ──────────────
  async getConversationByContact(
    userId: number,
    contactName: string
  ): Promise<{ found: boolean; result: WhatsappConversationResult | string }> {
    // Resolve name → phone keys
    const resolved = await resolveNameToPhones(userId, contactName);

    if (!resolved || !resolved.phoneKeys.length) {
      return {
        found: false,
        result: `I couldn't find a contact named "${contactName}" in your contacts. Try syncing your contacts or check the spelling.`,
      };
    }

    let messages = await getWhatsappConversationBySenders(resolved.phoneKeys, resolved.whatsappIds, 200);

    if (!messages.length) {
      info(`No stored messages found for ${resolved.displayName}. Spawning WhatsApp service to fetch fresh messages...`);
      this.runWhatsappServiceBackground();

      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        messages = await getWhatsappConversationBySenders(resolved.phoneKeys, resolved.whatsappIds, 200);
        if (messages.length > 0) {
          info(`Found stored messages for ${resolved.displayName} after ${i + 1} seconds.`);
          break;
        }
      }
    }

    if (!messages.length) {
      // No stored messages — let caller know to try fetching fresh
      return {
        found: false,
        result: `No WhatsApp messages found from ${resolved.displayName}. They may not have messaged you yet, or messages were never synced.`,
      };
    }

    // Resolve all sender IDs in this conversation to names
    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    
    // Persist the exact whatsapp IDs back to the contact for future exact matching
    await linkWhatsappIdsToContact(userId, resolved.contactId, senderIds).catch(err => {
      info(`Failed to link whatsapp IDs to contact ${resolved.displayName}: ${err}`);
    });

    const nameMap: Record<string, string> = await resolvePhoneNumbers(userId, senderIds).catch(() => ({}));

    const formatted = messages.map((m) => {
      // Resolve sender name: contact map → pushName in metadata → contact display name → JID fallback
      const pushName = (m.metadata as any)?.pushName;
      const from = nameMap[m.senderId] || pushName || resolved.displayName;
      const time = new Date(m.receivedAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return { from, text: m.messageText, time, isAnalyzed: m.isAnalyzed };
    });

    const raw = formatted
      .map((msg) => `[${msg.time}] ${msg.from}: ${msg.text}`)
      .join("\n");

    const fullRaw = resolved.profileSummary
      ? `Contact Profile Summary for ${resolved.displayName}:\n${resolved.profileSummary}\n\nMessages:\n${raw}`
      : raw;

    return {
      found: true,
      result: {
        contactName: resolved.displayName,
        profileSummary: resolved.profileSummary,
        messages: formatted,
        raw: fullRaw,
      },
    };
  }

  // ─── Tool: read recent WhatsApp history from all contacts ──────────────────
  async getRecentHistory(userId: number, limit = 40): Promise<WhatsappConversationResult> {
    const messages = await getRecentWhatsappMessages(limit);

    if (!messages.length) {
      return {
        contactName: "All",
        messages: [],
        raw: "No WhatsApp messages found in your history.",
      };
    }

    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const nameMap: Record<string, string> = await resolvePhoneNumbers(userId, senderIds).catch(() => ({}));

    const formatted = messages.map((m) => {
      const pushName = (m.metadata as any)?.pushName;
      const from = nameMap[m.senderId] || pushName || jidToDisplayFallback(m.senderId);
      const time = new Date(m.receivedAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return { from, text: m.messageText, time, isAnalyzed: m.isAnalyzed };
    });

    let raw = formatted.map((msg) => `[${msg.time}] ${msg.from}: ${msg.text}`).join("\n");
    if (raw.length > 8000) {
      raw = raw.substring(0, 8000) + "\n... (truncated to save context)";
    }

    return { contactName: "All", messages: formatted, raw };
  }

  // ─── Helper: get inbox stats (lets Aris decide what to do) ─────────────────
  async getInboxStats(): Promise<{ total: number; pending: number; latestAt: string | null; uniqueSenders: number }> {
    const stats = await getWhatsappMessageStats();
    return {
      total: stats.totalMessages,
      pending: stats.pendingMessages,
      latestAt: stats.latestReceivedAt,
      uniqueSenders: stats.uniqueSenders,
    };
  }


}
