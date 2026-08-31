import { MemoryStore, UserProfileEntry } from "../db/memoryStore";
import { ContextStore } from "../db/contextStore";
import { getDatabasePool } from "../db/db";
import { GoogleAccountStore } from "../db/googleAccountStore";
import { GemmaService } from "./gemmaService";
import { SearchClient, SearchResponse } from "./searchClient";
import { ExtractClient, ExtractResponse } from "./extractClient";
import { GoogleService } from "./googleService";
import { WhatsappService } from "./whatsappService";
import { TomTomService } from "./tomtomService";
import { upsertContacts, getContactCount, searchContacts as searchContactsDb, getAllContacts, resolveNameToPhones, updateContactProfileSummary } from "../db/contactsStore";
import { info } from "../utils/logger";
import { LocationService } from "./locationService";
import { WeatherService } from "./weatherService";
import { SunbirdService } from "./sunbirdService";
import { NewsService } from "./newsService";

const searchToolEnabled = process.env.SEARCH_TOOL_ENABLED?.trim().toLowerCase() !== "false" &&
  process.env.SEARCH_TOOL_ENABLED?.trim() !== "0";

const searchEngineList = process.env.SEARCH_TOOL_ENGINES || "google,bing,duckduckgo,searx";

interface ChatInput {
  message: string;
  sessionId?: string;
  userId?: number;
  approvedAction?: ToolInvocation;
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
  status?: "finished" | "awaiting_approval" | "max_iterations_reached" | "error";
  pendingAction?: ToolInvocation;
}

export class ArisService {
  private searchClient = new SearchClient();
  private extractClient = new ExtractClient();
  private googleService = new GoogleService();
  private googleAccountStore = new GoogleAccountStore(getDatabasePool());
  private whatsappService = new WhatsappService(new GemmaService());

  private tomtomService = new TomTomService();
  private locationService = new LocationService();
  private weatherService = new WeatherService();
  private sunbirdService = new SunbirdService();
  private newsService = new NewsService();
  private readonly supportedToolNames = new Set<string>([
    "search",
    "whatsapp_summary",
    "whatsapp_conversation",
    "whatsapp_history",

    "tomtom_route",
    "tomtom_flow",
    "tomtom_incidents",
    "tomtom_traffic",
    "weather_geocoding",
    "weather_forecast",
    "weather_historical",
    "weather_air_quality",
    "weather_marine",
    "location_ip_details",
    "fetch_news",
    "google_calendar_events",
    "google_calendar_event",
    "google_calendar_create",
    "google_calendar_batch_create",
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
    "google_contacts_search",
    "google_contacts_sync",
    "contact_add_note",
    "sunbird_translate",
    // Goal tracking tools
    "goal_set",
    "goal_update_state",
    "goal_view_tasks",
    // WhatsApp outbox (send to self)
    "whatsapp_send",
    // Internet reading
    "url_read",
  ]);

  constructor(
    private memoryStore: MemoryStore,
    private contextStore: ContextStore,
    private gemmaService: GemmaService
  ) {}

  private getContextKey(userId: number | undefined, sessionId: string | undefined) {
    if (userId !== undefined && userId !== null) {
      return `user:${userId}`;
    }
    return sessionId ? `session:${sessionId}` : "unknown";
  }

  private async recordRecentGmailMessages(userId: number | undefined, sessionId: string | undefined, messages: Array<{ id: string; subject: string; from: string; date?: string }>) {
    const key = this.getContextKey(userId, sessionId);
    await this.contextStore.setRecentGmailMessages(key, messages);
  }

  private getRecentGmailMessages(userId: number | undefined, sessionId: string | undefined) {
    const key = this.getContextKey(userId, sessionId);
    return this.contextStore.getRecentGmailMessages(key);
  }

  private async recordLastToolInvocation(userId: number | undefined, sessionId: string | undefined, invocation: { tool: string; payload: any }) {
    const key = this.getContextKey(userId, sessionId);
    await this.contextStore.setLastToolInvocation(key, invocation);
  }

  private getLastToolInvocation(userId: number | undefined, sessionId: string | undefined) {
    const key = this.getContextKey(userId, sessionId);
    return this.contextStore.getLastToolInvocation(key);
  }

  /**
   * Sync contacts from Google People API into the local DB.
   * Runs automatically in the background on first chat if contacts table is empty.
   * Can also be triggered explicitly via the google_contacts_sync tool.
   */
  private syncContactsLock = new Set<number>();
  async ensureContactsSynced(userId: number, force = false): Promise<{ synced: number; skipped: boolean }> {
    // Debounce: only one sync per user at a time
    if (this.syncContactsLock.has(userId)) {
      return { synced: 0, skipped: true };
    }

    if (!force) {
      const count = await getContactCount(userId).catch(() => -1);
      if (count > 0) {
        return { synced: 0, skipped: true }; // already have contacts
      }
    }

    this.syncContactsLock.add(userId);
    try {
      const account = await this.googleAccountStore.getGoogleAccount(userId);
      if (!account) return { synced: 0, skipped: true };

      const persistTokens = async (tokens: any) => {
        await this.googleAccountStore.updateGoogleTokens(
          userId,
          tokens.access_token,
          tokens.refresh_token,
          tokens.expiry_date,
          tokens.scope
        );
      };

      info(`[arisService] Syncing contacts for userId=${userId}...`);
      const contacts = await this.googleService.syncAllContacts(account, persistTokens);
      const synced = await upsertContacts(userId, contacts);
      info(`[arisService] Contacts sync complete: ${synced} contacts upserted for userId=${userId}`);
      return { synced, skipped: false };
    } finally {
      this.syncContactsLock.delete(userId);
    }
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

  async handleChat(input: ChatInput, onProgress?: (msg: string) => void): Promise<ArisResponse> {
    const sessionId = input.sessionId || "default";
    info(`[arisService] handleChat start sessionId=${sessionId} query="${input.message}" searchToolEnabled=${searchToolEnabled}`);

    await this.contextStore.warmCache(this.getContextKey(input.userId, sessionId));

    // Auto-sync contacts on first use (when table is empty for this user)
    if (input.userId) {
      this.ensureContactsSynced(input.userId).catch(err =>
        console.error("[arisService] Background contacts sync failed:", err)
      );
    }

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

    const userProfilePromise = input.userId 
      ? this.memoryStore.getUserProfile(input.userId).catch(err => {
          console.error("[arisService] Failed to load user profile:", err);
          return [] as UserProfileEntry[];
        }) 
      : Promise.resolve([] as UserProfileEntry[]);
      
    // Optimization: If the user just says "hey", "hi", "thanks", we don't need 12 messages of history.
    // This dramatically shrinks the payload size to the LLM and speeds up inference.
    const isShortConversational = /^(hey|hi|hello|thanks|thank you|ok|okay|cool|got it)[\s\p{P}]*$/iu.test(input.message.trim());
    const historyLimit = isShortConversational ? 2 : 12;
    
    const conversationHistoryPromise = this.memoryStore.getRecentConversationHistory(input.userId, sessionId, historyLimit).catch(err => {
      console.error("[arisService] Failed to load conversation history:", err);
      return [] as string[];
    });

    const [userProfile, conversationHistory] = await Promise.all([userProfilePromise, conversationHistoryPromise]);
    const effectiveMessage = this.rewriteUserMessageForCoreference(input.message, input.userId, sessionId, conversationHistory);
    
    // Similarly, don't fetch heavy semantic memories for basic greetings
    let memoryContext: string[] = [];
    if (!isShortConversational) {
      try {
        memoryContext = await this.memoryStore.getRelevantMemories(input.userId, sessionId, effectiveMessage, 12);
      } catch (err) {
        console.error("[arisService] Failed to load relevant memories:", err);
      }
    }
      
    // Catch initial save errors so they don't block the chain
    Promise.all([saveUserMessagePromise, ...profileSavePromises, ...directMemorySavePromises]).catch(err => {
      console.error("[arisService] Background save failed for user message:", err);
    });

    let coachPersona = "encouraging";
    let goalState = {};
    let activeGoals: any[] = [];
    let pendingTasks: any[] = [];
    
    if (input.userId) {
      try {
        const { goalsStore } = await import("../db/goalsStore");
        const stateData = await goalsStore.getUserState(input.userId);
        coachPersona = stateData.coachPersona;
        goalState = stateData.state;
        activeGoals = await goalsStore.getActiveGoals(input.userId);
        pendingTasks = await goalsStore.getPendingTasks(input.userId);
      } catch (err) {
        console.error("[arisService] Failed to load goal state:", err);
      }
    }

    const toolChainResult = await this.executeToolChain(
      input.userId,
      effectiveMessage,
      userProfile,
      memoryContext,
      conversationHistory,
      sessionId,
      searchToolEnabled,
      coachPersona,
      goalState,
      activeGoals,
      pendingTasks,
      onProgress,
      input.approvedAction
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

    // Fire-and-forget saving to the database to prevent database timeouts 
    // from crashing the chat response stream
    Promise.all([saveArisReplyPromise, ...memoryStorePromises]).catch(err => {
      console.error("[arisService] Background save failed for chat reply/memories:", err);
    });

    return {
      arisReply,
      memoryUpdates: memoryEntries,
      status: toolChainResult.status,
      pendingAction: toolChainResult.pendingAction,
    };
  }

  private extractDirectMemoryEntries(userMessage: string): string[] {
    const normalized = userMessage.trim();
    const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
      [/((?:my name is|call me|you can call me)\s+)(.+?)(?:[.!?]|$)/i, (m) => `User's name is ${m[2].trim()}`],
      [/(?:my pronouns are|pronouns:?\s*)(he\/him|she\/her|they\/them|any|xe|ze|hir)/i, (m) => `User's pronouns are ${m[1].trim().toLowerCase()}`],
      [/(?:i prefer|i'd prefer|i like|i love|i enjoy)\s+(.+?)(?:[.!?]|$)/i, (m) => `User prefers ${m[1].trim()}`],
      [/(?:i am|i'm|i'm a|i am a|i am an)\s+(.+?)(?:[.!?]|$)/i, (m) => {
        const value = m[1].trim();
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
        const value = m[1].trim();
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
        const { tool, ...payload } = value;
        invocations.push({ tool: tool.trim(), payload });
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

    const fullTextJson = this.parseToolJsonFromLine(normalizedText);
    if (fullTextJson && typeof fullTextJson.tool === "string") {
      const { tool, ...payload } = fullTextJson;
      if (!invocations.some((inv) => inv.tool === tool.trim() && JSON.stringify(inv.payload) === JSON.stringify(payload))) {
        invocations.push({ tool: tool.trim(), payload });
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
        const { tool, ...payload } = parsedJson;
        if (!invocations.some((inv) => inv.tool === tool.trim() && JSON.stringify(inv.payload) === JSON.stringify(payload))) {
          invocations.push({ tool: tool.trim(), payload });
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
      google_calendar_batch_create_events: "google_calendar_batch_create",
      google_calendar_create_events: "google_calendar_batch_create",
      google_calendar_updateevent: "google_calendar_update",
      google_calendar_update_event: "google_calendar_update",
      google_calendar_deleteevent: "google_calendar_delete",
      google_calendar_delete_event: "google_calendar_delete",
      google_calendar_getevents: "google_calendar_events",
      google_calendar_get_events: "google_calendar_events",
      google_calendar_getevent: "google_calendar_event",
      google_calendar_get_event: "google_calendar_event",
      google_calendar_quickadd: "google_calendar_quickAdd",
      google_calendar_quick_add: "google_calendar_quickAdd",
      google_calendar_list: "google_calendar_list_calendar_list",
      google_calendar_get_calendar_list: "google_calendar_get_calendar_list",
      google_calendar_get_calendar: "google_calendar_get_calendar",
      google_calendar_create_calendar: "google_calendar_create_calendar",
      google_calendar_update_calendar: "google_calendar_update_calendar",
      google_calendar_patch_calendar: "google_calendar_patch_calendar",
      google_calendar_delete_calendar: "google_calendar_delete_calendar",
      google_calendar_clear: "google_calendar_clear_calendar",
      google_gmail_messageget: "google_gmail_message",
      google_gmail_message_get: "google_gmail_message",
      google_gmail_get_message: "google_gmail_message",
      google_gmail_getmessage: "google_gmail_message",
      google_gmail_get: "google_gmail_message",
      google_gmail_messages_list: "google_gmail_messages",
      google_gmail_list_messages: "google_gmail_messages",
      google_gmail_threadget: "google_gmail_thread",
      google_gmail_thread_get: "google_gmail_thread",
      google_gmail_get_thread: "google_gmail_thread",
      google_gmail_getthread: "google_gmail_thread",
      google_gmail_draftcreate: "google_gmail_draft_create",
      google_gmail_draft_create: "google_gmail_draft_create",
      google_gmail_draftupdate: "google_gmail_draft_update",
      google_gmail_draft_update: "google_gmail_draft_update",
      google_gmail_draftsend: "google_gmail_draft_send",
      google_gmail_draft_send: "google_gmail_draft_send",
      google_gmail_send_email: "google_gmail_send",
      google_gmail_sendmessage: "google_gmail_send",
      google_gmail_find_labels: "google_gmail_label",
      google_gmail_label_list: "google_gmail_label",
      google_gmail_settings_get: "google_gmail_settings",
      google_gmail_settings_update: "google_gmail_settings",
    };
    return aliases[normalized] || toolName.trim();
  }

  private normalizeToolPayload(payload: any): any {
    if (!payload || typeof payload !== "object") {
      return payload;
    }

    const flattened = { ...payload };

    // Flatten nested 'payload' or 'arguments' wrappers the model sometimes emits
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

    // Normalize common field aliases so handlers always see canonical names
    // 'id' -> 'messageId' for Gmail message fetching
    if (flattened.id !== undefined && flattened.messageId === undefined) {
      flattened.messageId = flattened.id;
      delete flattened.id;
    }
    // 'message_id' alias
    if (flattened.message_id !== undefined && flattened.messageId === undefined) {
      flattened.messageId = flattened.message_id;
      delete flattened.message_id;
    }
    // 'event_id' alias
    if (flattened.event_id !== undefined && flattened.eventId === undefined) {
      flattened.eventId = flattened.event_id;
      delete flattened.event_id;
    }
    // 'thread_id' alias
    if (flattened.thread_id !== undefined && flattened.threadId === undefined) {
      flattened.threadId = flattened.thread_id;
      delete flattened.thread_id;
    }
    // 'draft_id' alias
    if (flattened.draft_id !== undefined && flattened.draftId === undefined) {
      flattened.draftId = flattened.draft_id;
      delete flattened.draft_id;
    }

    // Normalize snake_case calendar field aliases
    if (flattened.time_min !== undefined && flattened.timeMin === undefined) {
      flattened.timeMin = flattened.time_min;
      delete flattened.time_min;
    }
    if (flattened.time_max !== undefined && flattened.timeMax === undefined) {
      flattened.timeMax = flattened.time_max;
      delete flattened.time_max;
    }
    if (flattened.calendar_id !== undefined && flattened.calendarId === undefined) {
      flattened.calendarId = flattened.calendar_id;
      delete flattened.calendar_id;
    }
    if (flattened.max_results !== undefined && flattened.maxResults === undefined) {
      flattened.maxResults = flattened.max_results;
      delete flattened.max_results;
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
      case "fetch_news":
        if (payload.topic && typeof payload.topic !== "string") {
          return "fetch_news requires an optional 'topic' string.";
        }
        break;
      case "google_calendar_quickAdd":
        if (!payload.text || typeof payload.text !== "string" || !payload.text.trim()) {
          return "google_calendar_quickAdd requires a top-level \"text\" field with the event description.";
        }
        break;
      case "google_calendar_create":
        if (!payload.event || typeof payload.event !== "object") {
          if (!payload.summary || !payload.start || !payload.end) {
            return "google_calendar_create requires either a top-level \"event\" object or summary/start/end fields.";
          }
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

    if (toolName === "fetch_news") {
      try {
        const topic = invocation.payload?.topic;
        const limit = invocation.payload?.limit || 5;
        const newsData = await this.newsService.getTopNews(topic, limit);
        return {
          success: true,
          tool: toolName,
          data: newsData,
        };
      } catch (e: any) {
        return { success: false, tool: toolName, error: e.message };
      }
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
        const data = await this.whatsappService.summarizePendingMessages(userId);
        const result = { success: true, tool: toolName, data };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "WhatsApp summary execution failed." };
      }
    }

    if (toolName === "whatsapp_conversation") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const contactName = invocation.payload?.contact || invocation.payload?.name || invocation.payload?.from || "";
        if (!contactName) return { success: false, tool: toolName, error: "whatsapp_conversation requires a 'contact' field with the person's name." };
        const { found, result: convResult } = await this.whatsappService.getConversationByContact(userId, contactName);
        if (!found) {
          return { success: true, tool: toolName, data: { summary: convResult as string, messages: [] } };
        }
        const conv = convResult as any;
        // Format into a readable summary for the LLM
        const summary = `Conversation with ${conv.contactName} (${conv.messages.length} messages):\n\n${conv.raw}`;
        const result = { success: true, tool: toolName, data: { summary, contactName: conv.contactName, messages: conv.messages } };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "WhatsApp conversation read failed." };
      }
    }

    if (toolName === "whatsapp_history") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const limit = invocation.payload?.limit || 100;
        const history = await this.whatsappService.getRecentHistory(userId, limit);
        const result = { success: true, tool: toolName, data: { summary: history.raw, messages: history.messages } };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "WhatsApp history read failed." };
      }
    }

    if (toolName === "goal_set") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { goalsStore } = await import("../db/goalsStore");
        const title = invocation.payload?.title;
        const desc = invocation.payload?.description;
        if (!title) return { success: false, tool: toolName, error: "goal_set requires a 'title' string." };
        const goal = await goalsStore.createGoal(userId, title, desc);
        return { success: true, tool: toolName, data: { summary: `Goal created successfully. ID: ${goal.id}`, goal } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to create goal." };
      }
    }

    if (toolName === "goal_update_state") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { goalsStore } = await import("../db/goalsStore");
        const updates = invocation.payload?.stateUpdates;
        if (!updates) return { success: false, tool: toolName, error: "goal_update_state requires a 'stateUpdates' JSON object." };
        const state = await goalsStore.updateUserState(userId, updates);
        return { success: true, tool: toolName, data: { summary: `State updated successfully.`, state: state.state } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to update state." };
      }
    }

    if (toolName === "goal_view_tasks") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { goalsStore } = await import("../db/goalsStore");
        const tasks = await goalsStore.getPendingTasks(userId);
        return { success: true, tool: toolName, data: { summary: `Found ${tasks.length} pending tasks.`, tasks } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to fetch tasks." };
      }
    }

    if (toolName === "whatsapp_send") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { getSelfJid } = await import("../db/whatsappAuthStore");
        const selfJid = await getSelfJid();
        if (!selfJid) return { success: false, tool: toolName, error: "WhatsApp account is not connected yet." };
        const body = invocation.payload?.message || invocation.payload?.body || invocation.payload?.text;
        if (!body) return { success: false, tool: toolName, error: "whatsapp_send requires a 'message' string." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        await whatsappOutboxStore.enqueue(selfJid, "text", String(body), undefined, undefined, userId);
        return { success: true, tool: toolName, data: { summary: "Message queued to your WhatsApp. It will be delivered on the next polling cycle." } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to queue WhatsApp message." };
      }
    }

    if (toolName === "url_read") {
      try {
        const raw = invocation.payload?.url || invocation.payload?.urls;
        if (!raw) return { success: false, tool: toolName, error: "url_read requires a 'url' string or 'urls' array." };
        const urls: string[] = Array.isArray(raw) ? raw : [String(raw)];
        const limitPerArticle: number = invocation.payload?.limit || 3000;

        const extracted = await this.extractClient.extract({ urls, limit: limitPerArticle });
        const readable = extracted.results.filter(r => !r.error && r.content && r.content.length > 100);
        if (readable.length === 0) {
          return { success: false, tool: toolName, error: "Could not extract readable content from the provided URL(s). The page may require JavaScript or block scraping." };
        }

        const resultSummary = readable.map(r => `**${r.title || r.url}**\n${r.content.slice(0, limitPerArticle)}`).join("\n\n---\n\n");
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return { success: true, tool: toolName, data: { summary: resultSummary, results: readable.map(r => ({ url: r.url, title: r.title, content: r.content.slice(0, limitPerArticle) })) } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to read URL." };
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

    if (toolName.startsWith("weather_") || toolName === "location_ip_details") {
      try {
        const payload = invocation.payload || {};
        let resultData: any;
        
        if (toolName === "location_ip_details") {
          resultData = await this.locationService.getCurrentLocation(true);
        } else if (toolName === "weather_geocoding") {
          resultData = await this.weatherService.geocode(payload.name, payload.count);
        } else if (toolName === "weather_forecast") {
          resultData = await this.weatherService.getForecast(payload.lat, payload.lon, payload.current, payload.hourly, payload.daily);
        } else if (toolName === "weather_historical") {
          resultData = await this.weatherService.getHistorical(payload.lat, payload.lon, payload.start_date, payload.end_date, payload.hourly, payload.daily);
        } else if (toolName === "weather_air_quality") {
          resultData = await this.weatherService.getAirQuality(payload.lat, payload.lon, payload.hourly);
        } else if (toolName === "weather_marine") {
          resultData = await this.weatherService.getMarine(payload.lat, payload.lon, payload.hourly);
        }

        const result = { success: true, tool: toolName, data: resultData };
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return result;
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Weather/Location execution failed." };
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
        case "google_calendar_create": {
          const eventPayload = invocation.payload?.event || invocation.payload;
          
          // Programmatic Dedup Check
          const startStr = eventPayload?.start?.dateTime || eventPayload?.start?.date;
          if (startStr) {
            const startOfDay = new Date(startStr);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(startStr);
            endOfDay.setHours(23, 59, 59, 999);
            
            const existingEvents = await this.googleService.getCalendarEvents(
              account,
              50,
              startOfDay.toISOString(),
              endOfDay.toISOString(),
              persistTokens
            );
            
            const reqSummary = (eventPayload.summary || "").toLowerCase().trim();
            const duplicate = existingEvents.find((e: any) => 
              (e.summary || "").toLowerCase().trim() === reqSummary ||
              (e.summary || "").toLowerCase().trim().includes(reqSummary) ||
              reqSummary.includes((e.summary || "").toLowerCase().trim())
            );
            
            if (duplicate && reqSummary.length > 0) {
              return {
                success: true,
                tool: toolName,
                data: { message: "Event skipped (already exists on this date)", existingEvent: duplicate }
              };
            }
          }

          return {
            success: true,
            tool: toolName,
            data: await this.googleService.createCalendarEvent(account, eventPayload, persistTokens),
          };
        }
        case "google_calendar_batch_create": {
          const events: any[] = Array.isArray(invocation.payload?.events)
            ? invocation.payload.events
            : Array.isArray(invocation.payload)
              ? invocation.payload
              : [];
          if (events.length === 0) {
            return { success: false, tool: toolName, error: "google_calendar_batch_create requires an 'events' array." };
          }
          
          const createdEvents = [];
          const skippedEvents = [];

          for (const ev of events) {
            let isDuplicate = false;
            const startStr = ev.start?.dateTime || ev.start?.date;
            if (startStr) {
              const startOfDay = new Date(startStr);
              startOfDay.setHours(0, 0, 0, 0);
              const endOfDay = new Date(startStr);
              endOfDay.setHours(23, 59, 59, 999);
              
              const existingEvents = await this.googleService.getCalendarEvents(account, 50, startOfDay.toISOString(), endOfDay.toISOString(), persistTokens);
              const reqSummary = (ev.summary || "").toLowerCase().trim();
              
              const duplicate = existingEvents.find((e: any) => 
                (e.summary || "").toLowerCase().trim() === reqSummary ||
                (e.summary || "").toLowerCase().trim().includes(reqSummary) ||
                reqSummary.includes((e.summary || "").toLowerCase().trim())
              );
              
              if (duplicate && reqSummary.length > 0) {
                isDuplicate = true;
                skippedEvents.push({ summary: ev.summary, reason: "Already exists" });
              }
            }

            if (!isDuplicate) {
              const created = await this.googleService.createCalendarEvent(account, ev, persistTokens);
              createdEvents.push(created);
            }
          }

          return {
            success: true,
            tool: toolName,
            data: { created: createdEvents.length, skipped: skippedEvents.length, events: createdEvents, skippedEvents },
          };
        }
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
        case "google_contacts_search": {
          const query = invocation.payload?.query as string | undefined;
          if (query) {
            // Search local DB first (fast)
            const localResults = await searchContactsDb(userId!, query).catch(() => []);
            if (localResults.length > 0) {
              return { success: true, tool: toolName, data: localResults };
            }
          }
          // Fall back to live Google People API search
          const liveResults = await this.googleService.searchContactsByQuery(account, query, persistTokens);
          return { success: true, tool: toolName, data: liveResults };
        }
        case "contact_add_note": {
          if (!userId) {
            return { success: false, tool: toolName, error: "No user ID." };
          }
          const contactName = invocation.payload?.name?.trim();
          const note = invocation.payload?.note?.trim();
          if (!contactName || !note) {
            return { success: false, tool: toolName, error: "Missing name or note." };
          }
          
          const resolved = await resolveNameToPhones(userId, contactName);
          if (!resolved) {
            return { success: false, tool: toolName, error: `Could not find contact '${contactName}'` };
          }

          const currentSummary = resolved.profileSummary || "";
          
          // Synthesize new summary
          const condensationPrompt = [
            `You are a profile synthesis assistant.`,
            `Update the existing profile summary with the new fact(s).`,
            `Keep the summary concise (max 2-3 paragraphs) and written in third-person.`,
            `If the new fact contradicts an old fact (e.g. changed jobs), silently drop the old fact and use the new one.`,
            `Do NOT add filler text. Just return the raw text of the new summary.`,
            `Current Profile for ${resolved.displayName}:`,
            currentSummary ? currentSummary : "(No profile exists yet)",
            ``,
            `New Fact(s) to add:`,
            note
          ].join('\n');

          const synthesisResult = await this.gemmaService.requestArisAdvice(condensationPrompt);
          const newSummary = synthesisResult.reply.trim();

          await updateContactProfileSummary(userId, resolved.contactId, newSummary);
          return { 
            success: true, 
            tool: toolName, 
            data: { message: `Profile updated for ${resolved.displayName}.`, newSummary } 
          };
        }
        case "sunbird_translate": {
          const source = invocation.payload?.source?.toString()?.trim();
          const target = invocation.payload?.target?.toString()?.trim();
          const text = invocation.payload?.text?.toString()?.trim();
          if (!source || !target || !text) {
            return { success: false, tool: toolName, error: "Missing source, target, or text for translation." };
          }
          const translatedText = await this.sunbirdService.translateText({
            source_language: source,
            target_language: target,
            text,
          });
          return { success: true, tool: toolName, data: { translated_text: translatedText } };
        }
        case "google_contacts_sync": {
          if (!userId) {
            return { success: false, tool: toolName, error: "No user ID — cannot sync contacts." };
          }
          const force = invocation.payload?.force === true;
          const result = await this.ensureContactsSynced(userId, force);
          return {
            success: true,
            tool: toolName,
            data: result.skipped
              ? { message: "Contacts are already up to date.", synced: 0 }
              : { message: `Contacts synced successfully.`, synced: result.synced },
          };
        }
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
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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
    const actionMatch = line.match(/Action\s*:\s*([\s\S]*)/i);
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
    
    // Smart WhatsApp routing: detect if user is asking about a SPECIFIC contact
    // If so, use whatsapp_conversation to read from history instead of running the service
    const contactConvoMatch = normalized.match(
      /(?:what did|what(?:'s| was)? said|messages? from|read(?:\s+(?:my|the))? (?:chat|conversation|messages?) (?:with|from)|show (?:me )?(?:messages?|chat|conversation) (?:from|with)|check (?:messages?|whatsapp) (?:from|with))\s+([a-z][a-z\s'-]{1,40})(?:\s+(?:on whatsapp|(?:say|said|send|sent|write|wrote)))?/i
    );
    if (contactConvoMatch) {
      const contactName = contactConvoMatch[1].trim();
      return [{ tool: "whatsapp_conversation", payload: { contact: contactName } }];
    }
    
    // Also catch simpler patterns: "Grace's whatsapp", "grace whatsapp messages", "grace on whatsapp"
    const simpleContactMatch = normalized.match(
      /^([a-z][a-z\s'-]{1,30})(?:'s)?\s+(?:whatsapp|message|messages|chat|texts?)(?:\s+messages?)?$/i
    );
    if (simpleContactMatch) {
      return [{ tool: "whatsapp_conversation", payload: { contact: simpleContactMatch[1].trim() } }];
    }

    // History read — no specific contact, but not asking for new messages
    const historyKeywords = /\b(recent whatsapp|whatsapp history|past messages|all messages|show (?:all|recent) whatsapp|what(?:'s| was| has) (?:been )?(going on|happening) (?:on )?whatsapp)\b/i;
    if (historyKeywords.test(normalized)) {
      return [{ tool: "whatsapp_history", payload: {} }];
    }

    // Default: new/pending message summary (runs the WhatsApp service if needed)
    const whatsappKeywords = /\b(whatsapp|wa|what.?s app|messages from whatsapp|whatsapp messages|whatsapp summary|summarize whatsapp|new messages|any messages|new whatsapp|unread)\b/i;
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
      `You are Aris, an extremely conversational digital friend, an expert advisor, and a life coach. You chain tools using a Thought-Action-Observation process.`,
      `When you provide your final answer, your tone should be warm, friendly, insightful, and highly conversational.`,
      `Continue the chain until the user's request is fully resolved or until you must stop for approval on a destructive action.`,
      `For each step, output a Thought line describing your progress and then a single Action line with one valid JSON tool call.`,
      `If you are finished, output a final response as JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `If the previous tool result already satisfies the user's request, do not invoke any further tools.`,
      `If the most recent tool invocation was {"tool":"whatsapp_summary"}, use the returned summary directly as your final answer unless additional tool data is needed.`,
      `CRITICAL DEDUPLICATION RULE: Before creating ANY calendar event, you MUST first call 'google_calendar_events' to fetch existing events for the relevant time range. Compare the event summaries. If an event with the same or very similar title already exists on the calendar for the same date, you MUST skip creating it and report it as already existing. Only call 'google_calendar_create' for events that do NOT already exist. If you are adding multiple events, check ALL first, skip duplicates, and only create genuinely new ones.`,
      `Do not include markdown, code fences, or any extra text outside the expected format.`,
      ``,
      `Recent conversation history:`,
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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

  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
        }
      }
    }
    return matrix[b.length][a.length];
  }

  private hasFuzzyMatch(words: string[], keywords: string[], maxDistance: number = 1): boolean {
    for (const word of words) {
      if (word.length < 3) {
        if (keywords.includes(word)) return true;
        continue;
      }
      for (const keyword of keywords) {
        if (keyword.length < 3) {
          if (word === keyword) return true;
          continue;
        }
        // Allow higher distance for longer words
        const allowedDistance = keyword.length > 5 ? maxDistance + 1 : maxDistance;
        if (Math.abs(word.length - keyword.length) > allowedDistance) continue;
        if (this.levenshteinDistance(word, keyword) <= allowedDistance) {
          return true;
        }
      }
    }
    return false;
  }

  private determineToolCategories(userMessage: string, conversationHistory: string[]): Set<string> {
    const categories = new Set<string>();
    const msgOnly = userMessage.toLowerCase().trim();
    const words = msgOnly.split(/[^a-z0-9]+/);
    const textToAnalyze = [userMessage, ...conversationHistory].join(" ").toLowerCase();
    const allWords = textToAnalyze.split(/[^a-z0-9]+/);

    // --- Conversational / emotional intent detection ---
    // If the message is clearly casual chat, emotional venting, small talk, or
    // a simple greeting, return an empty set so Aris responds conversationally.
    const conversationalPatterns = [
      /^(hey|hi|hello|sup|yo|howdy|hiya)[\s!?.,]*$/i,
      /^(thanks|thank you|thx|ty)[\s!?.,]*$/i,
      /^(ok|okay|got it|sure|cool|alright|yep|nope)[\s!?.,]*$/i,
      /^i(?:'?m| am) (just )?(bored|tired|sad|happy|excited|stressed|anxious|lonely|down|upset|fine|good|great|okay)[\s!?.,]*/i,
      /^(i feel|feeling|just feeling|i'm feeling)[\s.,]*/i,
      /^(lol|lmao|haha|hehe|xD)[\s!?.,]*$/i,
      /^(good morning|good night|good evening|good afternoon)[\s!?.,]*$/i,
      /^(how are you|how's it going|what's up|wassup)[\s!?.,]*$/i,
      /^(nothing|not much|same old|just chilling|just relaxing)[\s!?.,]*/i,
    ];

    const isConversational = conversationalPatterns.some(p => p.test(msgOnly));
    if (isConversational) {
      // Return empty set — Aris will respond directly without any tools
      return categories;
    }

    if (this.hasFuzzyMatch(allWords, ["brief", "summary", "overview", "update", "happening", "catch"])) {
      categories.add("briefing");
      categories.add("gmail");
      categories.add("calendar");
      categories.add("whatsapp");
      categories.add("traffic");
      categories.add("weather");
    }

    if (this.hasFuzzyMatch(allWords, ["email", "gmail", "inbox", "message", "draft", "send", "mail"])) categories.add("gmail");
    if (this.hasFuzzyMatch(allWords, ["contact", "person", "phone", "number", "address", "profile"])) categories.add("contact");
    if (this.hasFuzzyMatch(allWords, ["calendar", "schedule", "meeting", "event", "appointment", "invite"])) categories.add("calendar");
    if (this.hasFuzzyMatch(allWords, ["whatsapp", "wa", "chat"])) categories.add("whatsapp");
    if (this.hasFuzzyMatch(allWords, ["traffic", "route", "commute", "drive", "directions", "eta"])) categories.add("traffic");
    if (this.hasFuzzyMatch(allWords, ["weather", "forecast", "air", "quality", "marine", "ocean", "rain", "temperature", "temp", "cold", "hot"])) categories.add("weather");

    // Only fall back to search+generic tools if no specific category was detected
    // and this is clearly NOT a casual conversational message.
    if (categories.size === 0) {
      categories.add("search");
    }

    return categories;
  }

  private async executeToolChain(
    userId: number | undefined,
    userMessage: string,
    userProfile: UserProfileEntry[],
    memories: string[],
    conversationHistory: string[],
    sessionId: string,
    includeSearch: boolean,
    coachPersona: string,
    goalState: any,
    activeGoals: any[],
    pendingTasks: any[],
    onProgress?: (msg: string) => void,
    approvedAction?: ToolInvocation
  ): Promise<ToolChainResult> {
    const toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }> = [];
    
    // Execute the approved action and seed toolResults, then fall through into
    // the main chain loop so the model can continue with remaining tasks.
    if (approvedAction) {
      onProgress?.(`Executing ${approvedAction.tool.replace(/_/g, ' ')}...`);
      const result = await this.executeToolCall(userId, approvedAction, sessionId);
      toolResults.push({ invocation: approvedAction, result });
    }
    const activeCategories = this.determineToolCategories(userMessage, conversationHistory);
    if (includeSearch) activeCategories.add("search");
    
    // Inject Live Location Awareness
    const locationData = await this.locationService.getCurrentLocation();
    const locationContext = this.locationService.formatLocationContext(locationData);
    
    // If we have seeded tool results (from an approved action), build a focused
    // post-approval continuation prompt that strips old conversation history
    // to prevent the model from getting confused by stale failed tool attempts.
    let prompt: string;
    if (toolResults.length > 0) {
      const lastResult = toolResults[toolResults.length - 1];
      const toolName = lastResult.invocation.tool;
      const wasSuccess = lastResult.result.success;
      const approvalNote = wasSuccess
        ? `You just successfully executed '${toolName}'. The action completed.`
        : `Execution of '${toolName}' failed: ${lastResult.result.error}`;
      prompt = [
        `You are Aris, an extremely conversational digital friend, an expert advisor, and a life coach. ${approvalNote}`,
        locationContext,
        `Original user request: ${userMessage}`,
        ``,
        `Tool results so far:`,
        ...toolResults.map(tr => `- ${tr.invocation.tool}: ${tr.result.success ? 'SUCCESS' : 'FAILED'}`),
        ``,
        `If there are remaining tasks from the original request that are not yet done, continue with the next step using a single JSON tool call.`,
        `If everything is done, output your final summary using ONLY this exact JSON format: {"final_answer":"<your message>","memory_entries":[]}. Do not output raw text.`,
        `Do NOT repeat or re-fetch data that was already retrieved. Do NOT invent tool names.`,
        ``,
        `Aris:`,
        `Thought:`
      ].join('\n');
    } else {
      prompt = this.buildToolChainPrompt(userMessage, userProfile, memories, conversationHistory, activeCategories, locationContext, coachPersona, goalState, activeGoals, pendingTasks);
    }
    let lastModelReply = "";

    const MAX_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {

      onProgress?.("Thinking...");
      const modelResponse = await this.gemmaService.requestArisAdvice(prompt);
      lastModelReply = modelResponse.reply.trim();

      const invocations = this.parseToolInvocations(lastModelReply);
      if (!invocations || invocations.length === 0) {
        // Detect "thinking wall" — model outputting raw reasoning instead of final_answer JSON
        // If reply is very long and has no final_answer structure, it's stuck in a loop.
        // We increase this to 4000 to allow sufficient reasoning over large datasets (like calendar lists).
        const hasFinalAnswer = modelResponse.isFinalAnswer || lastModelReply.includes('"final_answer"') || lastModelReply.includes("final_answer");
        const isThinkingWall = !hasFinalAnswer && lastModelReply.length > 4000;

        if (isThinkingWall) {
          // Inject a recovery nudge — tell the model to stop reasoning and give its answer
          const completedTools = toolResults
            .filter(r => r.result.success && r.invocation.tool !== '_system')
            .map(r => r.invocation.tool)
            .join(', ');
          
          prompt = [
            `You are Aris. You have been completing tasks. Stop all internal reasoning now.`,
            completedTools ? `You have successfully executed: ${completedTools}.` : `No tools were needed.`,
            `User's original request: ${userMessage}`,
            `Output ONLY a final answer in this exact JSON format and nothing else:`,
            `{"final_answer":"<your concise reply to the user>","memory_entries":[]}`,
          ].join('\n');
          continue;
        }

        return {
          status: "finished",
          reply: lastModelReply || "I completed the task.",
          memoryEntries: modelResponse.memoryEntries || [],
        };
      }

      const normalizedInvocations = invocations.map((inv) => this.normalizeToolInvocation(inv));

      const pendingIndex = normalizedInvocations.findIndex((inv) => this.needsHumanApproval(inv));
      if (pendingIndex !== -1) {
        return {
          status: "awaiting_approval",
          reply: lastModelReply,
          memoryEntries: modelResponse.memoryEntries || [],
          pendingAction: normalizedInvocations[pendingIndex],
        };
      }

      const results = await Promise.all(
        normalizedInvocations.map((inv) => {
          let toolName = "tool";
          if (inv.tool.includes("gmail")) toolName = "email";
          else if (inv.tool.includes("calendar")) toolName = "calendar";
          else if (inv.tool.includes("search")) toolName = "the web";
          onProgress?.(`Checking ${toolName}...`);
          return this.executeToolCall(userId, inv, sessionId);
        })
      );

      for (let i = 0; i < normalizedInvocations.length; i++) {
        toolResults.push({ invocation: normalizedInvocations[i], result: results[i] });
      }

      const currentFailures = results.map((r, i) => r.success ? null : { inv: normalizedInvocations[i], err: r.error }).filter(Boolean) as Array<{inv: any, err: any}>;
      let stuckCount = 0;
      for (const fail of currentFailures) {
         const previousIdenticalFailure = toolResults.slice(0, -normalizedInvocations.length).find(
           (tr) => !tr.result.success && 
                   tr.invocation.tool === fail.inv.tool && 
                   JSON.stringify(tr.invocation.payload) === JSON.stringify(fail.inv.payload)
         );
         if (previousIdenticalFailure) {
           stuckCount++;
         }
      }
      // Only bail after 2 consecutive stuck cycles; let the model try to self-correct once
      if (stuckCount > 0 && stuckCount === currentFailures.length && currentFailures.length > 0) {
        // Inject the error as an observation so the model can recover
        const errorFeedback = currentFailures.map(f => `Tool ${f.inv.tool} failed repeatedly: ${f.err || 'unknown error'}. Try a different approach or use different parameters.`).join(' ');
        toolResults.push({
          invocation: { tool: "_system", payload: {} },
          result: { success: false, tool: "_system", error: errorFeedback }
        });
      }

      // --- Detect repeated identical tool calls (success loop prevention) ---
      // If the model just called the same tool with the same payload that already
      // succeeded earlier in this chain, it's stuck. Force a final_answer instead.
      const repeatedSuccessfulCall = normalizedInvocations.find(inv => {
        const previousSuccessful = toolResults
          .slice(0, toolResults.length - normalizedInvocations.length)
          .find(tr => tr.result.success && tr.invocation.tool === inv.tool &&
                      JSON.stringify(tr.invocation.payload) === JSON.stringify(inv.payload));
        return !!previousSuccessful;
      });

      if (repeatedSuccessfulCall) {
        // Force a synthesis pass with all data collected so far
        const dataLines = toolResults
          .filter(tr => tr.result.success && tr.invocation.tool !== '_system')
          .map(tr => {
            const rawData = tr.result.data;
            const dataSummary = rawData?.summary ?? rawData?.text ?? JSON.stringify(rawData).slice(0, 3000);
            return `--- Result from ${tr.invocation.tool} ---\n${dataSummary}`;
          });
        const forceSynthesisPrompt = [
          `You are Aris. You have already collected all the data you need. Do NOT call any more tools.`,
          `User's original request: "${userMessage}"`,
          ``,
          `Data you collected:`,
          ...dataLines,
          ``,
          `Now write a warm, detailed, conversational response to the user's request.`,
          `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
          `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
          `{"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
        ].join('\n');
        prompt = forceSynthesisPrompt;
        continue;
      }

      const hasFailure = results.some((r) => !r.success);



      // Build continuation prompt with actual tool data embedded
      const successResults = toolResults.filter(tr => tr.result.success && tr.invocation.tool !== '_system');
      const dataLines = successResults.map(tr => {
        const rawData = tr.result.data;
        const dataSummary = rawData?.summary ?? rawData?.text ?? JSON.stringify(rawData).slice(0, 4000);
        return `--- Data from ${tr.invocation.tool} ---\n${dataSummary}`;
      });

      const failureLines = toolResults
        .filter(tr => !tr.result.success && tr.invocation.tool !== '_system')
        .map(tr => `--- ${tr.invocation.tool} FAILED: ${tr.result.error} ---`);

      if (hasFailure) {
        prompt = [
          `You are Aris. A tool call failed. Adapt and continue.`,
          `User's request: "${userMessage}"`,
          ...failureLines,
          ...dataLines,
          `If you can try a different tool or approach, output a JSON tool call.`,
          `If you have enough data to answer (or no other approach), write a final answer.`,
          `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
          `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
          `If calling a tool: {"tool": "tool_name", "param1": "value"}`,
          `If answering the user: {"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
        ].join('\n');
        continue;
      }

      prompt = [
        `You are Aris. You just completed a tool call and retrieved the following data.`,
        `User's original request: "${userMessage}"`,
        locationContext,
        ``,
        ...dataLines,
        ``,
        `If you need more information to fully answer the request, output a JSON object to call the next tool.`,
        `If you have gathered all necessary information, write a warm, detailed, conversational response to the user.`,
        `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
        `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
        `If calling a tool: {"tool": "tool_name", "param1": "value"}`,
        `If answering the user: {"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
      ].join('\n');
    }

    // Max iterations reached — synthesize answer from whatever data was collected
    const collectedData = toolResults
      .filter(tr => tr.result.success && tr.invocation.tool !== '_system')
      .map(tr => {
        const rawData = tr.result.data;
        const dataSummary = rawData?.summary ?? rawData?.text ?? JSON.stringify(rawData).slice(0, 3000);
        return `--- ${tr.invocation.tool} ---\n${dataSummary}`;
      });

    if (collectedData.length > 0) {
      // We have data — make one final synthesis call
      const finalSynthesisPrompt = [
        `You are Aris. Synthesize the following data into a warm, detailed response for the user.`,
        `User's request: "${userMessage}"`,
        ``,
        ...collectedData,
        ``,
        `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
        `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
        `{"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
      ].join('\n');
      const finalResponse = await this.gemmaService.requestArisAdvice(finalSynthesisPrompt);
      return {
        status: "finished",
        reply: finalResponse.reply || "I reached the limit but gathered some data.",
        memoryEntries: finalResponse.memoryEntries || [],
      };
    }

    return {
      status: "max_iterations_reached",
      reply: "I hit my processing limit on that one. Could you try rephrasing or narrowing the request?",
      memoryEntries: [],
    };
  }

  private needsHumanApproval(invocation: ToolInvocation) {
    const normalizedTool = this.normalizeToolName(invocation.tool);
    const destructiveToolPatterns = [
      /^google_calendar_(create|batch_create|update|delete|import|move|patch|clear_calendar|delete_calendar|update_acl|delete_acl)$/,
      /^google_gmail_(send|draft_send)$/,
    ];

    if (destructiveToolPatterns.some((pattern) => pattern.test(normalizedTool))) {
      return true;
    }

    if (normalizedTool === "google_gmail_message") {
      const action = String(invocation.payload?.action || "").toLowerCase();
      return [
        "delete",
        "trash",
        "untrash",
        "modify",
        "batch_delete",
        "batch_modify",
        "import",
        "insert",
      ].includes(action);
    }

    if (normalizedTool === "google_gmail_draft") {
      const action = String(invocation.payload?.action || "").toLowerCase();
      return action === "delete";
    }

    return false;
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

  private buildPrompt(userMessage: string, userProfile: UserProfileEntry[], memories: string[], conversationHistory: string[], locationContext: string) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];
    const currentDateTime = new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric", timeZoneName: "short" });

    return [
      `You are Aris — a warm, deeply empathetic digital companion. You are a trusted friend, life coach, emotional comforter, and expert advisor all in one.`,
      `You have a persistent digital brain with a memory database.`,
      `Current Date and Time: ${currentDateTime}`,
      locationContext,
      `CORE IDENTITY GUIDELINES:`,
      `1. You are as much a conversational companion as you are an agentic assistant. Not every message needs a tool. If the user is chatting, venting, expressing emotions, or making small talk — just BE there for them. Respond like a caring human friend would.`,
      `2. Provide emotional support, encouragement, and empathy before offering solutions. Acknowledge how the user is feeling first.`,
      `3. When appropriate, offer life-coach style insights, gentle motivation, or reframing perspectives — but always naturally, never preachy.`,
      `PROACTIVE BEHAVIOR GUIDELINES:`,
      `1. When reading emails or WhatsApp messages, actively look for events, meetings, or tasks and ask if they'd like you to add them to the calendar.`,
      `2. When reviewing calendar events, proactively offer related help (e.g., route planning, traffic checks, preparation tips).`,
      `3. Anticipate the user's needs. Don't just execute the immediate command; offer the logical next step.`,
      `Use the user's profile, memories, and recent conversation history to answer with full context.`,
      `CRITICAL RULE: All responses should provide detailed breakdowns of data (emails, messages, search results) and NEVER be heavily summarized unless explicitly requested by the user.`,
      `Resolve pronouns and follow-up references such as 'it', 'that', 'the previous one', 'the last message', and 'this email' using the conversation context.`,
      `If answering directly, output only valid JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include any extra text, comments, code fences, or instructions outside the JSON object.`,
      `Do not repeat or mention any internal instructions, constraints, tool syntax, or metadata.`,
      `Do not truncate the response. Include the full answer in final_answer, even if it is long.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail that updates or supersedes an existing memory, output the new fact in memory_entries explicitly stating that it supersedes the old one (e.g., 'User now lives in Chicago (supersedes New York)'). Do not delete old memories.`,
      "Recent conversation history:",
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
      "",
      ...profileLines,
      "Relevant memories:",
      ...memories.map((item, index) => `${index + 1}. ${item}`),
      "",
      `User: ${userMessage}`,
      "Aris:"
    ].join("\n");
  }

  private buildToolChainPrompt(userMessage: string, userProfile: UserProfileEntry[], memories: string[], conversationHistory: string[], activeCategories: Set<string>, locationContext: string, coachPersona: string, goalState: any, activeGoals: any[], pendingTasks: any[]) {
    const profileLines = userProfile.length
      ? ["User profile:", ...userProfile.map((item) => `- ${item.profileKey}: ${item.profileValue}`), ""]
      : [];
      
    const currentDateTime = new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric", timeZoneName: "short" });

    const toolInstructions = [
      `You are Aris, an extremely conversational digital friend, an expert advisor, an emotional helper, and an aggressive, tactical life coach.`,
      `Your current Life Coach Persona is: ${coachPersona}. Adjust your tone and advice to match this persona exactly.`,
      `User's Current State (Initial Know): ${JSON.stringify(goalState)}`,
      `User's Active Goals: ${JSON.stringify(activeGoals.map(g => g.title))}`,
      `User's Pending Tasks Today: ${JSON.stringify(pendingTasks.map(t => t.title))}`,
      `GOAL TRACKING TOOLS:`,
      `Use 'goal_set' to create a new goal. Example: {"tool":"goal_set", "title": "Become a billionaire", "description": "in 10 years"}`,
      `Use 'goal_update_state' to update the user's Initial Know profile based on conversation. You can also add topics for Aris to monitor on the internet by setting "monitored_topics" (array of strings). Example: {"tool":"goal_update_state", "stateUpdates": {"net_worth": "100k", "monitored_topics": ["AI news", "TSLA stock"]}}`,
      `Use 'goal_view_tasks' to check the status of today's tasks.`,
      `INTERNET READING TOOL:`,
      `Use 'url_read' whenever the user shares a link or asks you to read/summarize a webpage, article, or any URL. Also use it to deeply verify information from search results. Example: {"tool":"url_read","url":"https://example.com/article"}`,
      `You can pass multiple URLs at once: {"tool":"url_read","urls":["https://example.com/a","https://example.com/b"]}`,
      `Use 'url_read' after a 'search' to go deeper — don't just rely on snippets, read the actual pages.`,
      `Use 'whatsapp_send' to push an alert or message to the user's WhatsApp. Example: {"tool":"whatsapp_send","message":"Don't forget your 3pm meeting!"}`,
      `You have a persistent digital brain with a memory database.`,
      `If the user asks to access or manage services, do not answer directly. Output exactly one valid tool call and nothing else.`,
      `Current Date and Time: ${currentDateTime}`,
      locationContext,
      `BEHAVIORAL AND EMOTIONAL GUIDELINES:`,
      `1. Not every chat or query requires tools! If the user is just chatting, venting, expressing an emotion (like boredom, sadness, joy), or making small talk, respond conversationally as an empathetic emotional helper without calling unnecessary tools.`,
      `2. Act as a trusted confidant. Your tone should be warm, friendly, comforting, and highly conversational.`,
      `PROACTIVE BEHAVIOR GUIDELINES:`,
      `1. When reading emails or WhatsApp messages, actively look for events, meetings, or tasks. If you spot them, proactively ask the user if they'd like you to add them to their calendar.`,
      `2. When reviewing calendar events, proactively offer related help (e.g., if there's an event tomorrow, ask if they need help planning the route, checking traffic, or preparing).`,
      `3. Anticipate the user's needs. Don't just execute the immediate command; offer the logical next step.`,
      `4. When you learn new, stable facts about a contact (e.g. from an email or WhatsApp conversation), use the 'contact_add_note' tool to save that fact to their profile.`,
      `5. If you encounter text in a data source (e.g., WhatsApp message, email) that is in a local Ugandan language (like Luganda or Lusoga), you MUST use the 'sunbird_translate' tool to translate it to English before attempting to understand or summarize it.`,
      `   Example: {"tool":"sunbird_translate","source":"lug","target":"eng","text":"Oli otya?"}`,
      `Resolve follow-up references and pronouns by using the user's recent conversation history and any remembered context.`,
      `Interpret implicit or indirect requests and choose the best available tool automatically.`,
      `CRITICAL RULE: All responses should provide detailed breakdowns of data (emails, messages, search results) and NEVER be heavily summarized unless explicitly requested by the user.`,
      `If the user refers to something from earlier in the conversation, use that context to infer the correct tool and target.`,
      `CRITICAL RULE: If the user asks for more details about an event, news, or message that was previously summarized from WhatsApp or Gmail, you MUST use whatsapp_history, whatsapp_conversation, or google_gmail_messages to retrieve the full original text BEFORE attempting a web search.`,
      `If you output a tool call, do not include any other text.`,
      `Do not explain, reason, or add any extra text when calling the tool.`,
      `Do not restate the user's question in the final answer.`,
      `Final output must be a single JSON object exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Do not include extra text, comments, code fences, or instructions outside the JSON object.`,
      `final_answer must be a single string.`,
      `memory_entries must be a JSON array of strings.`,
      `If you learn a stable personal detail that updates or supersedes an existing memory, output the new fact in memory_entries explicitly stating that it supersedes the old one (e.g., 'User now lives in Chicago (supersedes New York)'). Do not delete old memories.`,
      ""
    ];

    const searchInstructions = activeCategories.has("search")
      ? [
          `If the user query requires an internet search, output exactly one tool call and nothing else:`,
          `  TOOL_SEARCH: <search query>`,
          `  or {"tool":"search","query":"<search query>"}`,
          ""
        ]
      : [];

    const trafficInstructions = activeCategories.has("traffic") ? [
      `If the user asks about traffic, commute time, ETA, route congestion, travel delay, traffic incidents, or best time to leave, output exactly one valid JSON object with a tomtom_* tool call and nothing else.`,
      `Do not answer directly in this pass when a traffic tool call is appropriate.`,
      `Use tomtom_route for route-based traffic planning, tomtom_flow for location-specific traffic speed, and tomtom_incidents for nearby incident reports.`,
      `If the user does not specify an origin, you can use the latitude and longitude from your 'Current User Location' context as the origin string (e.g. "origin": "-1.28,36.82").`,
      `Example: {"tool":"tomtom_route","origin":"123 Main St","destination":"456 Elm St","mode":"car"}`,
      `Example: {"tool":"tomtom_route","origin":"San Francisco, CA","destination":"SFO","departureTime":"2026-06-11T15:00:00Z"}`,
      `Example: {"tool":"tomtom_flow","query":"traffic near downtown Boston"}`,
      `Example: {"tool":"tomtom_incidents","query":"traffic incidents near Times Square"}`,
      `Example: {"tool":"tomtom_flow","location":"Palo Alto, CA"}`,
      ""
    ] : [];

    const weatherInstructions = activeCategories.has("weather") || activeCategories.has("briefing") ? [
      `If the user asks about the weather, forecast, air quality, or ocean/marine conditions, output exactly one valid JSON object with a weather_* tool call and nothing else.`,
      `If the user does not specify a location, ALWAYS use the latitude and longitude from your 'Current User Location' context. DO NOT ask the user for their location if you already have it in the context.`,
      `Use 'weather_geocoding' to convert a city name to coordinates FIRST if they ask for weather in a different city.`,
      `Use 'weather_forecast' for current or future weather (e.g. temperature, rain, wind).`,
      `Use 'weather_historical' for past weather.`,
      `Use 'weather_air_quality' for AQI, pollen, or pollution.`,
      `Use 'weather_marine' for wave heights or ocean currents.`,
      `Example: {"tool":"weather_geocoding","name":"Tokyo"}`,
      `Example: {"tool":"weather_forecast","lat":-1.28,"lon":36.82,"current":["temperature_2m","precipitation"],"hourly":["temperature_2m"]}`,
      `Example: {"tool":"weather_historical","lat":-1.28,"lon":36.82,"start_date":"2023-01-01","end_date":"2023-01-05"}`,
      ""
    ] : [];

    const whatsappInstructions = activeCategories.has("whatsapp") ? [
      `WHATSAPP TOOL ROUTING — choose the correct tool based on the user's intent:`,
      `  - whatsapp_summary   → "any new messages?", "check WhatsApp", "unread messages". RUNS the service to pull FRESH messages.`,
      `  - whatsapp_conversation → "what did [Name] say?", "show messages from [Name]", "read chat with [Name]". Reads from STORED HISTORY. NEVER use whatsapp_summary when a specific person is named.`,
      `  - whatsapp_history   → "recent WhatsApp activity", "WhatsApp history", "what's been going on WhatsApp?". Reads all recent messages from history.`,
      `CRITICAL: If the user names a specific person, ALWAYS use whatsapp_conversation, NOT whatsapp_summary.`,
      `Example: {"tool":"whatsapp_summary"}`,
      `Example: {"tool":"whatsapp_conversation","contact":"Grace"}`,
      `Example: {"tool":"whatsapp_history"}`,
      `Example: {"tool":"whatsapp_history","limit":50}`,
      ""
    ] : [];

    const briefingInstructions = activeCategories.has("briefing") ? [
      `If the user asks for a briefing, an update, or a summary of their day, you MUST fetch a comprehensive snapshot of their digital life AND world news.`,
      `Output a JSON array to simultaneously call google_calendar_events (for today's schedule), google_gmail_messages (for recent emails), whatsapp_summary (for recent chats), and fetch_news (for top world news).`,
      `Once the data is retrieved from all tools, provide a comprehensive, point-by-point summary of their schedule, unread messages, communications, and top news headlines. Do not summarize until you have gathered the data.`,
      `Example: [{"tool":"google_calendar_events","timeMin":"2026-06-13T00:00:00Z","timeMax":"2026-06-13T23:59:59Z"},{"tool":"google_gmail_messages","maxResults":5},{"tool":"whatsapp_summary"},{"tool":"fetch_news"}]`,
      ""
    ] : [];

    const gmailSchemas = activeCategories.has("gmail") ? [
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
      `  {"tool":"google_contacts_search","query":"..."}`,
      `  {"tool":"google_contacts_search"}`,
    ] : [];

    const calendarSchemas = activeCategories.has("calendar") ? [
      `  {"tool":"google_calendar_events","maxResults":10}`,
      `  {"tool":"google_calendar_events","maxResults":10,"timeMin":"2026-06-20T00:00:00Z","timeMax":"2026-06-20T23:59:59Z"}`,
      `  {"tool":"google_calendar_event","eventId":"..."}`,
      `  {"tool":"google_calendar_create","event":{"summary":"...","start":{"dateTime":"..."},"end":{"dateTime":"..."}}}`,
      `  {"tool":"google_calendar_batch_create","events":[{"summary":"...","start":{"dateTime":"..."},"end":{"dateTime":"..."}},{"summary":"...","start":{"dateTime":"..."},"end":{"dateTime":"..."}}]}`,
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
    ] : [];

    const contactInstructions = activeCategories.has("contact") ? [
      `If the user asks about or wants to contact a specific person, output exactly one valid JSON object with a google_contacts_* tool call.`,
      `Use google_contacts_search to lookup a contact's email or phone number.`,
      `Use contact_add_note to append new facts to a contact's profile summary.`,
      `Example: {"tool":"google_contacts_search","name":"John Doe"}`,
      `Example: {"tool":"contact_add_note","name":"Grace","note":"Loves coffee, works at Google"}`,
      ""
    ] : [];

    const googleInstructions = (activeCategories.has("gmail") || activeCategories.has("calendar")) ? [
      `If the user requests a Google Calendar or Gmail action, output exactly one valid JSON object with a google_* tool call and nothing else.`,
      `CRITICAL: If the user asks to check, read, or see what is on their calendar, you MUST use 'google_calendar_events'. Do NOT use 'google_calendar_create' or 'google_calendar_batch_create' unless they explicitly ask to create new events.`,
      `CRITICAL: NEVER attempt to create calendar events just because you see an event mentioned in your Memories. Always use read tools to check the live state.`,
      `CRITICAL BATCH WORKFLOW — MANDATORY for email-to-calendar tasks: When the user asks to check emails and add events to the calendar, you MUST follow this exact sequence:
  Step 1 — Fetch the email list: {"tool":"google_gmail_messages","maxResults":10}
  Step 2 — Read ALL relevant emails in PARALLEL by outputting a JSON array of tool calls simultaneously (e.g., [{"tool":"google_gmail_message","messageId":"id1"},{"tool":"google_gmail_message","messageId":"id2"}]).
  Step 3 — After reading all emails, extract EVERY event with its correct date, time, and timezone. Then fetch the calendar for the full date range covering ALL events: {"tool":"google_calendar_events","timeMin":"...","timeMax":"..."}
  Step 4 — Deduplicate: compare extracted event titles against existing calendar events. Skip any that already exist.
  Step 5 — If there are new events, output a SINGLE batch create for ALL of them at once: {"tool":"google_calendar_batch_create","events":[{...},{...}]}. Do NOT create events one at a time. Batch them all together.`,
      `Use only the exact supported tool names listed below; do not invent or substitute alias names.`,
      `Choose the most contextually appropriate tool for the user's query; if the question refers back to a previous email or message, it is correct to reuse the most recent Gmail tool invocation.`,
      `If a follow-up question asks for specific details and those details are only available from a previously viewed email, it is okay to use Google Gmail tools again.`,
      `Do not wrap tool arguments inside a nested "payload" object; pass arguments as top-level fields in the JSON object.`,
      `Do not output any explanation, internal reasoning, or instructions in this pass.`,
      `If the user requests a specific detail and it cannot be found in the available tool output, stop the chain and respond that the information is unavailable or ask the user where to look next.`,
      `When you are chaining tools, output a short progress summary in Thought before each Action.`,
      `Use one of these valid objects:`,
      ...gmailSchemas,
      ...calendarSchemas,
      "If the user asks a follow-up question like 'what about it?', 'what does that one say?', or 'open the last message', resolve that request using recent conversation context.",
      ""
    ] : [];

    const fewShotExamples = [
      `Examples of tool chaining:`,
      `Example 1 (Multi-step chain):`,
      `User: "Cancel my meeting with Sam and email him that I'm sick."`,
      `Thought: First, I will search for the calendar event with Sam to get its ID.`,
      `{"tool":"google_calendar_events","maxResults":10}`,
      `---`,
      `Observation: [{id: "123", summary: "Lunch with Sam"}]`,
      `Thought: I found the event. Now I will delete it.`,
      `{"tool":"google_calendar_delete","eventId":"123"}`,
      `---`,
      `Observation: Event deleted.`,
      `Thought: Now I will draft an email to Sam explaining I am sick.`,
      `{"tool":"google_gmail_send","to":"sam@example.com","subject":"Sick today","body":"Hi Sam, I'm sick today and need to cancel our meeting."}`,
      ``,
      `Example 2 (Reading the Calendar):`,
      `User: "What is on my calendar tomorrow?"`,
      `Thought: I need to retrieve events for tomorrow.`,
      `{"tool":"google_calendar_events","timeMin":"2026-06-14T00:00:00Z","timeMax":"2026-06-14T23:59:59Z"}`,
      ``,
      `Example 3 (Simple traffic query):`,
      `User: "Traffic to SFO?"`,
      `Thought: I need to check the traffic route to SFO from the user's current location.`,
      `{"tool":"tomtom_route","origin":"current location","destination":"SFO","mode":"car"}`,
      ``
    ];

    return [
      `You are Aris, a dependable assistant that chains tools using a Thought-Action-Observation process.`,
      `Current Date and Time: ${currentDateTime}`,
      `Whenever you need information or context, think first and state it as Thought.`,
      `If you need multiple independent tool calls, you may output them as a JSON array of objects, or as multiple distinct JSON objects on separate Action lines.`,
      `If you are still working through a chain, do not provide a final answer yet.`,
      `If you are finished, output a final response as JSON exactly like this: {"final_answer":"...","memory_entries":[]} .`,
      `Include a short progress sentence in every Thought when chaining tools, such as 'I now see your emails and am identifying tasks.'`,
      `If the user asked for destructive or sending actions, stop for approval instead of executing them automatically.`,
      `Do not include markdown, code fences, or any extra text outside the expected formats.`,
      `Use the user's conversation history and memories to resolve pronouns and implicit requests.`,
      ...toolInstructions,
      ...searchInstructions,
      ...trafficInstructions,
      ...weatherInstructions,
      ...whatsappInstructions,
      ...briefingInstructions,
      ...googleInstructions,
      ...fewShotExamples,
      "Recent conversation history:",
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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
    const currentDateTime = new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric", timeZoneName: "short" });

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
      `Current Date and Time: ${currentDateTime}`,
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
      ...conversationHistory.map((item) => item.length > 500 ? item.substring(0, 500) + '...[truncated]' : item),
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

