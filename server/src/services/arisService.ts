import { MemoryStore, UserProfileEntry } from "../db/memoryStore";
import { getDatabasePool } from "../db/db";
import { GoogleAccountStore } from "../db/googleAccountStore";
import { GemmaService } from "./gemmaService";
import { SearchClient, SearchResponse } from "./searchClient";
import { ExtractClient, ExtractResponse } from "./extractClient";
import { GoogleService } from "./googleService";
import { WhatsappService } from "./whatsappService";
import { TomTomService } from "./tomtomService";
import { info } from "../utils/logger";

const searchToolEnabled = process.env.SEARCH_TOOL_ENABLED?.trim().toLowerCase() !== "false" &&
  process.env.SEARCH_TOOL_ENABLED?.trim() !== "0";

const searchEngineList = process.env.SEARCH_TOOL_ENGINES || "google,bing,duckduckgo,searx";

interface ChatInput {
  message: string;
  sessionId?: string;
  userId?: number;
}

interface ToolInvocation {
  tool: string;
  payload: any;
}

interface ToolExecutionResult {
  success: boolean;
  tool: string;
  data?: any;
  error?: string;
}

interface ToolChainResult {
  status: "finished" | "awaiting_approval" | "max_iterations_reached" | "error";
  reply: string;
  memoryEntries: string[];
  pendingAction?: ToolInvocation;
}

interface ArisResponse {
  arisReply: string;
  memoryUpdates: string[];
}

export class ArisService {
  private searchClient = new SearchClient();
  private extractClient = new ExtractClient();
  private googleService = new GoogleService();
  private googleAccountStore = new GoogleAccountStore(getDatabasePool());
  private whatsappService = new WhatsappService(new GemmaService());
  private tomtomService = new TomTomService();
  private recentGmailMessagesByUser = new Map<string, Array<{ id: string; subject: string; from: string; date?: string }>>();
  private lastToolInvocationByUser = new Map<string, { tool: string; payload: any }>();
  private readonly supportedToolNames = new Set<string>([
    "search",
    "whatsapp_summary",
    "tomtom_route",
    "tomtom_flow",
    "tomtom_incidents",
    "tomtom_traffic",
    "google_calendar_events",
    "google_calendar_event",
    "google_calendar_create",
    "google_calendar_update",
    "google_calendar_delete",
    "google_calendar_import",
    "google_calendar_instances",
    "google_calendar_move",
    "google_calendar_patch",
    "google_calendar_quickAdd",
    "google_calendar_watch_events",
    "google_calendar_list_calendar_list",
    "google_calendar_get_calendar_list",
    "google_calendar_insert_calendar_list",
    "google_calendar_update_calendar_list",
    "google_calendar_patch_calendar_list",
    "google_calendar_delete_calendar_list",
    "google_calendar_watch_calendar_list",
    "google_calendar_get_calendar",
    "google_calendar_create_calendar",
    "google_calendar_update_calendar",
    "google_calendar_patch_calendar",
    "google_calendar_delete_calendar",
    "google_calendar_clear_calendar",
    "google_calendar_list_acl",
    "google_calendar_get_acl",
    "google_calendar_insert_acl",
    "google_calendar_update_acl",
    "google_calendar_patch_acl",
    "google_calendar_delete_acl",
    "google_calendar_watch_acl",
    "google_calendar_get_colors",
    "google_calendar_freebusy_query",
    "google_calendar_list_settings",
    "google_calendar_get_setting",
    "google_calendar_watch_settings",
    "google_calendar_stop_channel",
    "google_gmail_messages",
    "google_gmail_message",
    "google_gmail_threads",
    "google_gmail_thread",
    "google_gmail_drafts",
    "google_gmail_draft",
    "google_gmail_draft_create",
    "google_gmail_draft_update",
    "google_gmail_draft_send",
    "google_gmail_send",
    "google_gmail_label",
    "google_gmail_settings",
    "google_gmail_watch",
    "google_gmail_attachment",
    "google_gmail_user_profile",
  ]);

  constructor(private memoryStore: MemoryStore, private gemmaService: GemmaService) {}

  private getContextKey(userId: number | undefined, sessionId: string | undefined) {
    if (userId !== undefined && userId !== null) {
      return `user:${userId}`;
    }
    return sessionId ? `session:${sessionId}` : "unknown";
  }

  private recordRecentGmailMessages(userId: number | undefined, sessionId: string | undefined, messages: Array<{ id: string; subject: string; from: string; date?: string }>) {
    const key = this.getContextKey(userId, sessionId);
    this.recentGmailMessagesByUser.set(key, messages);
  }

  private getRecentGmailMessages(userId: number | undefined, sessionId: string | undefined) {
    const key = this.getContextKey(userId, sessionId);
    return this.recentGmailMessagesByUser.get(key) || [];
  }

  private recordLastToolInvocation(userId: number | undefined, sessionId: string | undefined, invocation: { tool: string; payload: any }) {
    const key = this.getContextKey(userId, sessionId);
    this.lastToolInvocationByUser.set(key, invocation);
  }

  private getLastToolInvocation(userId: number | undefined, sessionId: string | undefined) {
    const key = this.getContextKey(userId, sessionId);
    return this.lastToolInvocationByUser.get(key);
  }

  async generateWelcomeMessage(userId: number, sessionId?: string): Promise<string> {
    const userProfile = await this.memoryStore.getUserProfile(userId);
    const preferredName = userProfile.find((entry) => entry.profileKey === "preferred_name")?.profileValue;
    const userName = preferredName || userProfile.find((entry) => entry.profileKey === "name")?.profileValue || "there";

    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    const prompt = [
      `You are Aris, a warm and engaging assistant who remembers the user and speaks naturally.`,
      `Use the user's profile data to generate a short, upbeat welcome message that sounds unique and not repetitive.`,
      `Greet the user by name if known, and offer help with energy and personality.`,
      `Do not include instructions, analysis, or metadata. Return only the spoken greeting sentence or brief phrase.`,
      `Do not repeat the same exact greeting each time. Use varied wording and natural conversational phrasing.`,
      ...profileLines,
      `If the user is known as ${userName}, a helpful example would be: 'Hey ${userName}, great to hear from you—what can I help with today?'`,
      `If the user's name is not known, use a friendly generic phrase such as 'Hi there, what can I do for you today?'`,
      "Aris:"
    ].filter(Boolean).join("\n");

    const generated = await this.gemmaService.requestArisAdvice(prompt);
    const fallbackResponses = [
      `Hey ${userName}, what can I help you with today?`,
      `Hi ${userName}, great to hear from you—how can I assist?`,
      `Hello ${userName}, I'm ready when you are. What would you like to do?`,
      `Hi ${userName}, how can I make today easier for you?`
    ];
    const fallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    return generated.reply.trim() || fallback;
  }

  async handleChat(input: ChatInput): Promise<ArisResponse> {
    const sessionId = input.sessionId || "default";
    info(`[arisService] handleChat start sessionId=${sessionId} query="${input.message}" searchToolEnabled=${searchToolEnabled}`);

    const saveUserMessagePromise = this.memoryStore.saveConversationMessage({
      userId: input.userId,
      sessionId,
      role: "user",
      content: input.message,
    });

    const profileEntries = this.extractProfileMetadata(input.message);
    const profileSavePromises = input.userId && profileEntries.length
      ? profileEntries.map((entry) => this.memoryStore.storeProfileEntry(input.userId!, entry.key, entry.value))
      : [];

    const directMemoryEntries = this.extractDirectMemoryEntries(input.message);
    const directMemorySavePromises = directMemoryEntries.map((entry) =>
      this.memoryStore.storeMemoryEntry(input.userId, sessionId, entry)
    );

    const userProfilePromise = input.userId ? this.memoryStore.getUserProfile(input.userId) : Promise.resolve([] as UserProfileEntry[]);
    const conversationHistoryPromise = this.memoryStore.getRecentConversationHistory(input.userId, sessionId, 12);

    const [userProfile, conversationHistory] = await Promise.all([userProfilePromise, conversationHistoryPromise]);
    const effectiveMessage = this.rewriteUserMessageForCoreference(input.message, input.userId, sessionId, conversationHistory);
    const memoryContext = await this.memoryStore.getRelevantMemories(input.userId, sessionId, effectiveMessage, 12);
    await Promise.all([saveUserMessagePromise, ...profileSavePromises, ...directMemorySavePromises]);

    const toolChainResult = await this.executeToolChain(
      input.userId,
      effectiveMessage,
      userProfile,
      memoryContext,
      conversationHistory,
      sessionId,
      searchToolEnabled
    );

    let arisReply = toolChainResult.reply;
    let memoryEntries = Array.from(new Set<string>(toolChainResult.memoryEntries || []));

    if (toolChainResult.status === "awaiting_approval" && toolChainResult.pendingAction) {
      info(`[arisService] awaiting approval for tool=${toolChainResult.pendingAction.tool}`);
    }

    if (toolChainResult.status === "max_iterations_reached") {
      info(`[arisService] tool chaining stopped after reaching the iteration limit.`);
    }

    const saveArisReplyPromise = this.memoryStore.saveConversationMessage({
      userId: input.userId,
      sessionId,
      role: "aris",
      content: arisReply,
    });

    const memoryStorePromises = memoryEntries.map((entry) =>
      this.memoryStore.storeMemoryEntry(input.userId, sessionId, entry)
    );

    await Promise.all([saveArisReplyPromise, ...memoryStorePromises]);

    return {
      arisReply,
      memoryUpdates: memoryEntries,
    };
  }

  private extractDirectMemoryEntries(userMessage: string): string[] {
    const normalized = userMessage.trim();
    const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
      [/((?:my name is|call me|you can call me)\s+)(.+?)(?:[.!?]|$)/i, (m) => `User's name is ${m[2].trim()}`],
      [/(?:my pronouns are|pronouns:?\s*)(he\/him|she\/her|they\/them|any|xe|ze|hir)/i, (m) => `User's pronouns are ${m[1].trim().toLowerCase()}`],
      [/(?:i prefer|i'd prefer|i like|i love|i enjoy)\s+(.+?)(?:[.!?]|$)/i, (m) => `User prefers ${m[1].trim()}`],
      [/(?:i am|i'm|i'm a|i am a|i am an)\s+(.+?)(?:[.!?]|$)/i, (m) => {
        const value = m[2].trim();
        if (/\b(name|sure|okay|yes|no)\b/i.test(value)) {
          return "";
        }
        return `User is ${value}`;
      }],
    ];

    const entries = new Set<string>();
    for (const [regex, build] of patterns) {
      const match = normalized.match(regex);
      if (match && match[1]) {
        const entry = build(match).trim();
        if (entry) {
          entries.add(entry.replace(/["'“”’]+$/g, "").trim());
        }
      }
    }

    return Array.from(entries);
  }

  private extractProfileMetadata(userMessage: string): Array<{ key: string; value: string }> {
    const normalized = userMessage.trim();
    const profilePatterns: Array<[RegExp, (match: RegExpMatchArray) => { key: string; value: string }]> = [
      [/((?:my name is|call me|you can call me)\s+)(.+?)(?:[.!?]|$)/i, (m) => ({ key: "name", value: m[2].trim() })],
      [/(?:my pronouns are|pronouns:?\s*)(he\/him|she\/her|they\/them|any|xe|ze|hir)/i, (m) => ({ key: "pronouns", value: m[1].trim().toLowerCase() })],
      [/(?:i prefer|i'd prefer|i like|i love|i enjoy)\s+(.+?)(?:[.!?]|$)/i, (m) => ({ key: "preference", value: m[1].trim() })],
      [/(?:i am|i'm|i'm a|i am a|i am an)\s+(.+?)(?:[.!?]|$)/i, (m) => {
        const value = m[2].trim();
        if (/\b(name|sure|okay|yes|no)\b/i.test(value)) {
          return { key: "", value: "" };
        }
        return { key: "identity", value };
      }],
      [/(?:my favorite|i'm a fan of|i love|i like)\s+(.+?)(?:[.!?]|$)/i, (m) => ({ key: "interest", value: m[1].trim() })],
      [/(?:call me|address me as)\s+(.+?)(?:[.!?]|$)/i, (m) => ({ key: "preferred_name", value: m[1].trim() })],
    ];

    const entries: Array<{ key: string; value: string }> = [];
    for (const [regex, build] of profilePatterns) {
      const match = normalized.match(regex);
      if (match && match[1]) {
        const entry = build(match);
        if (entry.key && entry.value) {
          entries.push({ key: entry.key, value: entry.value.replace(/["'“”’]+$/g, "").trim() });
        }
      }
    }

    return entries;
  }

  private parseSearchToolQuery(text: string): string | undefined {
    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = this.normalizeToolLine(rawLine);
      if (!line) {
        continue;
      }

      if (/^\{/.test(line) && /"tool"\s*:\s*"search"/i.test(line)) {
        try {
          const payload = JSON.parse(line);
          if (payload.tool === "search" && typeof payload.query === "string") {
            return payload.query.trim();
          }
        } catch {
          // ignore invalid JSON
        }
      }

      const pattern = /^(?:TOOL_SEARCH|SEARCH_TOOL|SEARCH_QUERY)\s*[:=]\s*(.+)$/i;
      const match = line.match(pattern);
      if (match) {
        return match[1].trim().replace(/^[\'\"“‘]+|[\'\"”’]+$/g, "");
      }
    }

    return undefined;
  }

  private parseToolInvocation(text: string): ToolInvocation | undefined {
    const invocations = this.parseToolInvocations(text);
    return invocations?.[0];
  }

  private parseToolInvocations(text: string): ToolInvocation[] | undefined {
    const normalizedText = text.trim();
    const invocations: ToolInvocation[] = [];

    const tryParseObject = (value: any) => {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          tryParseObject(entry);
        }
        return;
      }
      if (typeof value === "object" && typeof value.tool === "string") {
        invocations.push({ tool: value.tool.trim(), payload: value });
      }
    };

    if (normalizedText.startsWith("{") || normalizedText.startsWith("[")) {
      try {
        const parsed = JSON.parse(normalizedText);
        tryParseObject(parsed);
      } catch {
        // ignore invalid JSON and fall back to line parsing
      }
    }

    const lines = normalizedText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = this.normalizeToolLine(rawLine);
      if (!line) {
        continue;
      }

      const parsedJson = this.parseToolJsonFromLine(line);
      if (parsedJson && typeof parsedJson.tool === "string") {
        if (!invocations.some((inv) => JSON.stringify(inv.payload) === JSON.stringify(parsedJson))) {
          invocations.push({ tool: parsedJson.tool.trim(), payload: parsedJson });
        }
        continue;
      }

      const searchPattern = /^(?:TOOL_SEARCH|SEARCH_TOOL|SEARCH_QUERY)\s*[:=]\s*(.+)$/i;
      const searchMatch = line.match(searchPattern);
      if (searchMatch) {
        invocations.push({
          tool: "search",
          payload: { query: searchMatch[1].trim().replace(/^[\'\"“‘]+|[\'\"”’]+$/g, "") },
        });
      }
    }

    return invocations.length ? invocations : undefined;
  }

  private normalizeToolName(toolName: string): string {
    const normalized = toolName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const aliases: Record<string, string> = {
      google_calendar_createevent: "google_calendar_create",
      google_calendar_create_event: "google_calendar_create",
      google_calendar_updateevent: "google_calendar_update",
      google_calendar_update_event: "google_calendar_update",
      google_calendar_deleteevent: "google_calendar_delete",
      google_calendar_delete_event: "google_calendar_delete",
      google_calendar_quickadd: "google_calendar_quickAdd",
      google_calendar_quick_add: "google_calendar_quickAdd",
      google_calendar_get_events: "google_calendar_events",
      google_calendar_getevents: "google_calendar_events",
      google_gmail_messageget: "google_gmail_message",
      google_gmail_message_get: "google_gmail_message",
      google_gmail_threadget: "google_gmail_thread",
      google_gmail_thread_get: "google_gmail_thread",
    };
    return aliases[normalized] || toolName.trim();
  }

  private normalizeToolPayload(payload: any): any {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const flattened = { ...payload };
    if (typeof flattened.payload === "object" && flattened.payload !== null) {
      const nested = flattened.payload;
      delete flattened.payload;
      Object.assign(flattened, nested);
    }

    if (typeof flattened.arguments === "object" && flattened.arguments !== null) {
      const nested = flattened.arguments;
      delete flattened.arguments;
      Object.assign(flattened, nested);
    }

    return flattened;
  }

  private normalizeToolInvocation(invocation: ToolInvocation): ToolInvocation {
    return {
      tool: this.normalizeToolName(invocation.tool),
      payload: this.normalizeToolPayload(invocation.payload),
    };
  }

  private validateToolName(toolName: string): string | undefined {
    const normalized = this.normalizeToolName(toolName);
    if (this.supportedToolNames.has(normalized)) {
      return normalized;
    }

    const rawNormalized = toolName.trim().replace(/[^a-zA-Z0-9_]/g, "");
    if (this.supportedToolNames.has(rawNormalized)) {
      return rawNormalized;
    }

    return undefined;
  }

  private validateToolPayload(toolName: string, payload: any): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    switch (toolName) {
      case "google_calendar_quickAdd":
        if (!payload.text || typeof payload.text !== "string" || !payload.text.trim()) {
          return "google_calendar_quickAdd requires a top-level \"text\" field with the event description.";
        }
        break;
      case "google_calendar_create":
        if (!payload.event && typeof payload.event !== "object") {
          return "google_calendar_create requires a top-level \"event\" object.";
        }
        break;
      case "google_calendar_update":
      case "google_calendar_patch":
        if (!payload.eventId || typeof payload.eventId !== "string") {
          return `${toolName} requires a top-level \"eventId\" string.`;
        }
        break;
      case "google_calendar_delete":
      case "google_calendar_event":
        if (!payload.eventId || typeof payload.eventId !== "string") {
          return `${toolName} requires a top-level \"eventId\" string.`;
        }
        break;
      default:
        break;
    }

    return undefined;
  }

  private async executeToolCall(userId: number | undefined, invocation: ToolInvocation, sessionId?: string): Promise<ToolExecutionResult> {
    const validatedToolName = this.validateToolName(invocation.tool);
    if (!validatedToolName) {
      return {
        success: false,
        tool: invocation.tool,
        error: `Unsupported or invalid tool name: ${invocation.tool}. Use one of the exact supported tool names listed in the prompt.`,
      };
    }

    const toolName = validatedToolName;
    const payloadError = this.validateToolPayload(toolName, invocation.payload);
    if (payloadError) {
      return {
        success: false,
        tool: toolName,
        error: payloadError,
      };
    }

    if (toolName === "search") {
      if (!searchToolEnabled) {
        return { success: false, tool: toolName, error: "Search tool is disabled." };
      }

      try {
        const query = invocation.payload?.query || "";
        const searchResponse = await this.searchClient.search({
          query,
          engines: searchEngineList,
          limit: 5,
        });

        const extractResponse = await this.attemptUrlExtraction(searchResponse);
        const result = {
          success: true,
          tool: toolName,
          data: {
            query,
            searchResponse,
            extractResponse,
          },
        };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Search execution failed." };
      }
    }

    if (toolName === "whatsapp_summary") {
      try {
        const data = await this.whatsappService.summarizePendingMessages();
        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "WhatsApp summary execution failed." };
      }
    }

    if (toolName === "tomtom_route") {
      try {
        const payload = invocation.payload || {};
        const origin = payload.origin || payload.from || payload.start;
        const destination = payload.destination || payload.to || payload.end;
        const mode = payload.mode || payload.travelMode || "car";
        const departureTime = payload.departureTime || payload.when || payload.time;

        if (!origin || !destination) {
          return { success: false, tool: toolName, error: "TomTom route tool requires both origin and destination." };
        }

        const data = await this.tomtomService.getTrafficRoute(origin, destination, { mode, departureTime });
        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "TomTom route execution failed." };
      }
    }

    if (toolName === "tomtom_flow") {
      try {
        const payload = invocation.payload || {};
        const location = payload.location || payload.query || payload.place || payload.point || payload.address;
        if (!location) {
          return { success: false, tool: toolName, error: "TomTom flow tool requires a location or traffic query." };
        }

        const data = await this.tomtomService.getTrafficFlow(location);
        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "TomTom flow execution failed." };
      }
    }

    if (toolName === "tomtom_incidents") {
      try {
        const payload = invocation.payload || {};
        const location = payload.location || payload.query || payload.place || payload.bbox || payload.area;
        const options = {
          categoryFilter: payload.categoryFilter,
          timeValidityFilter: payload.timeValidityFilter,
          language: payload.language,
        };

        if (!location) {
          return { success: false, tool: toolName, error: "TomTom incidents tool requires a location, area, or bbox." };
        }

        const incidentLocation = payload.bbox ? { bbox: payload.bbox, label: payload.location || payload.place } : location;
        const data = await this.tomtomService.getTrafficIncidents(incidentLocation, options);
        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "TomTom incidents execution failed." };
      }
    }

    if (toolName === "tomtom_traffic") {
      try {
        const payload = invocation.payload || {};
        const origin = payload.origin || payload.from || payload.start;
        const destination = payload.destination || payload.to || payload.end;
        const query = payload.query || payload.text || payload.message;
        const mode = payload.mode || payload.travelMode || "car";
        const departureTime = payload.departureTime || payload.when || payload.time;

        const useQueryOnly = !origin && !destination && typeof query === "string" && query.trim().length > 0;
        if (!origin && !destination && !useQueryOnly) {
          return { success: false, tool: toolName, error: "TomTom traffic tool requires at least an origin, destination, or traffic query." };
        }

        const data = destination
          ? await this.tomtomService.getTrafficRoute(origin || "current location", destination, { mode, departureTime })
          : await this.tomtomService.getTrafficFromQuery(query);

        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "TomTom traffic execution failed." };
      }
    }

    if (!userId) {
      return { success: false, tool: toolName, error: "Unauthorized user." };
    }

    if (!toolName.startsWith("google_")) {
      return { success: false, tool: toolName, error: `Unknown tool: ${toolName}` };
    }

    const account = await this.googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return {
        success: false,
        tool: toolName,
        error: "Google account is not connected. Please connect your Google account before using Gmail or Calendar tools.",
      };
    }

    const persistTokens = async (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => {
      await this.googleAccountStore.updateGoogleTokens(
        userId,
        tokens.access_token ?? undefined,
        tokens.refresh_token ?? undefined,
        tokens.expiry_date ?? undefined,
        tokens.scope ?? undefined
      );
    };

    try {
      switch (toolName) {
        case "google_calendar_events":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getCalendarEvents(
              account,
              invocation.payload?.maxResults || 10,
              invocation.payload?.timeMin,
              invocation.payload?.timeMax,
              persistTokens
            ),
          };
        case "google_calendar_event":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getCalendarEvent(account, invocation.payload?.eventId, persistTokens),
          };
        case "google_calendar_create":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.createCalendarEvent(account, invocation.payload?.event || invocation.payload, persistTokens),
          };
        case "google_calendar_update":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.updateCalendarEvent(account, invocation.payload?.eventId, invocation.payload?.event || {}, persistTokens),
          };
        case "google_calendar_delete":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.deleteCalendarEvent(account, invocation.payload?.eventId, persistTokens),
          };
        case "google_calendar_import":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.importCalendarEvent(account, invocation.payload?.event || invocation.payload, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_instances":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getCalendarEventInstances(account, invocation.payload?.eventId, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_move":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.moveCalendarEvent(account, invocation.payload?.eventId, invocation.payload?.destinationCalendarId, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_patch":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.patchCalendarEvent(account, invocation.payload?.eventId, invocation.payload?.event || {}, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_quickAdd":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.quickAddCalendarEvent(account, invocation.payload?.text, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_watch_events":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.watchCalendarEvents(account, invocation.payload?.channel || invocation.payload, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_list_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.listCalendarListEntries(account, persistTokens),
          };
        case "google_calendar_get_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getCalendarListEntry(account, invocation.payload?.calendarId, persistTokens),
          };
        case "google_calendar_insert_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.insertCalendarListEntry(account, invocation.payload?.calendarListEntry || invocation.payload, persistTokens),
          };
        case "google_calendar_update_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.updateCalendarListEntry(account, invocation.payload?.calendarId, invocation.payload?.calendarListEntry || invocation.payload, persistTokens),
          };
        case "google_calendar_patch_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.patchCalendarListEntry(account, invocation.payload?.calendarId, invocation.payload?.calendarListEntry || invocation.payload, persistTokens),
          };
        case "google_calendar_delete_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.deleteCalendarListEntry(account, invocation.payload?.calendarId, persistTokens),
          };
        case "google_calendar_watch_calendar_list":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.watchCalendarList(account, invocation.payload?.channel || invocation.payload, persistTokens),
          };
        case "google_calendar_get_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getCalendar(account, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_create_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.createCalendar(account, invocation.payload?.calendar || invocation.payload, persistTokens),
          };
        case "google_calendar_update_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.updateCalendar(account, invocation.payload?.calendarId, invocation.payload?.calendar || invocation.payload, persistTokens),
          };
        case "google_calendar_patch_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.patchCalendar(account, invocation.payload?.calendarId, invocation.payload?.calendar || invocation.payload, persistTokens),
          };
        case "google_calendar_delete_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.deleteCalendar(account, invocation.payload?.calendarId, persistTokens),
          };
        case "google_calendar_clear_calendar":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.clearCalendar(account, invocation.payload?.calendarId, persistTokens),
          };
        case "google_calendar_list_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.listAclRules(account, invocation.payload?.calendarId || "primary", persistTokens),
          };
        case "google_calendar_get_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getAclRule(account, invocation.payload?.calendarId || "primary", invocation.payload?.ruleId, persistTokens),
          };
        case "google_calendar_insert_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.insertAclRule(account, invocation.payload?.calendarId || "primary", invocation.payload?.rule || invocation.payload, persistTokens),
          };
        case "google_calendar_update_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.updateAclRule(account, invocation.payload?.calendarId || "primary", invocation.payload?.ruleId, invocation.payload?.rule || invocation.payload, persistTokens),
          };
        case "google_calendar_patch_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.patchAclRule(account, invocation.payload?.calendarId || "primary", invocation.payload?.ruleId, invocation.payload?.rule || invocation.payload, persistTokens),
          };
        case "google_calendar_delete_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.deleteAclRule(account, invocation.payload?.calendarId || "primary", invocation.payload?.ruleId, persistTokens),
          };
        case "google_calendar_watch_acl":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.watchAcl(account, invocation.payload?.calendarId || "primary", invocation.payload?.channel || invocation.payload, persistTokens),
          };
        case "google_calendar_get_colors":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getColors(account, persistTokens),
          };
        case "google_calendar_freebusy_query":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.queryFreeBusy(account, invocation.payload?.requestBody || invocation.payload, persistTokens),
          };
        case "google_calendar_list_settings":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.listSettings(account, persistTokens),
          };
        case "google_calendar_get_setting":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getSetting(account, invocation.payload?.setting, persistTokens),
          };
        case "google_calendar_watch_settings":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.watchSettings(account, invocation.payload?.channel || invocation.payload, persistTokens),
          };
        case "google_calendar_stop_channel":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.stopChannel(account, invocation.payload?.channel || invocation.payload, persistTokens),
          };
        case "google_gmail_messages": {
          const messages = await this.googleService.getGmailMessages(account, invocation.payload?.maxResults || 10, persistTokens);
          if (Array.isArray(messages)) {
            this.recordRecentGmailMessages(userId, sessionId, messages
              .filter((message): message is NonNullable<typeof message> => Boolean(message))
              .map((message) => ({
                id: message.id,
                subject: message.subject || "",
                from: message.from || "",
                date: message.date,
              })));
            this.recordLastToolInvocation(userId, sessionId, invocation);
          }
          return {
            success: true,
            tool: toolName,
            data: messages,
          };
        }
        case "google_gmail_message": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          const messageId = invocation.payload?.messageId;

          switch (action) {
            case "delete":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.deleteMessage(account, messageId, persistTokens),
              };
            case "trash":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.trashMessage(account, messageId, persistTokens),
              };
            case "untrash":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.untrashMessage(account, messageId, persistTokens),
              };
            case "modify":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.modifyMessage(
                  account,
                  messageId,
                  invocation.payload?.addLabelIds || [],
                  invocation.payload?.removeLabelIds || [],
                  persistTokens
                ),
              };
            case "batch_delete":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.batchDeleteMessages(account, invocation.payload?.ids || [], persistTokens),
              };
            case "batch_modify":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.batchModifyMessages(
                  account,
                  invocation.payload?.ids || [],
                  invocation.payload?.addLabelIds || [],
                  invocation.payload?.removeLabelIds || [],
                  persistTokens
                ),
              };
            case "import":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.importMessage(
                  account,
                  invocation.payload?.raw || invocation.payload?.rawMessage || "",
                  invocation.payload?.threadId,
                  invocation.payload?.internalDateSource,
                  invocation.payload?.neverMarkSpam,
                  persistTokens
                ),
              };
            case "insert":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.insertMessage(
                  account,
                  invocation.payload?.raw || invocation.payload?.rawMessage || "",
                  invocation.payload?.threadId,
                  invocation.payload?.internalDateSource,
                  persistTokens
                ),
              };
            default: {
              const data = await this.googleService.getGmailMessageById(account, messageId, persistTokens);
              this.recordLastToolInvocation(userId, sessionId, invocation);
              return {
                success: true,
                tool: toolName,
                data,
              };
            }
          }
        }
        case "google_gmail_threads":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.listGmailThreads(account, invocation.payload?.maxResults || 10, persistTokens),
          };
        case "google_gmail_thread": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          const threadId = invocation.payload?.threadId;

          switch (action) {
            case "delete":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.deleteThread(account, threadId, persistTokens),
              };
            case "trash":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.trashThread(account, threadId, persistTokens),
              };
            case "untrash":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.untrashThread(account, threadId, persistTokens),
              };
            case "modify":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.modifyThread(
                  account,
                  threadId,
                  invocation.payload?.addLabelIds || [],
                  invocation.payload?.removeLabelIds || [],
                  persistTokens
                ),
              };
            default:
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getGmailThread(account, threadId, persistTokens),
              };
          }
        }
        case "google_gmail_drafts":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.listDrafts(account, invocation.payload?.maxResults || 10, persistTokens),
          };
        case "google_gmail_draft": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          const draftId = invocation.payload?.draftId;

          switch (action) {
            case "get":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getDraft(account, draftId, persistTokens),
              };
            case "delete":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.deleteDraft(account, draftId, persistTokens),
              };
            case "list":
            default:
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.listDrafts(account, invocation.payload?.maxResults || 10, persistTokens),
              };
          }
        }
        case "google_gmail_draft_create":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.createDraft(account, invocation.payload?.to, invocation.payload?.subject, invocation.payload?.body, persistTokens),
          };
        case "google_gmail_draft_update":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.updateDraft(account, invocation.payload?.draftId, invocation.payload?.to, invocation.payload?.subject, invocation.payload?.body, persistTokens),
          };
        case "google_gmail_draft_send":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.sendDraft(account, invocation.payload?.draftId, persistTokens),
          };
        case "google_gmail_send":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.sendEmail(account, invocation.payload?.to, invocation.payload?.subject, invocation.payload?.body, persistTokens),
          };
        case "google_gmail_label": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          const labelId = invocation.payload?.labelId;
          const labelPayload = invocation.payload?.label || invocation.payload;

          switch (action) {
            case "get":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getLabel(account, labelId, persistTokens),
              };
            case "create":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.createLabel(account, labelPayload, persistTokens),
              };
            case "update":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updateLabel(account, labelId, labelPayload, persistTokens),
              };
            case "patch":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.patchLabel(account, labelId, labelPayload, persistTokens),
              };
            case "delete":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.deleteLabel(account, labelId, persistTokens),
              };
            case "list":
            default:
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.listLabels(account, persistTokens),
              };
          }
        }
        case "google_gmail_user_profile":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getUserProfile(account, persistTokens),
          };
        case "google_gmail_watch": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          if (action === "stop") {
            return {
              success: true,
              tool: toolName,
              data: await this.googleService.stop(account, persistTokens),
            };
          }

          return {
            success: true,
            tool: toolName,
            data: await this.googleService.watch(account, invocation.payload?.topicName, invocation.payload?.labelIds, persistTokens),
          };
        }
        case "google_gmail_settings": {
          const action = invocation.payload?.action?.toString()?.trim().toLowerCase();
          const settingsPayload = invocation.payload?.settings || invocation.payload;

          switch (action) {
            case "get_auto_forwarding":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getAutoForwarding(account, persistTokens),
              };
            case "update_auto_forwarding":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updateAutoForwarding(account, settingsPayload, persistTokens),
              };
            case "get_imap":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getImap(account, persistTokens),
              };
            case "update_imap":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updateImap(account, settingsPayload, persistTokens),
              };
            case "get_language":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getLanguage(account, persistTokens),
              };
            case "update_language":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updateLanguage(account, settingsPayload, persistTokens),
              };
            case "get_pop":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getPop(account, persistTokens),
              };
            case "update_pop":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updatePop(account, settingsPayload, persistTokens),
              };
            case "get_vacation":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.getVacation(account, persistTokens),
              };
            case "update_vacation":
              return {
                success: true,
                tool: toolName,
                data: await this.googleService.updateVacation(account, settingsPayload, persistTokens),
              };
            default:
              return {
                success: false,
                tool: toolName,
                error: `Unsupported google_gmail_settings action: ${action}`,
              };
          }
        }
        case "google_gmail_attachment":
          return {
            success: true,
            tool: toolName,
            data: await this.googleService.getMessageAttachment(account, invocation.payload?.messageId, invocation.payload?.attachmentId, persistTokens),
          };
        default:
          return { success: false, tool: toolName, error: `Unsupported tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, tool: toolName, error: err?.message || "Tool execution failed." };
    }
  }

  private buildToolResultPrompt(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    invocation: ToolInvocation,
    toolResult: any
  ) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    return [
      `You are Aris, a persistent digital brain with a memory database.`,
      `You just executed a tool on behalf of the user.`,
      `Use the tool output below to answer the user's request directly.`,
      `If the tool succeeded, summarize the result and confirm the action.`,
      `If the tool failed, explain the failure and what the user should do next.`,
      `If the user's request asks for a specific detail and that detail is not present in the tool output, say the information is unavailable in the current tool output and ask the user where to look next if needed.`,
      `Output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not truncate the response. Include the full answer in final_answer, even if it is long.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail about the user, include it only inside memory_entries.`,
      "Recent conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Relevant memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "",
      "Tool invocation:",
      JSON.stringify(invocation, null, 2),
      "",
      "Tool result:",
      JSON.stringify(toolResult, null, 2),
      "",
      "Aris:"
    ].join("\n");
  }

  private buildMultiToolResultPrompt(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    const toolLines: string[] = [];
    for (const { invocation, result } of toolResults) {
      toolLines.push(`Tool invocation: ${JSON.stringify(invocation, null, 2)}`);
      toolLines.push(`Tool result: ${JSON.stringify(result, null, 2)}`);
      toolLines.push("");
    }

    return [
      `You are Aris, a persistent digital brain with a memory database.`,
      `You executed one or more tools on behalf of the user.`,
      `Use the tool outputs below to answer the user's request directly.`,
      `If the tools succeeded, summarize the results and confirm the action.`,
      `If any tool failed, explain the failure and what the user should do next.`,
      `If the user's request asks for a specific detail and that detail is not present in the tool outputs, say the information is not available rather than repeating unrelated content.`,
      `Output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not truncate the response. Include the full answer in final_answer, even if it is long.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail about the user, include it only inside memory_entries.`,
      "Recent conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Relevant memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "",
      ...toolLines,
      "Aris:"
    ].join("\n");
  }

  private normalizeToolLine(line: string): string {
    let normalized = line.trim();
    if (!normalized) return normalized;

    normalized = normalized.replace(/^[`*+\-\s>]+/, "").trim();
    normalized = normalized.replace(/[`]+$/g, "").trim();

    return normalized;
  }

  private extractJsonObject(text: string): any | undefined {
    const start = text.indexOf("{");
    if (start === -1) {
      return undefined;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  private parseToolJsonFromLine(line: string): any | undefined {
    const actionMatch = line.match(/Action\s*:\s*(.*)$/i);
    if (!actionMatch || !actionMatch[1]) {
      return this.extractJsonObject(line);
    }

    return this.extractJsonObject(actionMatch[1]);
  }

  private inferToolInvocations(userMessage: string, userId: number | undefined, sessionId: string | undefined, conversationHistory: string[]): ToolInvocation[] {
    const invocation = this.inferToolInvocation(userMessage, userId, sessionId, conversationHistory);
    if (invocation) {
      return [invocation];
    }

    const normalized = userMessage.trim().toLowerCase();
    const whatsappKeywords = /\b(whatsapp|wa|what?s app|messages from whatsapp|whatsapp messages|whatsapp summary|summarize whatsapp)\b/i;
    if (whatsappKeywords.test(normalized)) {
      return [{ tool: "whatsapp_summary", payload: {} }];
    }

    return [];
  }

  private inferToolInvocation(userMessage: string, userId: number | undefined, sessionId: string | undefined, conversationHistory: string[]): { tool: string; payload: any } | undefined {
    const normalized = userMessage.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    const detailKeywords = /\b(detail|details|say|read|content|contents|link|links|attachment|attachments|body|in detail|open|show|tell me|what does|what about|what is in)\b/i;
    const emailKeywords = /\b(email|gmail|inbox|mail|message|messages|subject|sender|from|american center|thread|conversation)\b/i;
    const calendarKeywords = /\b(calendar|appointment|meeting|schedule|event|events|availability|today|tomorrow|next week|next month|this week|next month)\b/i;
    const trafficKeywords = /\b(traffic|trafic|commute|congestion|route|ETA|estimated arrival|travel time|delay|jam|accident|roadwork|road work|gridlock|rush hour|leave now|leave at|when should I leave|how long will it take)\b/i;
    const searchKeywords = /\b(search|look up|find|research|what is|who is|where is|latest|current|news|today's|today|tomorrow)\b/i;
    const retryKeywords = /\b(try again|retry|again|repeat|re-run|rerun|run again)\b/i;
    const anaphoraRef = /\b(this|that|it|same|previous|recent|last|first|second|third|fourth|fifth|the one|the other|those|these)\b/i;

    const recentMessages = this.getRecentGmailMessages(userId, sessionId);
    const lastToolInvocation = this.getLastToolInvocation(userId, sessionId);

    if (retryKeywords.test(normalized) && lastToolInvocation) {
      return lastToolInvocation;
    }

    if (anaphoraRef.test(normalized) && lastToolInvocation) {
      return lastToolInvocation;
    }

    if (emailKeywords.test(normalized) || (anaphoraRef.test(normalized) && recentMessages.length)) {
      const americanCenterOnly = recentMessages.filter((message) => /american center/i.test(message.from + " " + message.subject));
      const candidates = /american center/i.test(normalized) && americanCenterOnly.length ? americanCenterOnly : recentMessages;

      if (candidates.length) {
        const ordinalMap: Record<string, number> = {
          first: 0,
          second: 1,
          third: 2,
          fourth: 3,
          fifth: 4,
          last: candidates.length - 1,
        };
        const ordinalMatch = normalized.match(/\b(first|second|third|fourth|fifth|last)\b/);
        if (ordinalMatch) {
          const index = ordinalMap[ordinalMatch[1]];
          if (index >= 0 && index < candidates.length) {
            return { tool: "google_gmail_message", payload: { messageId: candidates[index].id } };
          }
        }

        if (detailKeywords.test(normalized)) {
          return { tool: "google_gmail_message", payload: { messageId: candidates[0].id } };
        }

        if (emailKeywords.test(normalized)) {
          return { tool: "google_gmail_messages", payload: { maxResults: 10 } };
        }
      }

      if (lastToolInvocation && anaphoraRef.test(normalized)) {
        return lastToolInvocation;
      }

      if (emailKeywords.test(normalized)) {
        return { tool: "google_gmail_messages", payload: { maxResults: 10 } };
      }
    }

    if (calendarKeywords.test(normalized)) {
      return { tool: "google_calendar_events", payload: { maxResults: 10 } };
    }

    if (trafficKeywords.test(normalized)) {
      const routePattern = /(?:from\s+(.+?)\s+(?:to|towards?)\s+(.+)|to\s+(.+?)\s+from\s+(.+))/i;
      const incidentPattern = /\b(incident|incidents|accident|accidents|roadworks|road work|closure|closed road|construction|crash|collision|hazard|breakdown|delays?)\b/i;
      const flowPattern = /\b(flow|speed|travel time|traffic speed|congestion|jam|delay|ETA|estimated arrival|commute)\b/i;

      const routeMatch = normalized.match(routePattern);
      if (routeMatch) {
        const origin = routeMatch[1] || routeMatch[4];
        const destination = routeMatch[2] || routeMatch[3];
        if (origin && destination) {
          return { tool: "tomtom_route", payload: { origin: origin.trim(), destination: destination.trim(), query: normalized } };
        }
      }

      if (incidentPattern.test(normalized)) {
        return { tool: "tomtom_incidents", payload: { query: normalized } };
      }

      if (flowPattern.test(normalized)) {
        return { tool: "tomtom_flow", payload: { query: normalized } };
      }

      return { tool: "tomtom_traffic", payload: { query: normalized } };
    }

    if (searchKeywords.test(normalized)) {
      return { tool: "search", payload: { query: normalized } };
    }

    if (anaphoraRef.test(normalized) && lastToolInvocation) {
      return lastToolInvocation;
    }

    return undefined;
  }

  private buildToolChainPromptFromResults(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>,
    includeSearch: boolean
  ) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    const toolLines: string[] = [];
    for (const { invocation, result } of toolResults) {
      toolLines.push(`Tool invocation: ${JSON.stringify(invocation, null, 2)}`);
      toolLines.push(`Tool result: ${JSON.stringify(result, null, 2)}`);
      toolLines.push("");
    }

    const prompt = [
      `You are Aris, a dependable assistant that chains tools using a Thought-Action-Observation process.`,
      `Continue the chain until the user's request is fully resolved or until you must stop for approval on a destructive action.`,
      `For each step, output a Thought line describing your progress and then a single Action line with one valid JSON tool call.`,
      `If you are finished, output a final response as JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include markdown, code fences, or any extra text outside the expected format.`,
      ``,
      `Recent conversation history:`,
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      `Relevant memories:`,
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "",
      ...toolLines,
      "Aris:"
    ];

    if (includeSearch) {
      prompt.splice(5, 0,
        `If the user query requires an internet search, output exactly one tool call and nothing else:`,
        `  TOOL_SEARCH: <search query>`,
        `  or {"tool":"search","query":"<search query>"}`,
        ""
      );
    }

    return prompt.join("\n");
  }

  private async executeToolChain(
    userId: number | undefined,
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    sessionId: string,
    includeSearch: boolean
  ): Promise<ToolChainResult> {
    const toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }> = [];
    let prompt = this.buildToolChainPrompt(userMessage, userProfile, memories, conversationHistory, includeSearch);
    let lastModelReply = "";

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const modelResponse = await this.gemmaService.requestArisAdvice(prompt);
      lastModelReply = modelResponse.reply.trim();

      const invocation = this.parseToolInvocation(lastModelReply);
      if (!invocation) {
        return {
          status: "finished",
          reply: lastModelReply || "I completed the task.",
          memoryEntries: modelResponse.memoryEntries || [],
        };
      }

      const normalizedInvocation = this.normalizeToolInvocation(invocation);

      if (this.needsHumanApproval(normalizedInvocation)) {
        return {
          status: "awaiting_approval",
          reply: lastModelReply,
          memoryEntries: modelResponse.memoryEntries || [],
          pendingAction: normalizedInvocation,
        };
      }

      const result = await this.executeToolCall(userId, normalizedInvocation, sessionId);
      toolResults.push({ invocation: normalizedInvocation, result });

      if (!result.success) {
        const failurePrompt = this.buildMultiToolResultPrompt(userMessage, userProfile, memories, conversationHistory, toolResults);
        const finalPass = await this.gemmaService.requestArisAdvice(failurePrompt);
        return {
          status: "finished",
          reply: finalPass.reply,
          memoryEntries: finalPass.memoryEntries || [],
        };
      }

      prompt = this.buildToolChainPromptFromResults(userMessage, userProfile, memories, conversationHistory, toolResults, includeSearch);
    }

    return {
      status: "max_iterations_reached",
      reply: lastModelReply || "I reached the maximum number of tool chain iterations.",
      memoryEntries: [],
    };
  }

  private needsHumanApproval(invocation: ToolInvocation) {
    const normalizedTool = this.normalizeToolName(invocation.tool);
    const destructiveToolPatterns = [
      /^google_calendar_(create|update|delete|import|move|patch|clear_calendar|delete_calendar|update_acl|delete_acl)$/,
      /^google_gmail_(send|draft_send|draft_create|draft_update|draft_delete)$/,
    ];

    return destructiveToolPatterns.some((pattern) => pattern.test(normalizedTool));
  }

  private rewriteUserMessageForCoreference(userMessage: string, userId: number | undefined, sessionId: string | undefined, conversationHistory: string[]) {
    const normalized = userMessage.trim();
    if (!sessionId || !normalized) {
      return normalized;
    }

    const anaphoraRef = /\b(it|that|this|same|previous|recent|last|the one|the other|those|these|here)\b/i;
    if (!anaphoraRef.test(normalized)) {
      return normalized;
    }

    const lastToolInvocation = this.getLastToolInvocation(userId, sessionId);
    let prefix = "";

    if (lastToolInvocation?.tool?.startsWith("google_gmail")) {
      if (lastToolInvocation.tool === "google_gmail_messages") {
        prefix = "Regarding the recent Gmail messages, ";
      } else if (lastToolInvocation.tool === "google_gmail_message") {
        prefix = "Regarding the email details you asked about, ";
      } else if (lastToolInvocation.tool === "google_gmail_threads") {
        prefix = "Regarding the Gmail thread list, ";
      }
    } else if (lastToolInvocation?.tool?.startsWith("google_calendar")) {
      prefix = "Regarding the calendar results, ";
    }

    if (prefix) {
      return `${prefix}${normalized}`;
    }

    return normalized;
  }

  private async attemptUrlExtraction(searchResponse: SearchResponse): Promise<ExtractResponse | undefined> {
    const urls = (searchResponse.results || [])
      .slice(0, 2)
      .map((item) => item.url)
      .filter((url) => typeof url === "string" && url.length > 0);

    if (!urls.length) {
      return undefined;
    }

    const timeoutMs = Math.max(60000, urls.length * 25000 + 10000);

    try {
      return await this.extractClient.extract({
        urls,
        limit: urls.length,
        timeoutMs,
      });
    } catch (error) {
      info(`[arisService] failed to extract page content from urls=${urls.length}`);
      return undefined;
    }
  }

  private buildPrompt(userMessage: string, userProfile: UserProfileEntry[], memories: string[], conversationHistory: string[]) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    return [
      `You are Aris, a persistent digital brain with a memory database.`,
      `Use the user's profile, memories, and recent conversation history to answer with full context.`,
      `Resolve pronouns and follow-up references such as 'it', 'that', 'the previous one', 'the last message', and 'this email' using the conversation context.`,
      `Answer the user directly and concisely.`,
      `If answering directly, output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not truncate the response. Include the full answer in final_answer, even if it is long.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail about the user, include it only inside memory_entries.`,
      "Recent conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Relevant memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "Aris:"
    ].join("\n");
  }

  private buildToolChainPrompt(userMessage: string, userProfile: UserProfileEntry[], memories: string[], conversationHistory: string[], includeSearch: boolean) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    const toolInstructions = [
      `If the user asks to access or manage Google Calendar or Gmail, do not answer directly. Output exactly one valid tool call and nothing else.`,
      `If the user asks to check WhatsApp, do not answer directly. Output exactly one valid tool call and nothing else.`,
      `Resolve follow-up references and pronouns by using the user's recent conversation history and any remembered context.`,
      `Interpret implicit or indirect requests for email, calendar, or WhatsApp work and choose the best available tool automatically.`,
      `If the user refers to something from earlier in the conversation, use that context to infer the correct tool and target.`,
      `You may also use a search tool when the user asks for current web information, if search is enabled.`,
      `If you output a tool call, do not include any other text.`,
      `Do not explain, reason, or add any extra text when calling the tool.`,
      `Do not restate the user's question in the final answer.`,
      `Final output must be a single JSON object exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include extra text, comments, code fences, or instructions outside the JSON object.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      ""
    ];

    const searchInstructions = includeSearch
      ? [
          `If the user query requires an internet search, output exactly one tool call and nothing else:`,
          `  TOOL_SEARCH: <search query>`,
          `  or {"tool":"search","query":"<search query>"}`,
          ""
        ]
      : [];

    const trafficInstructions = [
      `If the user asks about traffic, commute time, ETA, route congestion, travel delay, traffic incidents, or best time to leave, output exactly one valid JSON object with a tomtom_* tool call and nothing else.`,
      `Do not answer directly in this pass when a traffic tool call is appropriate.`,
      `Use tomtom_route for route-based traffic planning, tomtom_flow for location-specific traffic speed, and tomtom_incidents for nearby incident reports.`,
      `Example: {"tool":"tomtom_route","origin":"123 Main St","destination":"456 Elm St","mode":"car"}`,
      `Example: {"tool":"tomtom_route","origin":"San Francisco, CA","destination":"SFO","departureTime":"2026-06-11T15:00:00Z"}`,
      `Example: {"tool":"tomtom_flow","query":"traffic near downtown Boston"}`,
      `Example: {"tool":"tomtom_incidents","query":"traffic incidents near Times Square"}`,
      `Example: {"tool":"tomtom_flow","location":"Palo Alto, CA"}`,
      ""
    ];

    const whatsappInstructions = [
      `If the user asks to check WhatsApp messages or summaries, output exactly one valid JSON object with the whatsapp_summary tool and nothing else.`,
      `Use only the exact supported tool name whatsapp_summary for WhatsApp requests.`,
      `If the user asks about WhatsApp and it is not available in the current tool output, say the information is unavailable and ask the user where to look next.`,
      `Example: {"tool":"whatsapp_summary"}`,
      ""
    ];

    const googleInstructions = [
      `If the user requests a Google Calendar or Gmail action, output exactly one valid JSON object with a google_* tool call and nothing else.`,
      `Use only the exact supported tool names listed below; do not invent or substitute alias names such as google_calendar_quickadd or google_gmail_messages_list.`,
      `Choose the most contextually appropriate tool for the user's query; if the question refers back to a previous email or message, it is correct to reuse the most recent Gmail tool invocation.`,
      `If a follow-up question asks for specific details and those details are only available from a previously viewed email, it is okay to use Google Gmail tools again.`,
      `Do not wrap tool arguments inside a nested "payload" object; pass arguments as top-level fields in the JSON object.`,
      `Do not output any explanation, internal reasoning, or instructions in this pass.`,
      `If the user requests a specific detail and it cannot be found in the available tool output, stop the chain and respond that the information is unavailable or ask the user where to look next.`,
      `When you are chaining tools, output a short progress summary in Thought before each Action.`,
      `Example: Thought: I am reviewing your inbox for urgent items and will add any relevant calendar tasks.`,
      `Example: {"tool":"google_gmail_messages","maxResults":10}`,
      `Use one of these valid objects:`,
      `  {"tool":"google_calendar_events","maxResults":10}`,
      `  {"tool":"google_calendar_events","maxResults":10,"timeMin":"2026-06-20T00:00:00Z","timeMax":"2026-06-20T23:59:59Z"}`,
      `  {"tool":"google_calendar_event","eventId":"..."}`,
      `  {"tool":"google_calendar_create","event":{...}}`,
      `  {"tool":"google_calendar_update","eventId":"...","event":{...}}`,
      `  {"tool":"google_calendar_delete","eventId":"..."}`,
      `  {"tool":"google_calendar_import","event":{...}}`,
      `  {"tool":"google_calendar_instances","eventId":"..."}`,
      `  {"tool":"google_calendar_move","eventId":"...","destinationCalendarId":"..."}`,
      `  {"tool":"google_calendar_patch","eventId":"...","event":{...}}`,
      `  {"tool":"google_calendar_quickAdd","text":"Lunch with Sam tomorrow at noon"}`,
      `  {"tool":"google_calendar_watch_events","calendarId":"primary","channel":{...}}`,
      `  {"tool":"google_calendar_list_calendar_list"}`,
      `  {"tool":"google_calendar_get_calendar","calendarId":"..."}`,
      `  {"tool":"google_calendar_create_calendar","calendar":{...}}`,
      `  {"tool":"google_calendar_update_calendar","calendarId":"...","calendar":{...}}`,
      `  {"tool":"google_calendar_patch_calendar","calendarId":"...","calendar":{...}}`,
      `  {"tool":"google_calendar_delete_calendar","calendarId":"..."}`,
      `  {"tool":"google_calendar_clear_calendar","calendarId":"..."}`,
      `  {"tool":"google_calendar_list_calendar_list"}`,
      `  {"tool":"google_calendar_get_calendar_list","calendarId":"..."}`,
      `  {"tool":"google_calendar_insert_calendar_list","calendarListEntry":{...}}`,
      `  {"tool":"google_calendar_update_calendar_list","calendarId":"...","calendarListEntry":{...}}`,
      `  {"tool":"google_calendar_patch_calendar_list","calendarId":"...","calendarListEntry":{...}}`,
      `  {"tool":"google_calendar_delete_calendar_list","calendarId":"..."}`,
      `  {"tool":"google_calendar_watch_calendar_list","channel":{...}}`,
      `  {"tool":"google_calendar_list_acl","calendarId":"..."}`,
      `  {"tool":"google_calendar_get_acl","calendarId":"...","ruleId":"..."}`,
      `  {"tool":"google_calendar_insert_acl","calendarId":"...","rule":{...}}`,
      `  {"tool":"google_calendar_update_acl","calendarId":"...","ruleId":"...","rule":{...}}`,
      `  {"tool":"google_calendar_patch_acl","calendarId":"...","ruleId":"...","rule":{...}}`,
      `  {"tool":"google_calendar_delete_acl","calendarId":"...","ruleId":"..."}`,
      `  {"tool":"google_calendar_watch_acl","calendarId":"...","channel":{...}}`,
      `  {"tool":"google_calendar_get_colors"}`,
      `  {"tool":"google_calendar_freebusy_query","requestBody":{...}}`,
      `  {"tool":"google_calendar_list_settings"}`,
      `  {"tool":"google_calendar_get_setting","setting":"..."}`,
      `  {"tool":"google_calendar_watch_settings","channel":{...}}`,
      `  {"tool":"google_calendar_stop_channel","channel":{...}}`,
      `  {"tool":"google_gmail_messages","maxResults":10}`,
      `  {"tool":"google_gmail_message","messageId":"..."}`,
      `  {"tool":"google_gmail_message","action":"delete","messageId":"..."}`,
      `  {"tool":"google_gmail_message","action":"modify","messageId":"...","addLabelIds":["..."],"removeLabelIds":["..."]}`,
      `  {"tool":"google_gmail_threads","maxResults":10}`,
      `  {"tool":"google_gmail_thread","threadId":"..."}`,
      `  {"tool":"google_gmail_thread","action":"modify","threadId":"...","addLabelIds":["..."],"removeLabelIds":["..."]}`,
      `  {"tool":"google_gmail_drafts","maxResults":10}`,
      `  {"tool":"google_gmail_draft","action":"get","draftId":"..."}`,
      `  {"tool":"google_gmail_draft_create","to":"...","subject":"...","body":"..."}`,
      `  {"tool":"google_gmail_draft_update","draftId":"...","to":"...","subject":"...","body":"..."}`,
      `  {"tool":"google_gmail_draft_send","draftId":"..."}`,
      `  {"tool":"google_gmail_send","to":"...","subject":"...","body":"..."}`,
      `  {"tool":"google_gmail_label","action":"list"}`,
      `  {"tool":"google_gmail_label","action":"create","label":{"name":"...","labelListVisibility":"labelShow","messageListVisibility":"show"}}`,
      `  {"tool":"google_gmail_settings","action":"get_auto_forwarding"}`,
      `  {"tool":"google_gmail_settings","action":"update_vacation","settings":{"enableAutoReply":true,"responseSubject":"Out of office","responseBodyPlainText":"..."}}`,
      `  {"tool":"google_gmail_watch","action":"watch","topicName":"projects/my-project/topics/my-topic","labelIds":["INBOX"]}`,
      `  {"tool":"google_gmail_attachment","messageId":"...","attachmentId":"..."}`,
      "If the user asks a follow-up question like 'what about it?', 'what does that one say?', or 'open the last message', resolve that request using recent conversation context.",
      ""
    ];

    return [
      `You are Aris, a dependable assistant that chains tools using a Thought-Action-Observation process.`,
      `Whenever you need information or context, think first and state it as Thought.`,
      `For each tool call, output a single Action line with valid JSON and nothing else on that line.`,
      `If you are still working through a chain, do not provide a final answer yet.`,
      `If you are finished, output a final response as JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Include a short progress sentence in every Thought when chaining tools, such as 'I now see your emails and am identifying tasks.'`,
      `If the user asked for destructive or sending actions, stop for approval instead of executing them automatically.`,
      `Do not include markdown, code fences, or any extra text outside the expected formats.`,
      `Use the user's conversation history and memories to resolve pronouns and implicit requests.`,
      ...toolInstructions,
      ...searchInstructions,
      ...trafficInstructions,
      ...whatsappInstructions,
      ...googleInstructions,
      "Recent conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Relevant memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "Aris:"
    ].join("\n");
  }

  private buildSearchResultPrompt(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    toolQuery: string,
    searchResponse: SearchResponse,
    extractResponse?: ExtractResponse
  ) {
    const results = searchResponse.results || [];
    const resultLines = results.map((item, index: number) =>
      `${index + 1}. [${item.engine}] ${item.title} - ${item.snippet} - ${item.url}`
    );

    const usefulExtracts = extractResponse?.results.filter((item) => !item.error && item.content && item.content.length > 200) || [];
    const extractLines: string[] = [];

    if (usefulExtracts.length) {
      extractLines.push("Extracted page content:");
      usefulExtracts.forEach((item, index) => {
        extractLines.push(`
Result ${index + 1}:
URL: ${item.url}
Title: ${item.title}
Snippet: ${item.snippet}
Content:
${this.truncateText(item.content, 1200)}`);
      });
    }

    const extractFallback = extractResponse && !usefulExtracts.length
      ? "No useful extracted page content was available. Use the search snippets above to answer."
      : "";

    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    return [
      `You are Aris, a persistent digital brain with a memory database.`,
      `Use the search results and extracted page content below to answer the user's question directly.`,
      `Use your memory and conversation history to personalize the response.`,
      `If answering directly, output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not truncate the response. Include the full answer in final_answer, even if it is long.`,
      `Do not restate the user's question in the final answer.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail about the user during this conversation, include it only inside memory_entries.`,
      `Do not reveal memory_entries metadata to the user or include it outside the JSON object.`,
      `Do not include tool syntax, reasoning, or planning in your final answer.`,
      `Answer directly with a well-organized response.`,
      "Recent conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `Search query: ${toolQuery}`,
      `Search results:`,
      ...resultLines,
      "",
      ...extractLines,
      extractFallback,
      "",
      `User: ${userMessage}`,
      "Aris:"
    ].filter(Boolean).join("\n");
  }

  private async extractSearchMemoryEntries(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    toolQuery: string,
    searchResponse: SearchResponse,
    extractResponse: ExtractResponse | undefined,
    arisReply: string
  ) {
    const prompt = this.buildSearchMemoryPrompt(
      userMessage,
      userProfile,
      memories,
      conversationHistory,
      toolQuery,
      searchResponse,
      extractResponse,
      arisReply
    );

    const memoryPass = await this.gemmaService.requestArisAdvice(prompt);
    return Array.from(new Set<string>((memoryPass.memoryEntries || []) as string[]));
  }

  private buildSearchMemoryPrompt(
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    toolQuery: string,
    searchResponse: SearchResponse,
    extractResponse: ExtractResponse | undefined,
    arisReply: string
  ) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];

    const searchLines = (searchResponse.results || []).map((item, index: number) =>
      `${index + 1}. [${item.engine}] ${item.title} - ${item.snippet} - ${item.url}`
    );

    const usefulExtracts = extractResponse?.results.filter((item) => !item.error && item.content && item.content.length > 200) || [];
    const extractLines: string[] = [];

    if (usefulExtracts.length) {
      extractLines.push("Extracted page content:");
      usefulExtracts.forEach((item, index) => {
        extractLines.push(`
Result ${index + 1}:
URL: ${item.url}
Title: ${item.title}
Snippet: ${item.snippet}
Content:
${this.truncateText(item.content, 1200)}`);
      });
    }

    const extractFallback = extractResponse && !usefulExtracts.length
      ? "No useful extracted page content was available. Use the search snippets above to answer if needed."
      : "";

    return [
      `You are Aris, a persistent digital brain with a memory database.`,
      `Review the user question, the search query, search results, and extracted page content below.`,
      `Output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `final_answer must be a short confirmation sentence, such as 'Search insights reviewed.'`,
      `memory_entries must be a JSON array of strings.`,
      `Store only distilled, useful, stable insights that would be valuable for future conversations.`,
      `Do not store raw search results, URLs, snippets, or transient details like current news unless they represent a stable fact or user preference.`,
      `If nothing useful should be saved, return memory_entries: [].`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not include the search results or extracted page content directly as memory entries.`,
      `Use the user's query and Aris's answer to decide whether any stable knowledge emerged from the search or extraction.`,
      `User question: ${userMessage}`,
      `Aris answer: ${arisReply}`,
      "Search query:",
      `  ${toolQuery}`,
      "Search results:",
      ...searchLines,
      "",
      ...extractLines,
      extractFallback,
      "",
      "Relevant conversation history:",
      ...conversationHistory.map((item) => `${item}`),
      "",
      ...profileLines,
      "Aris:"
    ].filter(Boolean).join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trim()}...`;
  }
}

