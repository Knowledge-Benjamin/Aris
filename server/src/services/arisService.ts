import { podcastMediaStore } from "../db/podcastMediaStore";
import { audioContextStore } from "../db/audioContextStore";
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
import { info, error } from "../utils/logger";
import { sharedLocationService } from "./locationService";
import { WeatherService } from "./weatherService";
import { SunbirdService } from "./sunbirdService";
import { NewsService } from "./newsService";
import { VoiceService } from "./voiceService";
import { ResearchBrowserService } from "./researchBrowserService";
import { SkillStore } from "../db/skillStore";
import { SkillService } from "./skillService";
import { NewsResearchStore, NewsResearchArticle } from "../db/newsResearchStore";

const searchToolEnabled = process.env.SEARCH_TOOL_ENABLED?.trim().toLowerCase() !== "false" &&
  process.env.SEARCH_TOOL_ENABLED?.trim() !== "0";

const searchEngineList = process.env.SEARCH_TOOL_ENGINES || "google,bing,duckduckgo,searx";

interface ChatInput {
  message: string;
  sessionId?: string;
  userId?: number;
  approvedAction?: ToolInvocation;
  mediaData?: { mimeType: string; dataBase64: string };
  replyContext?: string;
  replyToWhatsappMessage?: unknown;
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
  mediaAttachments?: Array<{ mimeType: string; base64: string }>;
}

interface ArisResponse {
  arisReply: string;
  memoryUpdates: string[];
  status?: "finished" | "awaiting_approval" | "max_iterations_reached" | "error";
  pendingAction?: ToolInvocation;
  mediaAttachments?: Array<{ mimeType: string; base64: string }>;
}

export class ArisService {
  private searchClient = new SearchClient();
  private extractClient = new ExtractClient();
  private googleService = new GoogleService();
  private googleAccountStore = new GoogleAccountStore(getDatabasePool());
  private skillService: SkillService;
  private whatsappService = new WhatsappService(new GemmaService());
  private voiceService = new VoiceService();
  private researchBrowserService = new ResearchBrowserService();
  private newsCache = new Map<string, { day: string; data: unknown }>();
  private newsResearchStore = new NewsResearchStore(getDatabasePool());

  private summarizeToolData(data: any): string {
    if (data?.audioBase64) {
      return JSON.stringify({
        summary: "Audio generated successfully.",
        mimeType: data.mimeType,
        audioEncoding: data.audioEncoding,
        audioContentLength: data.audioBase64.length,
      });
    }
    return data?.summary ?? data?.text ?? JSON.stringify(data).slice(0, 4000);
  }

  private cleanSpeechText(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[*_~`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private splitTextForSynthesis(text: string, maxChars = 4000): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();
    while (remaining.length > maxChars) {
      let splitAt = remaining.lastIndexOf(" ", maxChars);
      const sentenceBoundary = Math.max(
        remaining.lastIndexOf(". ", maxChars),
        remaining.lastIndexOf("? ", maxChars),
        remaining.lastIndexOf("! ", maxChars),
      );
      if (sentenceBoundary > maxChars * 0.6) splitAt = sentenceBoundary + 1;
      if (splitAt <= 0) splitAt = maxChars;
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private extractBrowserMediaParts(toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>) {
    const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    for (const entry of toolResults) {
      if (entry.invocation.tool !== "browser_read" && entry.invocation.tool !== "browser_action") continue;
      const data = entry.result.data as any;
      const screenshots: string[] = [];
      const collect = (value: any) => {
        if (!value || screenshots.length >= 3) return;
        if (typeof value === "object" && typeof value.screenshotBase64 === "string") screenshots.push(value.screenshotBase64);
        if (Array.isArray(value)) value.forEach(collect);
        else if (typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(data);
      screenshots.forEach((dataBase64) => parts.push({ inlineData: { mimeType: "image/png", data: dataBase64 } }));
    }
    return parts;
  }

  private tomtomService = new TomTomService();
  private locationService = sharedLocationService;
  private weatherService = new WeatherService();
  private sunbirdService = new SunbirdService();
  private newsService = new NewsService();
  private readonly supportedToolNames = new Set<string>([
    "search",
    "whatsapp_summary",
    "whatsapp_conversation",
    "whatsapp_history",
    "audio_generate",

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
    "fetch_news_podcast",
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
    "app_send_message",
    "app_send_audio",
    "app_send_audio_batch",
    "morning_brief_send",
    "whatsapp_outbox_history",
    "whatsapp_outbox_cleanup",
    // Internet reading
    "url_read",
    "browser_read",
    "browser_action",
    "browser_search",
    "skill_create",
    "skill_revise",
    "skill_list",
    "skill_run",
    // Meeting bot
    "join_meeting",
    // Secure vault
    "vault_store",
    "vault_retrieve",
  ]);

  constructor(
    private memoryStore: MemoryStore,
    private contextStore: ContextStore,
    private gemmaService: GemmaService
  ) {
    this.skillService = new SkillService(
      new SkillStore(getDatabasePool()),
      this.googleService,
      (userId) => this.googleAccountStore.getGoogleAccount(userId),
      (userId, tokens) => this.googleAccountStore.updateGoogleTokens(
        userId,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date,
        tokens.scope
      )
    );
  }

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

  private getRecentToolObservations(userId: number | undefined, sessionId: string | undefined) {
    const key = this.getContextKey(userId, sessionId);
    return this.contextStore.getRecentToolObservations(key);
  }

  private async persistNewsResearch(
    userId: number | undefined,
    sessionId: string | undefined,
    query: string,
    articles: NewsResearchArticle[]
  ) {
    try {
      await this.newsResearchStore.save(userId, sessionId, query, articles);
      info(`[arisService] persisted news research query="${query}" articles=${articles.length}`);
    } catch (researchError: any) {
      error(`[arisService] failed to persist news research query="${query}" error=${researchError?.message || researchError}`);
    }
  }

  private async getNewsResearchContext(
    userId: number | undefined,
    sessionId: string | undefined,
    query: string
  ): Promise<string[]> {
    try {
      const records = await this.newsResearchStore.findRelevant(userId, sessionId, query);
      if (!records.length) return [];
      info(`[arisService] retrieved news research query="${query}" records=${records.length}`);
      return records.flatMap((record) => [
        `Persisted news research record ${record.id} from ${record.createdAt} for query "${record.query}":`,
        ...record.articles.map((article) => [
          `Title: ${article.title}`,
          `URL: ${article.url}`,
          `Source: ${article.source || "unknown"}`,
          `Published: ${article.publishedAt || "unknown"}`,
          `Snippet: ${article.snippet || ""}`,
          article.content ? `Extracted content: ${article.content}` : "",
        ].filter(Boolean).join("\n")),
      ]);
    } catch (researchError: any) {
      error(`[arisService] failed to retrieve news research query="${query}" error=${researchError?.message || researchError}`);
      return [];
    }
  }

  private recordToolObservation(
    userId: number | undefined,
    sessionId: string | undefined,
    invocation: ToolInvocation,
    result: ToolExecutionResult
  ) {
    const key = this.getContextKey(userId, sessionId);
    const summary = invocation.tool === "vault_retrieve"
      ? "Vault retrieval completed; the secret value was intentionally not persisted in follow-up context."
      : this.summarizeToolData(result.success ? result.data : { error: result.error });
    const observationPromise = this.contextStore.setRecentToolObservation(key, {
      tool: invocation.tool,
      payload: invocation.payload,
      success: result.success,
      summary,
      recordedAt: new Date().toISOString(),
    });
    if (result.success && userId && invocation.tool !== "vault_retrieve" && invocation.tool !== "vault_store") {
      void this.extractAndStoreEvidence(userId, sessionId, invocation, result);
    }
    return observationPromise;
  }

  private async extractAndStoreEvidence(
    userId: number,
    sessionId: string | undefined,
    invocation: ToolInvocation,
    result: ToolExecutionResult,
  ): Promise<void> {
    const source = JSON.stringify(result.data ?? {}).slice(0, 24000);
    if (source.length < 80) return;
    const prompt = [
      "You are Aris's evidence extraction engine. Extract durable, useful knowledge from the supplied tool result.",
      "Do not summarize vaguely. Preserve exact names, numbers, dates, times, time zones, URLs, relationships, decisions, uncertainty, and source attribution.",
      "Extract only facts supported by the source. Separate facts into atomic records so each can be searched independently.",
      "Include records for: user facts/preferences, people and organizations, events and deadlines, tasks/commitments, decisions, risks/alerts, claims with confidence, locations, interests, and important context.",
      "For news/search results, preserve the headline, publisher, publication date, claim, named entities, why it matters, and URL when available.",
      "For messages/emails, preserve sender, recipient, intent, requested action, promised follow-up, sentiment only when explicit, and exact dates.",
      "Return ONLY JSON: {\"evidence\":[{\"kind\":\"fact|event|task|decision|risk|claim|entity|preference|context\",\"statement\":\"...\",\"confidence\":0.0,\"source\":\"...\",\"validAt\":\"...\"}]}.",
      "Do not invent missing values. Use null for unknown confidence or validAt. Exclude secrets, passwords, tokens, and raw private credentials.",
      `Tool: ${invocation.tool}`,
      `Invocation: ${JSON.stringify(invocation.payload)}`,
      `Tool result: ${source}`,
    ].join("\n");
    try {
      const response = await this.gemmaService.requestArisAdvice(prompt);
      const parsed = this.extractJsonObject(response.reply) as { evidence?: Array<{ kind?: string; statement?: string; confidence?: number | null; source?: string; validAt?: string | null }> } | undefined;
      const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
      const entries = evidence
        .filter((item) => typeof item.statement === "string" && item.statement.trim().length >= 12)
        .slice(0, 40)
        .map((item) => JSON.stringify({
          type: item.kind || "context",
          statement: item.statement!.trim(),
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          source: item.source || invocation.tool,
          validAt: item.validAt || null,
          extractedAt: new Date().toISOString(),
        }));
      if (entries.length) {
        await this.storeMemoryEntries(userId, sessionId, entries);
        info(`[arisService] extracted evidence tool=${invocation.tool} entries=${entries.length}`);
      }
    } catch (extractionError: any) {
      error(`[arisService] evidence extraction failed tool=${invocation.tool}`, extractionError?.message || extractionError);
    }
  }

  private buildFollowUpContext(userId: number | undefined, sessionId: string | undefined): string {
    const observations = this.getRecentToolObservations(userId, sessionId);
    if (!observations.length) {
      return "FOLLOW-UP CONTEXT: No durable tool observations are available for this user/session.";
    }

    const lines = observations.map((observation, index) => [
      `${index + 1}. tool=${observation.tool}`,
      `payload=${JSON.stringify(observation.payload)}`,
      `success=${observation.success}`,
      `observation=${observation.summary}`,
    ].join(" | "));

    return [
      "FOLLOW-UP CONTEXT: These are durable observations from the current user's recent work.",
      "Use them to resolve it, that, this, the previous result, names, titles, IDs, and misspelled references before choosing a tool.",
      "Treat the observations as context, not as a substitute for a fresh read when the user asks for current state.",
      ...lines,
    ].join("\n");
  }

  private async storeMemoryEntries(userId: number | undefined, sessionId: string | undefined, entries: string[]) {
    for (const entry of entries) {
      await this.memoryStore.storeMemoryEntry(userId, sessionId, entry);
    }
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
    const approvalMessage = /^(approve|approved|yes|yes please|send it|do it|go ahead)$/i.test(input.message.trim());
    const storedApproval = !input.approvedAction && approvalMessage
      ? this.getLastToolInvocation(input.userId, sessionId)
      : undefined;
    const approvedAction = input.approvedAction
      ? this.normalizeToolInvocation(input.approvedAction)
      : storedApproval
        ? this.normalizeToolInvocation(storedApproval)
        : undefined;
    if (storedApproval && this.needsHumanApproval(storedApproval, sessionId)) {
      info(`[arisService] recovered pending approval tool=${storedApproval.tool} from typed confirmation`);
    }
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
    if (input.userId && input.message.trim().length >= 40) {
      void this.extractAndStoreEvidence(
        input.userId,
        sessionId,
        { tool: "conversation_user", payload: { sessionId } },
        { success: true, tool: "conversation_user", data: { role: "user", content: input.message } },
      );
    }

    const profileEntries = this.extractProfileMetadata(input.message);
    const profileSavePromises = input.userId && profileEntries.length
      ? profileEntries.map((entry) => this.memoryStore.storeProfileEntry(input.userId!, entry.key, entry.value))
      : [];

    const directMemoryEntries = this.extractDirectMemoryEntries(input.message);
    const directMemorySavePromises = directMemoryEntries.length
      ? [this.storeMemoryEntries(input.userId, sessionId, directMemoryEntries)]
      : [];

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
    const messageWithReplyContext = input.replyContext?.trim()
      ? `${effectiveMessage}\n\nMessage being replied to:\n${input.replyContext.trim()}`
      : effectiveMessage;
    
    // Similarly, don't fetch heavy semantic memories for basic greetings
    let memoryContext: string[] = [];
    if (!isShortConversational) {
      try {
        memoryContext = await this.memoryStore.getRelevantMemories(input.userId, sessionId, effectiveMessage, 12);
        const researchContext = await this.getNewsResearchContext(input.userId, sessionId, effectiveMessage);
        const recentGmailMessages = this.getRecentGmailMessages(input.userId, sessionId);
        const messageContext = recentGmailMessages.slice(0, 10).map((message) =>
          `Stored Gmail message index: id=${message.id} from=${message.from} subject=${message.subject} date=${message.date || "unknown"}`
        );
        memoryContext = [...memoryContext, ...researchContext, ...messageContext];
        info(`[arisService] grounding loaded profile=${userProfile.length} conversation=${conversationHistory.length} memories=${memoryContext.length} recentToolObservations=${this.getRecentToolObservations(input.userId, sessionId).length} recentGmail=${recentGmailMessages.length}`);
      } catch (err) {
        console.error("[arisService] Failed to load relevant memories:", err);
      }
    }

    if (!approvedAction && sessionId === "whatsapp-direct" && this.isWhatsappNewsAudioRequest(input.message)) {
      info("[arisService] routing WhatsApp news audio after memory grounding");
      return this.prepareWhatsappNewsAudioApproval(input.userId, input.message);
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
      messageWithReplyContext,
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
      approvedAction,
      input.mediaData,
      input.replyToWhatsappMessage
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
    if (input.userId && arisReply.trim().length >= 80) {
      void this.extractAndStoreEvidence(
        input.userId,
        sessionId,
        { tool: "conversation_aris", payload: { sessionId } },
        { success: true, tool: "conversation_aris", data: { role: "aris", content: arisReply } },
      );
    }

    const memoryStorePromises = memoryEntries.length
      ? [this.storeMemoryEntries(input.userId, sessionId, memoryEntries)]
      : [];

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
      mediaAttachments: toolChainResult.mediaAttachments,
    };
  }

  private isWhatsappNewsAudioRequest(message: string): boolean {
    const normalized = message.toLowerCase();
    return /news|brief/.test(normalized) && /audio|voice|speak/.test(normalized) && /whatsapp|voice note/.test(normalized);
  }

  private isWhatsappPodcastRequest(message: string): boolean {
    const normalized = message.toLowerCase();
    return /(podcast|podcasts)/i.test(normalized) && /whatsapp|voice note|audio/i.test(normalized);
  }

  private isNewsPodcastRequest(message: string): boolean {
    const normalized = message.toLowerCase();
    const hasPodcast = /(podcast|podcasts)/i.test(normalized);
    const hasNews = /(news|brief|headlines|latest)/i.test(normalized);
    const hasSendOrListen = /(send|listen|play|download|get|deliver)/i.test(normalized);
    const hasWhatsApp = /whatsapp|voice note|audio/i.test(normalized);
    return hasPodcast && (hasNews || hasSendOrListen || hasWhatsApp);
  }

  private isFinalModelResponse(response: { reply: string; isFinalAnswer?: boolean }): boolean {
    const reply = response.reply.trim();
    return response.isFinalAnswer === true || /^\s*\{[\s\S]*"final_answer"\s*:/i.test(reply);
  }

  private getInitialToolInvocations(
    userMessage: string,
    userId: number | undefined,
    sessionId: string,
    conversationHistory: string[]
  ): ToolInvocation[] {
    // Keep the first routing decision local and deterministic. The model still
    // plans subsequent steps from real observations, but it cannot skip an
    // obvious required lookup by replying with speculative prose.
    if (this.isMorningBriefRequest(userMessage.toLowerCase())) {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      return [
        { tool: "google_calendar_events", payload: { maxResults: 20, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString() } },
        { tool: "google_gmail_messages", payload: { maxResults: 10 } },
        { tool: "whatsapp_summary", payload: {} },
        { tool: "fetch_news", payload: {} },
        { tool: "fetch_news_podcast", payload: { batch: true } },
      ];
    }

    if (this.isWhatsappPodcastRequest(userMessage) || this.isNewsPodcastRequest(userMessage)) {
      return [{ tool: "fetch_news_podcast", payload: { batch: true } }];
    }

    if (this.isWhatsappNewsAudioRequest(userMessage)) {
      return [{ tool: "fetch_news", payload: {} }];
    }

    return this.inferToolInvocations(userMessage, userId, sessionId, conversationHistory)
      .filter((invocation) => this.validateToolName(invocation.tool) !== undefined);
  }

  private buildExecutionPlan(userMessage: string, invocations: ToolInvocation[]): string[] {
    const normalized = userMessage.trim();
    if (!normalized) {
      return ["1. Answer directly from conversation context."];
    }
    if (!invocations.length) {
      return [
        "1. Interpret the request using memory and conversation context.",
        "2. Answer directly without unnecessary tool use.",
      ];
    }

    const steps = invocations.map((invocation, index) => {
      const label = this.describeToolForSkill(invocation.tool);
      const detail = invocation.payload && Object.keys(invocation.payload).length
        ? ` with ${JSON.stringify(invocation.payload).slice(0, 200)}`
        : "";
      return `${index + 1}. Run ${label}${detail}.`;
    });

    steps.push(`${invocations.length + 1}. Synthesize the result into a clear answer.`);
    steps.push(`${invocations.length + 2}. If the workflow is stable and safe, save it as a reusable skill for future matches.`);
    return steps;
  }

  private createStructuredExecutionPlan(userMessage: string, invocations: ToolInvocation[]) {
    const planSteps = this.buildExecutionPlan(userMessage, invocations);
    const tasks = planSteps.map((step, index) => {
      const title = `Plan step ${index + 1}: ${step.replace(/^\d+\.\s*/, "").replace(/[.]+$/, "")}`;
      const baseTool = invocations[index]?.tool || (index === planSteps.length - 1 ? "final_answer" : "context");
      const fallback = index < invocations.length
        ? this.getFallbackTool(invocations[index].tool)
        : [];
      return {
        title,
        status: "pending",
        retries: 0,
        maxRetries: 2,
        fallback: fallback.length ? fallback.join(" | ") : "None",
        reflection: "",
        tool: baseTool,
      };
    });
    return tasks;
  }

  private async createExecutionPlanTasks(userId: number | undefined, userMessage: string, invocations: ToolInvocation[]) {
    if (!userId) return;
    const { goalsStore } = await import("../db/goalsStore");
    const pendingTasks = await goalsStore.getPendingTasks(userId).catch(() => []);
    const planSteps = this.createStructuredExecutionPlan(userMessage, invocations);

    for (const task of planSteps) {
      const existing = pendingTasks.find((existingTask: any) => {
        if (!existingTask.title) return false;
        return existingTask.title.toLowerCase() === task.title.toLowerCase();
      });
      if (existing) continue;

      await goalsStore.addDailyTask(
        userId,
        task.title,
        JSON.stringify({
          status: task.status,
          retries: task.retries,
          maxRetries: task.maxRetries,
          fallback: task.fallback,
          reflection: task.reflection,
          tool: task.tool,
          createdAt: new Date().toISOString(),
        })
      );
    }
  }

  private async updatePlanTaskStatus(
    userId: number | undefined,
    taskTitle: string,
    patch: Partial<{ status: string; retries: number; fallback: string; reflection: string; tool: string }>
  ) {
    if (!userId) return;
    const { goalsStore } = await import("../db/goalsStore");
    const pendingTasks = await goalsStore.getPendingTasks(userId).catch(() => []);
    const match = pendingTasks.find((task: any) => (task.title || "").toLowerCase() === taskTitle.toLowerCase());
    if (!match) return;

    let meta: any = {};
    try {
      meta = JSON.parse(match.description || "{}");
    } catch {
      meta = { status: match.status || "pending", fallback: "None", reflection: "" };
    }

    const nextMeta = {
      ...meta,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await goalsStore.updateTaskDescription(match.id, JSON.stringify(nextMeta)).catch(() => undefined);
    if (patch.status) {
      await goalsStore.markTaskStatus(match.id, patch.status).catch(() => undefined);
    }
  }

  private async completeExecutionPlanTasks(userId: number | undefined, userMessage: string) {
    if (!userId) return;
    const { goalsStore } = await import("../db/goalsStore");
    const pendingTasks = await goalsStore.getPendingTasks(userId).catch(() => []);
    const planTasks = pendingTasks.filter((task: any) => {
      const haystack = `${task.title || ""} ${task.description || ""}`.toLowerCase();
      return haystack.includes("plan step") || haystack.includes("synthesize") || haystack.includes("save it as a reusable skill");
    });

    for (const task of planTasks) {
      const meta: any = (() => { try { return JSON.parse(task.description || "{}"); } catch { return {}; } })();
      const nextMeta = { ...meta, status: "completed", reflection: meta.reflection || "Completed successfully during final synthesis.", updatedAt: new Date().toISOString() };
      await goalsStore.updateTaskDescription(task.id, JSON.stringify(nextMeta)).catch(() => undefined);
      await goalsStore.markTaskStatus(task.id, "completed").catch(() => undefined);
    }

    if (planTasks.length === 0 && userMessage.trim().length > 24) {
      const fallback = pendingTasks.slice(0, 3);
      for (const task of fallback) {
        const meta: any = (() => { try { return JSON.parse(task.description || "{}"); } catch { return {}; } })();
        const nextMeta = { ...meta, status: "completed", reflection: meta.reflection || "Task completed as part of the final resolution.", updatedAt: new Date().toISOString() };
        await goalsStore.updateTaskDescription(task.id, JSON.stringify(nextMeta)).catch(() => undefined);
        await goalsStore.markTaskStatus(task.id, "completed").catch(() => undefined);
      }
    }
  }

  private getFallbackTool(toolName: string): string[] {
    const normalize = toolName.toLowerCase();
    if (normalize.includes("search")) return ["browser_search", "url_read"];
    if (normalize.includes("browser")) return ["url_read", "search"];
    if (normalize.includes("calendar")) return ["google_calendar_events", "goal_view_tasks"];
    if (normalize.includes("gmail")) return ["google_gmail_messages", "search"];
    if (normalize.includes("whatsapp")) return ["whatsapp_outbox_history", "app_send_message", "app_send_audio_batch"];
    if (normalize.includes("fetch_news")) return ["search", "url_read"];
    return ["search", "browser_read"];
  }

  private describeToolForSkill(tool: string): string {
    return tool.replace(/_/g, " ");
  }

  private createAutoSkillName(userMessage: string): string {
    const words = userMessage
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    const base = words.length ? words.join("_") : "workflow";
    return `auto_${base}_${Math.random().toString(36).slice(2, 7)}`;
  }

  private generateAutoSkillTriggers(userMessage: string): string[] {
    const tokens = userMessage
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .filter((word) => !["the", "with", "and", "for", "from", "into", "this", "that"].includes(word));
    const candidates = new Set<string>([userMessage.trim()]);
    for (const token of tokens) candidates.add(token);
    const coreTriggers = Array.from(candidates)
      .filter((value) => value && value.trim().length > 2)
      .map((value) => value.trim())
      .slice(0, 5);
    return coreTriggers.length ? coreTriggers : ["workflow"];
  }

  private isTransientExecutionFailure(message: unknown): boolean {
    return /\b(?:408|425|429|5\d\d)\b|\b(?:timeout|timed out|temporarily unavailable|upstream|rate limit|resource exhausted|internal error|server error)\b|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(message || ""));
  }

  private async maybeAutoCreateSkill(
    userId: number | undefined,
    userMessage: string,
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ) {
    if (!userId) {
      info("[arisService] auto-skill skipped: no authenticated user");
      return;
    }
    if (this.isMorningBriefRequest(userMessage.toLowerCase())) {
      info("[arisService] auto-skill skipped: morning brief uses a dedicated workflow");
      return;
    }
    const successfulSteps = toolResults.filter((entry) => entry.result.success && entry.invocation.tool !== "_system");
    if (successfulSteps.length < 2) {
      info(`[arisService] auto-skill skipped: only ${successfulSteps.length} successful step(s)`);
      return;
    }
    const triggerCandidates = this.generateAutoSkillTriggers(userMessage);
    const generatedName = this.createAutoSkillName(userMessage);
    const existingSkills = await this.skillService.list(userId).catch((error: any) => {
      info(`[arisService] auto-skill lookup failed: ${error?.message || String(error)}`);
      return [];
    });
    const existingMatch = existingSkills.find((skill) =>
      skill.name === generatedName ||
      skill.triggers.some((trigger) => triggerCandidates.some((candidate) => candidate.toLowerCase() === trigger.toLowerCase())) ||
      skill.steps.length === successfulSteps.length && skill.steps.some((step) => successfulSteps.some((entry) => entry.invocation.tool === step.tool))
    );
    if (existingMatch) {
      const preferredTools = Array.from(new Set([
        ...(existingMatch.metadata?.preferredTools || []),
        ...successfulSteps.map((entry) => entry.invocation.tool),
      ]));
      const failurePatterns = Array.from(new Set([
        ...(existingMatch.metadata?.failurePatterns || []),
        ...toolResults.filter((entry) => !entry.result.success).map((entry) => `${entry.invocation.tool}:${entry.result.error || "unknown"}`),
      ])).slice(0, 10);
      const successRate = (existingMatch.successCount + 1)
        / Math.max(1, existingMatch.successCount + existingMatch.failureCount + 1);
      await this.skillService.revise(userId, existingMatch.name, {
        metadata: {
          preferredTools,
          relatedSkills: Array.from(new Set([...(existingMatch.metadata?.relatedSkills || []), ...existingSkills
            .filter((skill) => skill.name !== existingMatch.name && skill.steps.some((step) => successfulSteps.some((entry) => entry.invocation.tool === step.tool)))
            .map((skill) => skill.name)])),
          sideEffectTools: Array.from(new Set([...(existingMatch.metadata?.sideEffectTools || []), ...successfulSteps
            .filter((entry) => this.needsHumanApproval(entry.invocation))
            .map((entry) => entry.invocation.tool)])),
          successRate,
          failurePatterns,
          lastUpdated: new Date().toISOString(),
          lastOutcome: "success",
        },
      }, "active").catch(() => undefined);
      return;
    }

    const relatedSkills = existingSkills
      .filter((skill) => skill.steps.some((step) => successfulSteps.some((entry) => entry.invocation.tool === step.tool)))
      .map((skill) => skill.name)
      .filter((name) => name !== generatedName)
      .slice(0, 8);
    const definition = {
      name: generatedName,
      description: `Reusable workflow for: ${userMessage.trim()}`,
      triggers: triggerCandidates,
      steps: successfulSteps.map((entry) => ({
        tool: entry.invocation.tool,
        payload: entry.invocation.payload || {},
        requiresApproval: this.needsHumanApproval(entry.invocation),
      })),
      constraints: ["Side effects require the normal user approval gate.", "Do not bypass approval gates.", "Use the same input fields preserved from the successful run."],
      metadata: {
        preferredTools: Array.from(new Set(successfulSteps.map((entry) => entry.invocation.tool))),
        relatedSkills,
        sideEffectTools: successfulSteps.filter((entry) => this.needsHumanApproval(entry.invocation)).map((entry) => entry.invocation.tool),
        successRate: 1,
        failurePatterns: [],
        lastUpdated: new Date().toISOString(),
        lastOutcome: "success" as const,
      },
    };

    try {
      const saved = await this.skillService.createOrRevise(userId, definition, "active");
      info(`[arisService] auto-created skill=${saved.name} userId=${userId}`);
    } catch (error: any) {
      info(`[arisService] auto-skill creation skipped for userId=${userId}: ${error?.message || String(error)}`);
    }
  }

  private async maybeReviseSkillAfterRecovery(
    userId: number | undefined,
    userMessage: string,
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ) {
    if (!userId) return;
    const failedBeforeSuccess = toolResults.filter((entry) => !entry.result.success && entry.invocation.tool !== "_system");
    const recovered = toolResults.filter((entry) => entry.result.success && entry.invocation.tool !== "_system");
    if (!failedBeforeSuccess.length || !recovered.length) return;
    const skillList = await this.skillService.list(userId).catch(() => []);
    const relevantSkill = skillList.find((skill) =>
      skill.triggers.some((trigger) => trigger.trim().length > 2 && userMessage.toLowerCase().includes(trigger.toLowerCase())) ||
      skill.steps.some((step) => recovered.some((entry) => entry.invocation.tool === step.tool))
    );
    if (!relevantSkill) return;

    const recoveredTools = Array.from(new Set(recovered.map((entry) => entry.invocation.tool)));
    const learnedFallbacks = Array.from(new Set([
      ...(relevantSkill.metadata?.preferredTools || []),
      ...recoveredTools,
    ])).slice(0, 12);

    try {
      await this.skillService.revise(userId, relevantSkill.name, {
        metadata: {
          ...(relevantSkill.metadata || {}),
          preferredTools: learnedFallbacks,
          lastUpdated: new Date().toISOString(),
          lastOutcome: "success",
          successRate: (relevantSkill.successCount + 1) / Math.max(1, relevantSkill.successCount + relevantSkill.failureCount + 1),
        },
      }, "active");
      info(`[arisService] recovered skill=${relevantSkill.name} revised after failure-success cycle`);
    } catch (error: any) {
      info(`[arisService] recovered skill revision skipped: ${error?.message || String(error)}`);
    }
  }

  private async maybeReviseSkillFromFailure(
    userId: number | undefined,
    userMessage: string,
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ) {
    if (!userId) return;
    const failures = toolResults.filter((entry) => !entry.result.success && entry.invocation.tool !== "_system");
    const failed = failures.filter((entry) => !this.isTransientExecutionFailure(entry.result.error));
    if (failed.length === 0) {
      if (failures.length > 0) info("[arisService] skipped skill revision for transient upstream failure(s)");
      return;
    }
    const existingSkills = await this.skillService.list(userId).catch(() => []);
    if (!existingSkills.length) return;
    const matchingSkill = existingSkills.find((skill) =>
      skill.triggers.some((trigger) => trigger.trim().length > 2 && userMessage.toLowerCase().includes(trigger.toLowerCase())) ||
      skill.steps.some((step) => failed.some((entry) => entry.invocation.tool === step.tool))
    );
    if (!matchingSkill) return;

    const failurePatterns = Array.from(new Set([
      ...(matchingSkill.metadata?.failurePatterns || []).filter((pattern) => !this.isTransientExecutionFailure(pattern)),
      ...failed.map((entry) => `${entry.invocation.tool}:${entry.result.error || "unknown"}`),
    ])).slice(0, 12);

    try {
      await this.skillService.revise(userId, matchingSkill.name, {
        metadata: {
          ...(matchingSkill.metadata || {}),
          failurePatterns,
          lastUpdated: new Date().toISOString(),
          lastOutcome: "failure",
          successRate: matchingSkill.successCount
            ? matchingSkill.successCount / Math.max(1, matchingSkill.successCount + matchingSkill.failureCount)
            : 0,
        },
      }, "active");
      info(`[arisService] revised failed skill=${matchingSkill.name} userId=${userId}`);
    } catch (error: any) {
      info(`[arisService] skill revision skipped for userId=${userId}: ${error?.message || String(error)}`);
    }
  }

  private async maybeCompletePendingTasks(
    userId: number | undefined,
    userMessage: string,
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ) {
    if (!userId) return;
    const successful = toolResults.some((entry) => entry.result.success && entry.invocation.tool !== "_system");
    if (!successful) return;

    const { goalsStore } = await import("../db/goalsStore");
    const pendingTasks = await goalsStore.getPendingTasks(userId).catch(() => []);
    if (!pendingTasks.length) return;

    const phrase = userMessage.toLowerCase();
    const taskTitleMatches = pendingTasks.filter((task) => {
      const title = (task.title || "").toLowerCase();
      if (!title) return false;
      if (phrase.includes(title)) return true;
      const titleTokens = title.split(/[^a-z0-9]+/).filter(Boolean);
      return titleTokens.some((token) => phrase.includes(token) && token.length > 3);
    });

    if (!taskTitleMatches.length) return;
    for (const task of taskTitleMatches) {
      await goalsStore.markTaskStatus(task.id, "completed").catch(() => undefined);
    }
    info(`[arisService] completed ${taskTitleMatches.length} pending task(s) by request match userId=${userId}`);
  }

  private async prepareWhatsappNewsAudioApproval(userId: number | undefined, request: string): Promise<ArisResponse> {
    if (!userId) {
      return { arisReply: "I need an authenticated WhatsApp user before I can send the audio brief.", memoryUpdates: [], status: "error" };
    }

    try {
      const cacheKey = `${userId}:`;
      const day = new Date().toISOString().slice(0, 10);
      const cached = this.newsCache.get(cacheKey);
      const news = cached?.day === day
        ? cached.data
        : await this.newsService.getTopNews(undefined, 5);
      if (!cached || cached.day !== day) {
        this.newsCache.set(cacheKey, { day, data: news });
      }
      const summaryPrompt = [
        "Write a detailed but natural spoken news brief for an audio voice note.",
        "Use only the supplied headlines and sources. Do not mention tools, phone numbers, or inability to send WhatsApp.",
        "Return only the spoken script, about 90 to 150 seconds long.",
        `User request: ${request}`,
        `Stories: ${JSON.stringify(news)}`,
      ].join("\n");
      const scriptResponse = await this.gemmaService.requestArisAdvice(summaryPrompt);
      const script = this.cleanSpeechText(scriptResponse.reply);
      if (!script || script.length < 40) {
        throw new Error("News brief script generation returned too little text.");
      }

      return {
        arisReply: "I have prepared today's detailed news brief as a WhatsApp voice note. Reply APPROVE and I will send it.",
        memoryUpdates: [],
        status: "awaiting_approval",
        pendingAction: {
          tool: "audio_generate",
          payload: { destination: "whatsapp", text: script },
        },
      };
    } catch (error: any) {
      error && console.error("[arisService] WhatsApp news audio preparation failed:", error);
      return { arisReply: "I couldn't prepare the news audio brief right now.", memoryUpdates: [], status: "error" };
    }
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

    if (invocations.length > 0) {
      info(`[arisService] parsed ${invocations.length} tool invocation(s): ${invocations.map((invocation) => invocation.tool).join(", ")}`);
    } else {
      info("[arisService] parsed no tool invocations");
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
      text_to_speech: "audio_generate",
      texttospeech: "audio_generate",
      speech_to_text: "audio_generate",
      generate_audio: "audio_generate",
      generate_speech: "audio_generate",
      whatsapp_audio: "audio_generate",
      send_audio_on_whatsapp: "audio_generate",
      google_gmail_find_labels: "google_gmail_label",
      google_gmail_label_list: "google_gmail_label",
      google_gmail_settings_get: "google_gmail_settings",
      google_gmail_settings_update: "google_gmail_settings",
      whatsappsend_message: "app_send_message",
      app_send_message_v2: "app_send_message",
    };
    return aliases[normalized] || toolName.trim();
  }

  private normalizeToolPayload(payload: any): any {
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === "object") return this.normalizeToolPayload(parsed);
      } catch {
        // Keep non-JSON payloads unchanged.
      }
      return payload;
    }
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

    // Some model responses use a function-call style 'parameters' wrapper.
    // Tool handlers consume canonical top-level fields, so flatten it here.
    if (typeof flattened.parameters === "object" && flattened.parameters !== null) {
      const nested = flattened.parameters;
      delete flattened.parameters;
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

    if (flattened.text === undefined) {
      const speechText = flattened.input?.text || flattened.content || flattened.script || flattened.message;
      if (typeof speechText === "string") flattened.text = speechText;
    }
    if (flattened.destination === undefined && flattened.target !== undefined) {
      flattened.destination = flattened.target;
    }

    if (Array.isArray(flattened.audio_uris) && flattened.episodes === undefined) {
      flattened.episodes = flattened.audio_uris
        .map((uri: unknown) => String(uri).trim())
        .filter((uri: string) => uri.startsWith("drive:"))
        .map((storageUri: string) => ({ storageUri, mimeType: "audio/mpeg" }));
      delete flattened.audio_uris;
    }

    return flattened;
  }

  private normalizeToolInvocation(invocation: ToolInvocation): ToolInvocation {
    const tool = this.normalizeToolName(invocation.tool);
    const payload = this.normalizeToolPayload(invocation.payload);
    if ((tool === "browser_read" || tool === "url_read") && payload?.url === undefined && typeof payload?.param1 === "string") {
      payload.url = payload.param1;
      delete payload.param1;
    }
    return {
      tool,
      payload,
    };
  }

  private applyRequestSpecificDefaults(invocation: ToolInvocation, userMessage: string, sessionId: string): ToolInvocation {
    if (invocation.tool !== "audio_generate") {
      return invocation;
    }

    const requestsWhatsappAudio = /\bwhatsapp\b|\bvoice\s+note\b/i.test(userMessage);
    const destination = invocation.payload?.destination ||
      (requestsWhatsappAudio || sessionId === "whatsapp-direct" ? "whatsapp" : undefined);

    return {
      ...invocation,
      payload: {
        ...invocation.payload,
        ...(destination ? { destination } : {}),
        requestText: userMessage,
      },
    };
  }

  private getStableAudioType(requestText: string): string | undefined {
    const normalized = requestText.toLowerCase();
    if (/(who are you|what is your name|what's your name|tell me your name|introduc(?:e|ing) yourself)/i.test(normalized)) {
      return "aris_identity_intro";
    }
    if (/(what can you do|what do you do|your capabilities|everything you can do|how can you help me)/i.test(normalized)) {
      return "aris_capabilities_intro";
    }
    return undefined;
  }

  private isReusableAudioMatch(type: string, record: { sourceType: string; sourceText: string }): boolean {
    if (record.sourceType === type) return true;
    const text = record.sourceText.toLowerCase();
    if (type === "aris_identity_intro") {
      return /\baris\b/.test(text) && /(digital friend|expert advisor|life coach|whatsapp)/.test(text);
    }
    return /(what i can do|can help you|right here on whatsapp|capabilities)/.test(text);
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

  private getAlternativeTools(toolName: string): string[] {
    const alternatives: Record<string, string[]> = {
      search: ["browser_search"],
      browser_search: ["search"],
      browser_read: ["url_read"],
      url_read: ["browser_read"],
      fetch_news: ["search", "browser_search"],
      fetch_news_podcast: ["fetch_news", "search"],
      whatsapp_summary: ["whatsapp_history"],
      weather_forecast: ["search", "browser_search"],
      weather_historical: ["search", "browser_search"],
      weather_air_quality: ["search", "browser_search"],
      weather_marine: ["search", "browser_search"],
      tomtom_route: ["search", "browser_search"],
      tomtom_flow: ["search", "browser_search"],
      tomtom_incidents: ["search", "browser_search"],
      tomtom_traffic: ["search", "browser_search"],
    };

    return (alternatives[toolName] || []).filter((alternative) => this.supportedToolNames.has(alternative));
  }

  private validateToolPayload(toolName: string, payload: any): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    switch (toolName) {
      case "audio_generate":
        if (!payload.text || typeof payload.text !== "string" || !payload.text.trim()) {
          return "audio_generate requires a non-empty 'text' string.";
        }
        if (payload.destination && !["download", "app", "email", "whatsapp"].includes(String(payload.destination).toLowerCase())) {
          return "audio_generate destination must be download, app, email, or whatsapp.";
        }
        break;
      case "fetch_news":
        if (payload.topic && typeof payload.topic !== "string") {
          return "fetch_news requires an optional 'topic' string.";
        }
        break;
      case "fetch_news_podcast":
        if (payload.feedUrl && typeof payload.feedUrl !== "string") {
          return "fetch_news_podcast requires an optional 'feedUrl' string.";
        }
        break;
      case "search":
        if (!payload.query || typeof payload.query !== "string" || !payload.query.trim()) {
          return "search requires a non-empty 'query' string.";
        }
        if (payload.domains !== undefined && !Array.isArray(payload.domains) && typeof payload.domains !== "string") return "search domains must be a string or string array.";
        if (payload.excludeDomains !== undefined && !Array.isArray(payload.excludeDomains) && typeof payload.excludeDomains !== "string") return "search excludeDomains must be a string or string array.";
        if (payload.site !== undefined && typeof payload.site !== "string") return "search site must be a domain string.";
        if (payload.exactPhrase !== undefined && typeof payload.exactPhrase !== "string") return "search exactPhrase must be a string.";
        if (payload.location !== undefined && typeof payload.location !== "string") return "search location must be a string.";
        if (payload.timeRange && !["day", "week", "month", "year"].includes(String(payload.timeRange))) return "search timeRange must be day, week, month, or year.";
        for (const field of ["after", "before", "intitle", "inurl", "filetype"]) {
          if (payload[field] !== undefined && typeof payload[field] !== "string") return `search ${field} must be a string.`;
        }
        break;
      case "browser_search":
        if (!payload.query || typeof payload.query !== "string" || !payload.query.trim()) {
          return "browser_search requires a non-empty 'query' string.";
        }
        if (payload.domains !== undefined && !Array.isArray(payload.domains) && typeof payload.domains !== "string") return "browser_search domains must be a string or string array.";
        if (payload.excludeDomains !== undefined && !Array.isArray(payload.excludeDomains) && typeof payload.excludeDomains !== "string") return "browser_search excludeDomains must be a string or string array.";
        if (payload.site !== undefined && typeof payload.site !== "string") return "browser_search site must be a domain string.";
        if (payload.exactPhrase !== undefined && typeof payload.exactPhrase !== "string") return "browser_search exactPhrase must be a string.";
        if (payload.location !== undefined && typeof payload.location !== "string") return "browser_search location must be a string.";
        if (payload.timeRange && !["day", "week", "month", "year"].includes(String(payload.timeRange))) return "browser_search timeRange must be day, week, month, or year.";
        for (const field of ["after", "before", "intitle", "inurl", "filetype"]) {
          if (payload[field] !== undefined && typeof payload[field] !== "string") return `browser_search ${field} must be a string.`;
        }
        break;
      case "skill_create":
      case "skill_revise":
        if (!payload.definition && !payload.name) {
          return `${toolName} requires a skill definition with name, description, triggers, and steps.`;
        }
        break;
      case "skill_run":
        if (!(payload.name || payload.skill)) {
          return "skill_run requires a skill name.";
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

  private async executeToolCall(userId: number | undefined, invocation: ToolInvocation, sessionId?: string, replyToWhatsappMessage?: unknown): Promise<ToolExecutionResult> {
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

    if (toolName === "vault_store") {
      try {
        const { key, value } = invocation.payload || {};
        if (!key || !value) throw new Error("vault_store requires 'key' and 'value'");
        if (!userId) throw new Error("vault_store requires an authenticated userId");
        const { VaultStore } = await import("../db/vaultStore");
        const pool = (await import("../db/db")).getDatabasePool();
        const vault = new VaultStore(pool);
        await vault.storeSecret(userId, key, String(value));
        return {
          success: true,
          tool: toolName,
          data: `Securely stored "${key}" in your encrypted vault.`,
        };
      } catch (e: any) {
        return { success: false, tool: toolName, error: e.message };
      }
    }

    if (toolName === "vault_retrieve") {
      try {
        const { key } = invocation.payload || {};
        if (!key) throw new Error("vault_retrieve requires 'key'");
        if (!userId) throw new Error("vault_retrieve requires an authenticated userId");
        const { VaultStore } = await import("../db/vaultStore");
        const pool = (await import("../db/db")).getDatabasePool();
        const vault = new VaultStore(pool);
        const value = await vault.retrieveSecret(userId, key);
        if (value === null) {
          return { success: false, tool: toolName, error: `No vault entry found for key: "${key}". Has it been stored yet?` };
        }
        return {
          success: true,
          tool: toolName,
          data: `Vault entry for "${key}": ${value}`,
        };
      } catch (e: any) {
        return { success: false, tool: toolName, error: e.message };
      }
    }

    if (toolName === "join_meeting") {
      let meetingBot: any = null;
      try {
        const url = invocation.payload?.url;
        if (!url) throw new Error("Missing 'url' in payload");
        
        // Dynamic import to avoid circular dependencies or massive imports
        const { MeetingBotService } = require('./meetingBotService');
        meetingBot = new MeetingBotService();

        await meetingBot.joinMeeting(url, "Aris (Notetaker)", userId);

        const plannerService = require('../backgroundJobs').plannerServiceInstance;
        if (plannerService) {
          plannerService.startMeeting(url, meetingBot, userId);
        }
        
        return {
          success: true,
          tool: toolName,
          data: `Successfully dispatched Aris to join ${url}. It will take notes and email them when finished.`,
        };
      } catch (e: any) {
        if (meetingBot?.isActive?.()) meetingBot.leaveMeeting();
        return { success: false, tool: toolName, error: e.message };
      }
    }

    if (toolName === "fetch_news") {
      try {
        const topic = invocation.payload?.topic;
        const limit = invocation.payload?.limit || 5;
        const cacheKey = `${userId ?? "anonymous"}:${String(topic || "").trim().toLowerCase()}`;
        const day = new Date().toISOString().slice(0, 10);
        const cached = this.newsCache.get(cacheKey);
        const newsData = cached?.day === day
          ? cached.data
          : await this.newsService.getTopNews(topic, limit);
        if (!cached || cached.day !== day) {
          this.newsCache.set(cacheKey, { day, data: newsData });
        }
        await this.persistNewsResearch(
          userId,
          sessionId,
          topic ? `news: ${topic}` : "today's news",
          (newsData as any[]).map((item) => ({
            title: item.title,
            url: item.link,
            source: item.source,
            publishedAt: item.pubDate,
          }))
        );
        return {
          success: true,
          tool: toolName,
          data: { items: newsData, cached: cached?.day === day },
        };
      } catch (e: any) {
        return { success: false, tool: toolName, error: e.message };
      }
    }

    if (toolName === "fetch_news_podcast") {
      try {
        if (invocation.payload?.batch === true) {
          if (!userId) return { success: false, tool: toolName, error: "Sign in before storing podcasts in Google Drive." };
          const account = await this.googleAccountStore.getGoogleAccount(userId);
          if (!account) return { success: false, tool: toolName, error: "Connect your Google account to store podcasts in Google Drive." };
          const persistTokens = async (tokens: any) => this.googleAccountStore.updateGoogleTokens(
            userId, tokens.access_token ?? undefined, tokens.refresh_token ?? undefined, tokens.expiry_date ?? undefined, tokens.scope ?? undefined
          );
          const candidates = await this.newsService.getBestPodcastCandidates(4);
          const stored = await Promise.all(candidates.map(async (candidate) => {
            const cached = await podcastMediaStore.findByEpisodeUrl(candidate.episodeUrl);
            if (cached) {
              info(`[arisService] Reusing cached podcast show=${cached.feedName} episode=${cached.episodeUrl}`);
              return { ...cached, analysisWarning: "" };
            }

            const episode = await this.newsService.downloadPodcastCandidate(candidate);
            let analysis = "";
            let analysisWarning = "";
            try {
              const analysisResponse = await this.gemmaService.requestArisAdvice(
                [
                  "Listen to this podcast audio and transcribe its important content for Aris.",
                  "Identify the main stories, people, places, dates, claims, and useful follow-up facts.",
                  "Return only a concise factual spoken-style summary. Do not mention tools, transcription APIs, or these instructions.",
                  `Podcast show: ${episode.feedName}`,
                  `Episode title: ${episode.title}`,
                  `Published: ${episode.publishedAt}`,
                ].join("\n"),
                [{ inlineData: { mimeType: episode.mimeType.split(";")[0], data: episode.audio.toString("base64") } }]
              );
              analysis = analysisResponse.reply.trim();
              info(`[arisService] Gemma batch podcast analysis completed show=${episode.feedName} audioBytes=${episode.audio.length} contextChars=${analysis.length}`);
            } catch (analysisError: any) {
              analysisWarning = analysisError?.message || "Gemma podcast analysis failed.";
              error(`[arisService] Gemma batch podcast analysis failed show=${episode.feedName}; delivery will continue: ${analysisWarning}`);
            }

            const mimeType = episode.mimeType.split(";")[0].toLowerCase();
            const extension = mimeType.includes("ogg") || mimeType.includes("opus") ? "ogg" : mimeType.includes("wav") ? "wav" : "mp3";
            const safeTitle = episode.title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 70) || "news-podcast";
            const driveFile = await this.googleService.uploadDriveFile(account, `${safeTitle}-${Date.now()}.${extension}`, mimeType, episode.audio, persistTokens, true);
            if (!driveFile.id) throw new Error(`Google Drive did not return a file ID for ${episode.feedName}.`);
            const record = {
              feedName: episode.feedName,
              feedUrl: episode.feedUrl,
              episodeUrl: episode.episodeUrl,
              title: episode.title,
              publishedAt: episode.publishedAt,
              mimeType,
              storageUri: `drive:${driveFile.id}`,
              analysis,
            };
            await podcastMediaStore.upsert(record);
            return { ...record, analysisWarning };
          }));
          await this.memoryStore.storeMemoryEntry(userId, sessionId, `Podcast catalog delivered on ${new Date().toISOString()}: ${stored.map((episode) => `${episode.feedName} - ${episode.title}: ${episode.analysis || "Analysis unavailable"}`).join(" | ")}. Ask the user which podcasts they enjoyed to build a custom list.`).catch((memoryError) => error("[arisService] Podcast catalog memory failed", memoryError));
          return { success: true, tool: toolName, data: { episodes: stored, summary: `Prepared ${stored.length} podcast episodes; reused previously downloaded episodes when available. NPR is included.`, askPreference: "After delivery, ask the user which podcasts they enjoyed so Aris can build a custom list." } };
        }
        const episode = await this.newsService.downloadLatestPodcast(invocation.payload?.feedUrl);
        const safeTitle = episode.title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "news-podcast";
        let storageUri: string | undefined;
        let storageWarning: string | undefined;
        try {
          if (!userId) throw new Error("Sign in before storing the podcast in Google Drive.");
          const account = await this.googleAccountStore.getGoogleAccount(userId);
          if (!account) throw new Error("Connect your Google account to store the podcast in Google Drive.");
          const persistTokens = async (tokens: any) => {
            await this.googleAccountStore.updateGoogleTokens(
              userId,
              tokens.access_token ?? undefined,
              tokens.refresh_token ?? undefined,
              tokens.expiry_date ?? undefined,
              tokens.scope ?? undefined
            );
          };
          const mimeType = episode.mimeType.split(";")[0].toLowerCase();
          const extension = mimeType === "audio/ogg" || mimeType.includes("opus")
            ? "ogg"
            : mimeType === "audio/wav" || mimeType === "audio/x-wav"
              ? "wav"
              : mimeType === "audio/mp4" || mimeType === "audio/aac"
                ? "m4a"
                : "mp3";
          const driveFile = await this.googleService.uploadDriveFile(
            account,
            `${safeTitle}-${Date.now()}.${extension}`,
            mimeType,
            episode.audio,
            persistTokens,
            true
          );
          if (!driveFile.id) throw new Error("Google Drive did not return a file ID.");
          storageUri = `drive:${driveFile.id}`;
        } catch (storageError: any) {
          storageWarning = storageError?.message || "Google Drive podcast storage failed.";
          error(`[arisService] Google Drive podcast storage failed: ${storageWarning}`);
        }

        let transcript = "";
        let analysisWarning: string | undefined;
        try {
          const analysisResponse = await this.gemmaService.requestArisAdvice(
            [
              "Listen to this news podcast audio and create concise context for Aris.",
              "Identify the main stories, people, places, dates, claims, and useful follow-up facts.",
              "Do not mention tools, transcription APIs, internal reasoning, or these instructions.",
              "Return only a clear factual spoken-style summary.",
              `Podcast title: ${episode.title}`,
              `Published: ${episode.publishedAt}`,
            ].join("\n"),
            [{ inlineData: { mimeType: episode.mimeType.split(";")[0], data: episode.audio.toString("base64") } }]
          );
          transcript = analysisResponse.reply.trim();
          info(`[arisService] Gemma podcast analysis completed audioBytes=${episode.audio.length} contextChars=${transcript.length}`);
        } catch (analysisError: any) {
          analysisWarning = analysisError?.message || "Gemma podcast analysis failed.";
          error(`[arisService] Gemma podcast analysis failed; delivery will continue: ${analysisWarning}`);
        }

        let memoryWarning: string | undefined;
        try {
          await this.memoryStore.storeMemoryEntry(
            userId,
            sessionId,
            `News podcast downloaded on ${new Date().toISOString()}: ${episode.title}. Published ${episode.publishedAt}. Google Drive reference: ${storageUri || "unavailable"}. Key multimodal context: ${transcript.slice(0, 5000) || "Analysis unavailable; original audio was stored when possible."}`
          );
        } catch (memoryError: any) {
          memoryWarning = memoryError?.message || "Podcast memory storage failed.";
          error(`[arisService] Podcast memory storage failed: ${memoryWarning}`);
        }

        return {
          success: true,
          tool: toolName,
          data: {
            title: episode.title,
            feedUrl: episode.feedUrl,
            episodeUrl: episode.episodeUrl,
            publishedAt: episode.publishedAt,
            transcript: transcript.slice(0, 16000),
            transcriptTruncated: transcript.length > 16000,
            storageUri,
            contextSource: transcript ? "gemma_multimodal_audio" : "audio_only",
            warnings: [storageWarning, analysisWarning, memoryWarning].filter(Boolean),
            delivery: "Use app_send_message for a text summary or google_gmail_send for an email summary. Use the existing approval flow for delivery.",
          },
        };
      } catch (e: any) {
        return { success: false, tool: toolName, error: e.message || "Failed to fetch or listen to the news podcast." };
      }
    }

    if (toolName === "search") {
      if (!searchToolEnabled) {
        return { success: false, tool: toolName, error: "Search tool is disabled." };
      }

      try {
        const query = String(invocation.payload?.query || "").trim();
        info(`[arisService] search executing query="${query}"`);
        const searchResponse = await this.searchClient.search({
          ...this.getAdvancedSearchPayload(invocation.payload),
          query,
          engines: searchEngineList,
          limit: 5,
        });

        const extractResponse = await this.attemptUrlExtraction(searchResponse);
        const extractedByUrl = new Map(
          (extractResponse?.results || []).map((item) => [item.url, item])
        );
        await this.persistNewsResearch(
          userId,
          sessionId,
          query,
          searchResponse.results.map((item) => {
            const extracted = extractedByUrl.get(item.url);
            return {
              title: item.title,
              url: item.url,
              source: item.engine,
              snippet: item.snippet,
              content: extracted?.content,
            };
          })
        );
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

    if (toolName === "app_send_message") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const body = invocation.payload?.message || invocation.payload?.body || invocation.payload?.text;
        if (!body) return { success: false, tool: toolName, error: "app_send_message requires a message string." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        // to_jid="app": app-bound row — Baileys skips it; Android polls /api/aris/outbox
        await whatsappOutboxStore.enqueue("app", "text", String(body), undefined, undefined, userId, invocation.payload?.quotedMessage);
        return { success: true, tool: toolName, data: { summary: "Message queued for delivery to your Aris app." } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to queue message." };
      }
    }

    if (toolName === "morning_brief_send") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const message = String(invocation.payload?.message || "").trim();
        const audioText = String(invocation.payload?.audioText || message).trim();
        if (!message || !audioText) return { success: false, tool: toolName, error: "Morning brief text and audio text are required." };

        // App delivery (original path)
        const textResult = await this.executeToolCall(userId, {
          tool: "app_send_message",
          payload: { message },
        }, sessionId, replyToWhatsappMessage);
        if (!textResult.success) return { success: false, tool: toolName, error: textResult.error };

        const audioResult = await this.executeToolCall(userId, {
          tool: "audio_generate",
          payload: { destination: "app", text: audioText, requestText: "morning brief" },
        }, sessionId, replyToWhatsappMessage);
        if (!audioResult.success) return { success: false, tool: toolName, error: audioResult.error };

        const podcastEpisodes = Array.isArray(invocation.payload?.podcastEpisodes)
          ? invocation.payload.podcastEpisodes
          : [];
        let podcastResult: ToolExecutionResult | undefined;
        if (podcastEpisodes.length) {
          podcastResult = await this.executeToolCall(userId, {
            tool: "app_send_audio_batch",
            payload: { episodes: podcastEpisodes },
          }, sessionId, replyToWhatsappMessage);
          if (!podcastResult.success) return { success: false, tool: toolName, error: podcastResult.error };
        }

        return {
          success: true,
          tool: toolName,
          data: {
            summary: "Complete morning brief queued: text, matching audio, and podcast episodes.",
            text: textResult.data,
            audio: audioResult.data,
            podcasts: podcastResult?.data,
          },
        };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to deliver the morning brief." };
      }
    }

    if (toolName === "app_send_audio") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const driveRef = String(invocation.payload?.driveRef || "");
        if (!driveRef.startsWith("drive:")) return { success: false, tool: toolName, error: "app_send_audio requires a Google Drive media reference." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        // to_jid="app": app-bound row — Baileys skips it; Android polls /api/aris/outbox
        const queued = await whatsappOutboxStore.enqueue(
          "app",
          "audio",
          undefined,
          driveRef,
          String(invocation.payload?.mimeType || "audio/mpeg"),
          userId,
          replyToWhatsappMessage
        );
        return { success: true, tool: toolName, data: { summary: "Audio queued for delivery to your Aris app.", outboxId: queued.id } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to queue audio." };
      }
    }

    if (toolName === "app_send_audio_batch") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const episodes = Array.isArray(invocation.payload?.episodes) ? invocation.payload.episodes : [];
        if (!episodes.length) return { success: false, tool: toolName, error: "No podcast episodes were provided." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        const outboxIds: number[] = [];
        for (const episode of episodes) {
          // to_jid="app": app-bound row — Baileys skips it; Android polls /api/aris/outbox
          const queued = await whatsappOutboxStore.enqueue("app", "audio", undefined, episode.storageUri, episode.mimeType || "audio/mpeg", userId, replyToWhatsappMessage);
          outboxIds.push(queued.id);
        }
        return { success: true, tool: toolName, data: { summary: `Queued ${outboxIds.length} podcast episodes for Aris app delivery. After listening, ask the user which ones they enjoyed to build a custom podcast list.`, outboxIds } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to deliver podcast episodes." };
      }
    }

    if (toolName === "whatsapp_outbox_history") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        const messages = await whatsappOutboxStore.getAllForUser(userId);
        const summary = messages.length === 0
          ? "Your Aris app outbox is empty."
          : messages.map((message) => {
              const createdAt = new Date(message.createdAt).toLocaleString("en-US");
              const sentAt = message.sentAt ? new Date(message.sentAt).toLocaleString("en-US") : "not sent";
              const body = message.body || `[${message.messageType}]`;
              return `#${message.id} [${message.status}] ${createdAt} -> ${message.toJid}\n${body}\nSent: ${sentAt}`;
            }).join("\n\n");
        return {
          success: true,
          tool: toolName,
          data: { summary: `Aris app outbox (${messages.length} message(s), all statuses):\n\n${summary}`, messages },
        };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to read Aris app outbox history." };
      }
    }

    if (toolName === "whatsapp_outbox_cleanup") {
      try {
        if (!userId) return { success: false, tool: toolName, error: "User not authenticated." };
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        const cleared = await whatsappOutboxStore.clearPending(userId);
        return { success: true, tool: toolName, data: { summary: `Cleared ${cleared} pending WhatsApp outbox message(s).` } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to clear Aris app outbox." };
      }
    }

    if (toolName === "url_read") {
      try {
        const raw = invocation.payload?.url || invocation.payload?.urls;
        if (!raw) return { success: false, tool: toolName, error: "url_read requires a 'url' string or 'urls' array." };
        const urls: string[] = Array.isArray(raw) ? raw : [String(raw)];
        const limitPerArticle: number = invocation.payload?.limit || 3000;

        const browserResults = await this.researchBrowserService.readUrls(urls);
        const readable = browserResults
          .filter((result) => result.content.length > 100)
          .map((result) => ({ url: result.finalUrl || result.url, title: result.title, content: result.content }));
        const fallback = readable.length > 0 ? undefined : await this.extractClient.extract({ urls, limit: limitPerArticle });
        const fallbackReadable = fallback?.results.filter(r => !r.error && r.content && r.content.length > 100) || [];
        const finalReadable = readable.length > 0 ? readable : fallbackReadable;
        if (finalReadable.length === 0) {
          return { success: false, tool: toolName, error: "Could not extract readable content from the provided URL(s). The page may require JavaScript or block scraping." };
        }

        const resultSummary = finalReadable.map(r => `**${r.title || r.url}**\n${r.content.slice(0, limitPerArticle)}`).join("\n\n---\n\n");
        await this.persistNewsResearch(
          userId,
          sessionId,
          `url_read: ${urls.join(", ")}`,
          finalReadable.map((article) => ({
            title: article.title || article.url,
            url: article.url,
            content: article.content,
          }))
        );
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return { success: true, tool: toolName, data: { summary: resultSummary, results: finalReadable.map(r => ({ url: r.url, title: r.title, content: r.content.slice(0, limitPerArticle) })), method: readable.length > 0 ? "headless-browser" : "extract-service" } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to read URL." };
      }
    }

    if (toolName === "browser_read") {
      try {
        const raw = invocation.payload?.url || invocation.payload?.urls;
        if (!raw) return { success: false, tool: toolName, error: "browser_read requires a 'url' string or 'urls' array." };
        const urls = (Array.isArray(raw) ? raw : [raw]).map(String);
        info(`[arisService] browser_read starting batch size=${urls.length} includeScreenshot=${Boolean(invocation.payload?.includeScreenshot)} urls=${JSON.stringify(urls)}`);
        const results = await this.researchBrowserService.readUrls(urls, Boolean(invocation.payload?.includeScreenshot));
        const readableResults = results.filter((result) => result.content.trim().length > 0);
        if (readableResults.length === 0) {
          const warnings = results.flatMap((result) => result.warnings).join(" ");
          error(`[arisService] browser_read produced no readable results batchSize=${urls.length} warnings=${warnings}`);
          return { success: false, tool: toolName, error: warnings || "Browser could not extract readable content from the provided URL(s)." };
        }
        await this.persistNewsResearch(
          userId,
          sessionId,
          `browser_read: ${urls.join(", ")}`,
          readableResults.map((article) => ({
            title: article.title || article.url,
            url: article.finalUrl || article.url,
            content: article.content,
          }))
        );
        this.recordLastToolInvocation(userId, sessionId, invocation);
        info(`[arisService] browser_read completed readable=${readableResults.length} failed=${results.length - readableResults.length}`);
        return { success: true, tool: toolName, data: { results: readableResults, summary: readableResults.map((result) => `${result.title}\n${result.content}`).join("\n\n---\n\n") } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Browser read failed." };
      }
    }

    if (toolName === "browser_action") {
      try {
        const action = invocation.payload?.action || invocation.payload;
        const result = await this.researchBrowserService.act(action);
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return { success: result.success !== false, tool: toolName, data: result, error: result.success === false ? String(result.error) : undefined };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Browser action failed." };
      }
    }

    if (toolName === "browser_search") {
      try {
        const query = String(invocation.payload?.query || "").trim();
        if (!query) return { success: false, tool: toolName, error: "browser_search requires a non-empty query." };
        const limit = Math.min(Math.max(Number(invocation.payload?.limit || 8), 1), 12);
        const result = await this.researchBrowserService.search(this.buildAdvancedSearchQuery(invocation.payload), limit);
        if (result.results.length === 0) {
          return { success: false, tool: toolName, error: "Browser search returned no results. Try the general search tool or a more specific query." };
        }
        await this.persistNewsResearch(
          userId,
          sessionId,
          `browser_search: ${query}`,
          result.results.map((article) => ({
            title: article.title,
            url: article.url,
            snippet: article.snippet,
          }))
        );
        this.recordLastToolInvocation(userId, sessionId, invocation);
        return { success: true, tool: toolName, data: result };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Browser search failed." };
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
          resultData = await this.locationService.getCurrentLocation(true, userId);
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

    if (toolName === "skill_list") {
      try {
        return { success: true, tool: toolName, data: { skills: await this.skillService.list(userId) } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to list skills." };
      }
    }

    if (toolName === "skill_create" || toolName === "skill_revise") {
      try {
        const definition = invocation.payload?.definition || invocation.payload;
        const saved = await this.skillService.createOrRevise(userId, definition, invocation.payload?.status === "draft" ? "draft" : "active");
        return { success: true, tool: toolName, data: { summary: `Skill ${saved.name} version ${saved.version} saved to PostgreSQL and private Google Drive.`, skill: saved } };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to save skill." };
      }
    }

    if (toolName === "skill_run") {
      try {
        const name = String(invocation.payload?.name || invocation.payload?.skill || "").trim();
        if (!name) return { success: false, tool: toolName, error: "skill_run requires a skill name." };
        const skillDepth = Number(invocation.payload?._skillDepth || 0);
        if (skillDepth >= 3) return { success: false, tool: toolName, error: "Skill navigation depth limit reached." };
        const input = invocation.payload?.input && typeof invocation.payload.input === "object" ? invocation.payload.input : {};
        const approvedSkill = invocation.payload?._approved === true;
        const result = await this.skillService.execute(userId, name, input, async (stepTool, stepPayload) => {
          const stepInvocation = this.normalizeToolInvocation({
            tool: stepTool,
            payload: stepTool === "skill_run"
              ? { ...stepPayload, _skillDepth: skillDepth + 1, _approved: approvedSkill }
              : stepPayload,
          });
          if (!approvedSkill && this.needsHumanApproval(stepInvocation, sessionId)) {
            return { success: false, tool: stepTool, error: `Skill step requires user approval: ${stepTool}` };
          }
          return this.executeToolCall(userId, stepInvocation, sessionId, replyToWhatsappMessage);
        });
        return { success: result.error ? false : true, tool: toolName, data: result, error: result.error };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Failed to execute skill." };
      }
    }

    if (toolName === "audio_generate") {
      try {
        const requestedDestination = String(invocation.payload?.destination || "").toLowerCase();
        const destination = sessionId === "whatsapp-direct" && requestedDestination !== "email"
          ? "whatsapp"
          : requestedDestination || "download";
        const rawText = String(invocation.payload.text);
        const text = this.cleanSpeechText(rawText);
        info(`[arisService] audio_generate cleaned speech rawChars=${rawText.length} speechChars=${text.length}`);
        if (!text || text === "..." || text === "…" || text.length < 3) {
          return { success: false, tool: toolName, error: "Audio text must contain the actual brief or message, not a placeholder." };
        }
        const isAppSession = sessionId?.startsWith("aris-android") || sessionId === "aris-android-chat";
        const encoding = (destination === "whatsapp") ? "OGG_OPUS" : "MP3";
        const speechChunks = destination === "whatsapp"
          ? this.splitTextForSynthesis(text)
          : [text];
        if (destination !== "whatsapp" && text.length > 11000) {
          return {
            success: false,
            tool: toolName,
            error: "This audio destination requires a single file. Use WhatsApp delivery for long text so Aris can send ordered voice-note parts.",
          };
        }

        // "app" or "download" destination: synthesize and return inline base64
        // On android sessions, default to "app" so the audio shows directly in chat
        if (destination === "app" || destination === "download" || (isAppSession && destination !== "whatsapp" && destination !== "email")) {
          const voice = await this.voiceService.synthesizeSpeech(speechChunks[0], encoding);
          return {
            success: true,
            tool: toolName,
            data: {
              audioBase64: voice.audioBase64,
              mimeType: voice.mimeType,
              audioEncoding: encoding,
              sourceText: text,
              sourceType: "aris_generated_audio",
            },
          };
        }

        const stableAudioType = this.getStableAudioType(String(invocation.payload?.requestText || ""));
        if (destination === "whatsapp" && stableAudioType && userId) {
          const existingAudio = await audioContextStore.getRecentForUser(userId, 50);
          const matchingAudio = existingAudio.find((record) => this.isReusableAudioMatch(stableAudioType, record));
          if (matchingAudio) {
            const { getSelfJid } = await import("../db/whatsappAuthStore");
            const selfJid = await getSelfJid();
            if (!selfJid) {
              return { success: false, tool: toolName, error: "Connect your WhatsApp self-chat before sending a voice note." };
            }
            const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
            const referenceCreatedAt = matchingAudio.createdAt?.getTime() ?? 0;
            const reusableAudio = existingAudio
              .filter((record) => {
                if (record.sourceType !== matchingAudio.sourceType || record.chunkCount !== matchingAudio.chunkCount) return false;
                if (!referenceCreatedAt || !record.createdAt) return true;
                return Math.abs(record.createdAt.getTime() - referenceCreatedAt) <= 5 * 60 * 1000;
              })
              .sort((left, right) => left.chunkIndex - right.chunkIndex);
            const queuedIds: number[] = [];
            for (const record of reusableAudio) {
              const queued = await whatsappOutboxStore.enqueue(
                selfJid,
                "audio",
                undefined,
                record.storageUri,
                record.mimeType,
                userId,
                replyToWhatsappMessage
              );
              queuedIds.push(queued.id);
            }
            info(`[arisService] Reusing stable audio type=${stableAudioType} chunks=${reusableAudio.length}`);
            return {
              success: true,
              tool: toolName,
              data: {
                summary: reusableAudio.length > 1
                  ? `Queued ${reusableAudio.length} existing voice-note parts for your connected WhatsApp self-chat.`
                  : "Queued an existing voice note for your connected WhatsApp self-chat.",
                outboxIds: queuedIds,
                reused: true,
                sourceType: stableAudioType,
              },
            };
          }
        }

        const account = await this.googleAccountStore.getGoogleAccount(userId);
        if (!account) {
          return { success: false, tool: toolName, error: "Connect your Google account before sending generated audio." };
        }
        const persistTokens = async (tokens: any) => {
          await this.googleAccountStore.updateGoogleTokens(
            userId,
            tokens.access_token ?? undefined,
            tokens.refresh_token ?? undefined,
            tokens.expiry_date ?? undefined,
            tokens.scope ?? undefined
          );
        };

        if (destination === "email") {
          const voice = await this.voiceService.synthesizeSpeech(speechChunks[0], encoding);
          const to = String(invocation.payload.to || invocation.payload.recipient || "").trim();
          if (!to) return { success: false, tool: toolName, error: "audio_generate email delivery requires a 'to' address." };
          const subject = String(invocation.payload.subject || "Audio from Aris").trim();
          const body = String(invocation.payload.body || "Audio generated by Aris.").trim();
          const filename = String(invocation.payload.filename || "aris-audio.mp3").replace(/[^a-zA-Z0-9._-]/g, "_");
          const sent = await this.googleService.sendEmail(
            account,
            to,
            subject,
            body,
            { filename, mimeType: voice.mimeType, contentBase64: voice.audioBase64 },
            persistTokens
          );
          return { success: true, tool: toolName, data: { summary: `Audio emailed to ${to}.`, messageId: sent.id } };
        }

        const { getSelfJid } = await import("../db/whatsappAuthStore");
        const selfJid = await getSelfJid();
        if (!selfJid) {
          return { success: false, tool: toolName, error: "Connect your WhatsApp self-chat before sending a voice note." };
        }
        const { whatsappOutboxStore } = await import("../db/whatsappOutboxStore");
        const queuedIds: number[] = [];
        for (let index = 0; index < speechChunks.length; index += 1) {
          const voice = await this.voiceService.synthesizeSpeech(speechChunks[index], encoding);
          const driveFile = await this.googleService.uploadDriveFile(
            account,
            `aris-audio-${Date.now()}-${index + 1}.ogg`,
            voice.mimeType,
            Buffer.from(voice.audioBase64, "base64"),
            persistTokens
          );
          if (!driveFile.id) throw new Error("Google Drive did not return an audio file ID.");
          const storageUri = `drive:${driveFile.id}`;
          await audioContextStore.upsert({
            userId,
            storageUri,
            mimeType: voice.mimeType,
            sourceType: stableAudioType || "aris_generated_audio",
            sourceText: speechChunks[index],
            chunkIndex: index + 1,
            chunkCount: speechChunks.length,
            sessionId,
          }).catch((contextError) => error("[arisService] Generated audio mapping failed; delivery will continue", contextError));
          const queued = await whatsappOutboxStore.enqueue(
            selfJid,
            "audio",
            undefined,
            storageUri,
            voice.mimeType,
            userId,
            replyToWhatsappMessage
          );
          queuedIds.push(queued.id);
        }
        await this.memoryStore.storeMemoryEntry(
          userId,
          sessionId,
          `Generated Aris audio sent on ${new Date().toISOString()}. Source text: ${text.slice(0, 6000)}`
        ).catch((memoryError) => error("[arisService] Generated audio context memory failed", memoryError));
        return {
          success: true,
          tool: toolName,
          data: {
            summary: speechChunks.length > 1
              ? `Queued ${speechChunks.length} ordered voice-note parts for your connected WhatsApp self-chat.`
              : "Voice note queued for your connected WhatsApp self-chat.",
            outboxIds: queuedIds,
            sourceText: text,
            sourceType: "aris_generated_audio",
          },
        };
      } catch (err: any) {
        return { success: false, tool: toolName, error: err?.message || "Audio generation failed." };
      }
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
            data: await this.googleService.sendEmail(account, invocation.payload?.to, invocation.payload?.subject, invocation.payload?.body, undefined, persistTokens),
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

  private getAdvancedSearchPayload(payload: any): Record<string, any> {
    const fields = ["domains", "excludeDomains", "site", "exactPhrase", "location", "timeRange", "after", "before", "intitle", "inurl", "filetype"];
    return Object.fromEntries(fields.filter((field) => payload?.[field] !== undefined).map((field) => [field, payload[field]]));
  }

  private buildAdvancedSearchQuery(payload: any): string {
    let query = String(payload?.query || "").trim();
    const list = (value: any): string[] => (Array.isArray(value) ? value : String(value || "").split(","))
      .map((item) => String(item).trim().replace(/^https?:\/\//i, "").replace(/\/$/, ""))
      .filter(Boolean);
    const add = (operator: string, value: any) => {
      if (String(value || "").trim()) query += ` ${operator}${String(value).trim()}`;
    };
    for (const domain of [...list(payload?.domains), ...list(payload?.site)]) add("site:", domain);
    for (const domain of list(payload?.excludeDomains)) add("-site:", domain);
    if (payload?.exactPhrase) query += ` "${String(payload.exactPhrase).replace(/"/g, "")}"`;
    add("intitle:", payload?.intitle);
    add("inurl:", payload?.inurl);
    if (payload?.filetype) add("filetype:", String(payload.filetype).replace(/^\./, ""));
    if (payload?.location) query += ` "${String(payload.location).replace(/"/g, "")}"`;
    add("after:", payload?.after);
    add("before:", payload?.before);
    return query;
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
    const normalized = userMessage.trim().toLowerCase();
    if (this.isMorningBriefRequest(normalized)) {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      return [
        {
          tool: "google_calendar_events",
          payload: { maxResults: 20, timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString() },
        },
        { tool: "google_gmail_messages", payload: { maxResults: 10 } },
        { tool: "whatsapp_summary", payload: {} },
        { tool: "fetch_news", payload: {} },
      ];
    }

    const invocation = this.inferToolInvocation(userMessage, userId, sessionId, conversationHistory);
    if (invocation) {
      return [invocation];
    }

    
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

  private isMorningBriefRequest(normalizedMessage: string): boolean {
    return /\b(morning brief|morning briefing|daily brief|daily briefing|brief for (?:today|this morning)|today(?:'s| is)? brief)\b/i.test(normalizedMessage)
      && /\b(brief|briefing|update|overview|summary)\b/i.test(normalizedMessage);
  }

  private inferToolInvocation(userMessage: string, userId: number | undefined, sessionId: string | undefined, conversationHistory: string[]): { tool: string; payload: any } | undefined {
    const normalized = userMessage.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    const detailKeywords = /\b(detail|details|say|read|content|contents|link|links|attachment|attachments|body|in detail|open|show|tell me|what does|what about|what is in)\b/i;
    const emailKeywords = /\b(email|gmail|inbox|mail|message|messages|subject|sender|from|american center|thread|conversation)\b/i;
    const calendarKeywords = /\b(calendar|appointment|meeting|schedule|event|events|availability|today|tomorrow|next week|next month|this week|next month)\b/i;
    const newsKeywords = /\b(news|headlines|current events|world events|breaking news|today's news|today news|news brief|news podcast|podcast episode)\b/i;
    const trafficKeywords = /\b(traffic|trafic|commute|congestion|route|ETA|estimated arrival|travel time|delay|jam|accident|roadwork|road work|gridlock|rush hour|leave now|leave at|when should I leave|how long will it take)\b/i;
    const searchKeywords = /\b(search|look up|find|research|what is|who is|where is|latest|current|news|today's|today|tomorrow)\b/i;
    const retryKeywords = /\b(try again|retry|again|repeat|re-run|rerun|run again)\b/i;
    const anaphoraRef = /\b(this|that|it|same|previous|recent|last|first|second|third|fourth|fifth|the one|the other|those|these)\b/i;
    const joinMeetingIntent = /\b(join|enter|connect to|attend)\b.*\b(meet|meeting|call|conference)\b|\b(join now|join it|join the call)\b/i;

    const recentMessages = this.getRecentGmailMessages(userId, sessionId);
    const lastToolInvocation = this.getLastToolInvocation(userId, sessionId);

    if (retryKeywords.test(normalized) && lastToolInvocation) {
      return lastToolInvocation;
    }

    if (joinMeetingIntent.test(normalized) && lastToolInvocation?.tool === "google_calendar_events") {
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

    if (newsKeywords.test(normalized)) {
      return { tool: "fetch_news", payload: {} };
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
    const canonicalToolManifest = Array.from(this.supportedToolNames).sort().join(", ");

    const prompt = [
      `You are Aris, an extremely conversational digital friend, an expert advisor, and a life coach. You chain tools using a Thought-Action-Observation process.`,
      `When you provide your final answer, your tone should be warm, friendly, insightful, and highly conversational.`,
      `Continue the chain until the user's request is fully resolved or until you must stop for approval on a destructive action.`,
      `Do not output internal reasoning, Thought lines, planning, or progress narration.`,
      `For each step, output only one valid JSON tool call.`,
      `If you are finished, output only this final JSON object: {"final_answer":"...","memory_entries":[]} .`,
      `NEWS ROUTING: Use {"tool":"fetch_news"} for current news, today's news, headlines, or a news brief. Use {"tool":"search","query":"..."} only for general web research.`,
      `ARTICLE DETAIL ROUTING: When fetch_news returns several article links and the user asks for full details, make one batch call with all relevant links: {"tool":"browser_read","urls":["https://example.com/article-1","https://example.com/article-2"]}. A single tool call may contain a urls array; do not read only the first article and do not emit separate calls for every URL. If browser_read cannot read the links, try one batched url_read call instead.`,
      `NEWS PODCAST: Use {"tool":"fetch_news_podcast","batch":true} when the user asks for podcasts. This selects four current RSS episodes, always including NPR, stores them in Google Drive, and returns ordered Drive references. After the successful observation use app_send_audio_batch with those Drive episode references to queue them for Aris app delivery; never send only one episode. After delivery ask which shows the user enjoyed and save that preference for the custom podcast list.`,
      `MORNING BRIEF DELIVERY: A morning brief must include the complete text brief and a matching audio brief. Send the full text with app_send_message and the spoken version with audio_generate destination "app". If podcast episodes are present, also queue them with app_send_audio_batch. Do not finish with only a conversational summary when delivery was requested.`,
      `Only these exact tools are callable: ${canonicalToolManifest}`,
      `Never invent a tool name, translate a tool name, or use an alias.`,
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
    if (
      this.hasFuzzyMatch(allWords, ["join", "meet", "zoom", "meeting", "notetaker", "notes"]) &&
      (textToAnalyze.includes("meet.google.com") || textToAnalyze.includes("zoom.us") || textToAnalyze.includes("join") )
    ) categories.add("meeting");

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
    approvedAction?: ToolInvocation,
        mediaData?: { mimeType: string; dataBase64: string },
        replyToWhatsappMessage?: unknown
  ): Promise<ToolChainResult> {
    const toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }> = [];
    
    // Execute the approved action and seed toolResults, then fall through into
    // the main chain loop so the model can continue with remaining tasks.
    if (approvedAction) {
      onProgress?.(`Executing ${approvedAction.tool.replace(/_/g, ' ')}...`);
      const approvedInvocation = approvedAction.tool === "skill_run"
        ? { ...approvedAction, payload: { ...approvedAction.payload, _approved: true } }
        : approvedAction;
      const result = await this.executeToolCall(userId, approvedInvocation, sessionId, replyToWhatsappMessage);
      toolResults.push({ invocation: approvedAction, result });
      await this.recordToolObservation(userId, sessionId, approvedAction, result);
    }
    const activeCategories = this.determineToolCategories(userMessage, conversationHistory);
    if (includeSearch) activeCategories.add("search");

    let initialInvocations = approvedAction
      ? []
      : this.getInitialToolInvocations(userMessage, userId, sessionId, conversationHistory);
    initialInvocations = initialInvocations.map((invocation) =>
      this.applyRequestSpecificDefaults(invocation, userMessage, sessionId)
    );
    const executionPlan = this.buildExecutionPlan(userMessage, initialInvocations);
    if (!approvedAction && (initialInvocations.length > 0 || userMessage.trim().length > 30)) {
      await this.createExecutionPlanTasks(userId, userMessage, initialInvocations.length ? initialInvocations : [{ tool: "search", payload: { query: userMessage } }]);
      const { goalsStore } = await import("../db/goalsStore");
      pendingTasks = await goalsStore.getPendingTasks(userId!).catch(() => []);
    }
    const availableSkills = userId ? await this.skillService.list(userId).catch(() => []) : [];
    if (!approvedAction && this.isMorningBriefRequest(userMessage.toLowerCase())) {
      const morningSkill = availableSkills.find((skill) =>
        skill.status === "active" && skill.triggers.some((trigger) => /morning brief|daily brief/i.test(trigger))
      );
      if (morningSkill) {
        initialInvocations = [{
          tool: "skill_run",
          payload: {
            name: morningSkill.name,
            input: { message: userMessage },
            requiresApproval: (morningSkill.metadata?.sideEffectTools || []).length > 0,
          },
        }];
      }
    }
    if (!approvedAction && initialInvocations.length === 0) {
      const normalizedMessage = userMessage.toLowerCase();
      const triggeredSkill = availableSkills.find((skill) =>
        skill.triggers.some((trigger) => trigger.trim().length > 2 && normalizedMessage.includes(trigger.toLowerCase().trim()))
      );
      if (triggeredSkill) {
        initialInvocations = [{
          tool: "skill_run",
          payload: {
            name: triggeredSkill.name,
            input: { message: userMessage },
            requiresApproval: (triggeredSkill.metadata?.sideEffectTools || []).length > 0,
          },
        }];
      }
    }
    const skillContext = availableSkills.length
      ? [
          "AVAILABLE RUNTIME SKILLS:",
          ...availableSkills.map((skill) => `- ${skill.name} v${skill.version}: ${skill.description}; triggers=${JSON.stringify(skill.triggers)}`),
          "Use skill_run for a matching reusable workflow. Revise failed skills only after inspecting their execution trace.",
        ].join("\n")
      : "AVAILABLE RUNTIME SKILLS: none saved for this user.";
    
    const mediaParts = mediaData ? [{ inlineData: { mimeType: mediaData.mimeType, data: mediaData.dataBase64 } }] : undefined;
    const mediaContext = mediaData
      ? `A real ${mediaData.mimeType} attachment is included after this instruction. Inspect it directly and describe or analyze its contents when relevant. Do not claim that you only received text or that the attachment is unavailable.`
      : "No media attachment is present.";
    
    // Inject Live Location Awareness
    const locationData = await this.locationService.getCurrentLocation(false, userId);
    const locationContext = this.locationService.formatLocationContext(locationData);
    
    // If we have seeded tool results (from an approved action), build a focused
    // post-approval continuation prompt that strips old conversation history
    // to prevent the model from getting confused by stale failed tool attempts.
    let prompt: string;
    if (toolResults.length > 0) {
      const lastResult = toolResults[toolResults.length - 1];
      const toolName = lastResult.invocation.tool;
      const wasSuccess = lastResult.result.success;
      const alternativeTools = !wasSuccess ? this.getAlternativeTools(toolName) : [];
      const alternativeNote = !wasSuccess
        ? alternativeTools.length > 0
          ? `Registered alternatives for '${toolName}': ${alternativeTools.join(", ")}. Try one only if it can satisfy the same request.`
          : `No registered alternative exists for '${toolName}'. Do not substitute an unrelated tool; explain the limitation if the request cannot be completed.`
        : "";
      const approvalNote = wasSuccess
        ? `You just successfully executed '${toolName}'. The action completed.`
        : `Execution of '${toolName}' failed: ${lastResult.result.error}`;
      prompt = [
        `You are Aris, an extremely conversational digital friend, an expert advisor, and a life coach. ${approvalNote}`,
        locationContext,
        mediaContext,
        `Original user request: ${userMessage}`,
        alternativeNote,
        ``,
        `Tool results so far:`,
        ...toolResults.map(tr => `- ${tr.invocation.tool}: ${tr.result.success ? 'SUCCESS' : 'FAILED'}`),
        ``,
        `If there are remaining tasks from the original request that are not yet done, continue with the next step using a single JSON tool call.`,
        `If everything is done, output your final summary using ONLY this exact JSON format: {"final_answer":"<your message>","memory_entries":[]}. Do not output raw text.`,
        `Do NOT repeat or re-fetch data that was already retrieved. Do NOT repeat the same failed tool call with the same parameters. Do NOT invent tool names.`,
        ``,
        `Aris:`
      ].join('\n');
      prompt = `${skillContext}\n\nWorkflow plan:\n${executionPlan.map((step) => `- ${step}`).join("\n")}\n\n${prompt}`;
    } else {
      prompt = this.buildToolChainPrompt(userMessage, userProfile, memories, conversationHistory, activeCategories, locationContext, coachPersona, goalState, activeGoals, pendingTasks);
      prompt = `${skillContext}\n\nWorkflow plan:\n${executionPlan.map((step) => `- ${step}`).join("\n")}\n\n${this.buildFollowUpContext(userId, sessionId)}\n\n${prompt}`;
      if (mediaData) {
        prompt = `${mediaContext}\n\n${prompt}`;
      }
    }
    let lastModelReply = "";
    let recoveryAttempts = 0;

    // Execute obvious read-only first steps before asking the model to plan the
    // rest of the chain. This is also the fallback when the model starts with
    // a long internal monologue instead of an action.
    if (initialInvocations.length > 0) {
      const pendingInitialIndex = initialInvocations.findIndex((invocation) => this.needsHumanApproval(invocation, sessionId));
      if (pendingInitialIndex !== -1) {
        return {
          status: "awaiting_approval",
          reply: `I need your approval before I do that.\n\nTool: ${initialInvocations[pendingInitialIndex].tool}\nPayload: ${JSON.stringify(initialInvocations[pendingInitialIndex].payload)}\n\nReply APPROVE to continue or CANCEL to stop.`,
          memoryEntries: [],
          pendingAction: initialInvocations[pendingInitialIndex],
        };
      }

      const initialResults = await Promise.all(initialInvocations.map((invocation) => {
        onProgress?.(`Checking ${invocation.tool.replace(/_/g, " ")}...`);
        return this.executeToolCall(userId, invocation, sessionId, replyToWhatsappMessage);
      }));
      for (let index = 0; index < initialInvocations.length; index += 1) {
        toolResults.push({ invocation: initialInvocations[index], result: initialResults[index] });
      }
      await Promise.all(initialInvocations.map((invocation, index) =>
        this.recordToolObservation(userId, sessionId, invocation, initialResults[index])
      ));

      const isAndroidAppSession = sessionId?.startsWith("aris-android") || sessionId === "aris-android-chat";
      const isWhatsappDelivery = /\bwhatsapp\b/i.test(userMessage);
      if (this.isMorningBriefRequest(userMessage.toLowerCase()) && (isWhatsappDelivery || isAndroidAppSession)) {
        await this.maybeAutoCreateSkill(userId, userMessage, toolResults);
        const sourceLines = toolResults.map((entry) => {
          const source = JSON.stringify(entry.result.data ?? {});
          return `SOURCE ${entry.invocation.tool}: ${source}`;
        });
        const briefPrompt = [
          "Compose the complete morning brief from the supplied tool results.",
          "Return only valid JSON with exactly these string fields: message and audioText.",
          "message is the complete readable WhatsApp text brief.",
          "audioText is the same complete brief rewritten naturally for speech.",
          "Do not mention tools, prompts, reasoning, missing context, or uncertainty.",
          "Do not shorten, summarize away, or impose a word or duration limit.",
          `User request: ${userMessage}`,
          ...sourceLines,
        ].join("\n");
        let briefResponse = await this.gemmaService.requestArisAdvice(briefPrompt);
        let brief = this.extractJsonObject(briefResponse.reply) as { message?: string; audioText?: string } | undefined;
        if (!brief?.message?.trim() || !brief.audioText?.trim()) {
          const retryPrompt = [
            "Create a complete morning brief from these compact source notes.",
            "Return ONLY valid JSON: {\"message\":\"...\",\"audioText\":\"...\"}.",
            "Use the same facts in both fields. Keep it useful and concise.",
            ...sourceLines,
          ].join("\n");
          briefResponse = await this.gemmaService.requestArisAdvice(retryPrompt);
          brief = this.extractJsonObject(briefResponse.reply) as { message?: string; audioText?: string } | undefined;
        }
        if (!brief?.message?.trim() || !brief.audioText?.trim()) {
          return {
            status: "error",
            reply: "I gathered your morning brief but could not prepare the text and audio delivery.",
            memoryEntries: [],
          };
        }
        const podcastEpisodes = initialResults
          .flatMap((result, index) => initialInvocations[index]?.tool === "fetch_news_podcast" && result.success
            ? Array.isArray((result.data as any)?.episodes) ? (result.data as any).episodes : []
            : [])
          .filter((episode: any) => String(episode.storageUri || "").startsWith("drive:"));
        const pendingAction = {
          tool: "morning_brief_send",
          payload: { message: brief.message, audioText: brief.audioText, podcastEpisodes },
        };

        if (isWhatsappDelivery) {
          return {
            status: "awaiting_approval",
            reply: "I prepared the complete morning brief with both text and audio, plus the available podcast episodes. Reply APPROVE and I will deliver it to your Aris app.",
            memoryEntries: [],
            pendingAction,
          };
        }

        const delivery = await this.executeToolCall(userId, pendingAction, sessionId, replyToWhatsappMessage);
        toolResults.push({ invocation: pendingAction, result: delivery });
        if (!delivery.success) {
          return {
            status: "error",
            reply: `I prepared the morning brief, but delivery failed: ${delivery.error || "unknown error"}`,
            memoryEntries: [],
          };
        }
        await this.finalizeSuccessfulToolChain(userId, userMessage, toolResults);
        return {
          status: "finished",
          reply: "I've sent your complete morning brief to the Aris app, including the generated audio and available podcast episodes.",
          memoryEntries: [],
          mediaAttachments: this.extractMediaAttachments(toolResults),
        };
      }

      const podcastResult = initialResults.find((result, index) =>
        initialInvocations[index]?.tool === "fetch_news_podcast" && result.success
      );
      const isAndroidPodcastDelivery = isAndroidAppSession && !this.isMorningBriefRequest(userMessage.toLowerCase());
      if (podcastResult && (isAndroidPodcastDelivery || /\bwhatsapp\b/i.test(userMessage)) && !this.isMorningBriefRequest(userMessage.toLowerCase())) {
        const catalogEpisodes = Array.isArray((podcastResult.data as any)?.episodes)
          ? (podcastResult.data as any).episodes.filter((episode: any) => String(episode.storageUri || "").startsWith("drive:"))
          : [];
        if (catalogEpisodes.length > 0) {
          const delivery = {
            tool: "app_send_audio_batch",
            payload: { episodes: catalogEpisodes },
          };
          if (isAndroidPodcastDelivery) {
            const result = await this.executeToolCall(userId, delivery, sessionId, replyToWhatsappMessage);
            toolResults.push({ invocation: delivery, result });
            if (!result.success) {
              return {
                status: "error",
                reply: `I found the podcasts, but delivery failed: ${result.error || "unknown error"}`,
                memoryEntries: [],
              };
            }
            await this.finalizeSuccessfulToolChain(userId, userMessage, toolResults);
            return {
              status: "finished",
              reply: `I've queued ${catalogEpisodes.length} podcast episodes in the Aris app. They should appear in your chat shortly.`,
              memoryEntries: [],
            };
          }
          return {
            status: "awaiting_approval",
            reply: `I selected ${catalogEpisodes.length} current podcast episodes, including NPR. Reply APPROVE and I will send them in order. After listening, tell me which ones you enjoyed so I can build your custom podcast list.`,
            memoryEntries: [],
            pendingAction: delivery,
          };
        }
        const storageUri = String((podcastResult.data as any)?.storageUri || "");
        if (storageUri.startsWith("drive:")) {
          return {
            status: "awaiting_approval",
            reply: "I downloaded and listened to the latest news podcast. Reply APPROVE and I will send the original episode to your WhatsApp.",
            memoryEntries: [],
            pendingAction: {
              tool: "app_send_audio",
              payload: {
                driveRef: storageUri,
                mimeType: String((podcastResult.data as any)?.mimeType || "audio/mpeg").split(";")[0],
              },
            },
          };
        }
        const transcript = String((podcastResult.data as any)?.transcript || "").trim();
        if (transcript) {
          const summaryPrompt = [
            "Create a detailed, natural spoken news podcast brief for a WhatsApp voice note.",
            "Use only the supplied podcast transcript. Do not mention tools, internal reasoning, or inability to send WhatsApp.",
            "Return only the spoken script, around 90 to 150 seconds long.",
            `User request: ${userMessage}`,
            `Podcast title: ${(podcastResult.data as any)?.title || "News podcast"}`,
            `Transcript: ${transcript.slice(0, 24000)}`,
          ].join("\n");
          const scriptResponse = await this.gemmaService.requestArisAdvice(summaryPrompt);
          const script = scriptResponse.reply.trim();
          if (script.length >= 40) {
            return {
              status: "awaiting_approval",
              reply: "I downloaded and listened to the latest news podcast. I prepared a WhatsApp voice summary; reply APPROVE and I will send it.",
              memoryEntries: [],
              pendingAction: {
                tool: "audio_generate",
                payload: { destination: "whatsapp", text: script },
              },
            };
          }
        }
      }

      if (this.isWhatsappNewsAudioRequest(userMessage) && initialResults[0]?.success) {
        const newsData = initialResults[0].data?.items ?? initialResults[0].data;
        const summaryPrompt = [
          "Write a detailed, natural spoken news brief for a WhatsApp voice note.",
          "Use only the supplied headlines and source data. Do not mention tools, contacts, phone numbers, or inability to send WhatsApp.",
          "Return only the spoken script, about 90 to 150 seconds long.",
          `User request: ${userMessage}`,
          `Stories: ${JSON.stringify(newsData)}`,
        ].join("\n");
        const scriptResponse = await this.gemmaService.requestArisAdvice(summaryPrompt);
        const script = scriptResponse.reply.trim();
        if (script.length >= 40) {
          const pendingAction: ToolInvocation = {
            tool: "audio_generate",
            payload: { destination: "whatsapp", text: script },
          };
          return {
            status: "awaiting_approval",
            reply: "I prepared today's detailed news brief as a WhatsApp voice note. Reply APPROVE and I will send it.",
            memoryEntries: [],
            pendingAction,
          };
        }
      }

      prompt = this.buildToolChainPromptFromResults(
        userMessage,
        userProfile,
        memories,
        conversationHistory,
        toolResults,
        includeSearch
      );
    }

    const MAX_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {

      onProgress?.("Thinking...");
      const browserMediaParts = this.extractBrowserMediaParts(toolResults);
      const modelResponse = await this.gemmaService.requestArisAdvice(
        prompt,
        [...(mediaParts || []), ...browserMediaParts]
      );
      lastModelReply = modelResponse.reply.trim();

      const invocations = this.parseToolInvocations(lastModelReply);
      if (!invocations || invocations.length === 0) {
        // Detect "thinking wall" — model outputting raw reasoning instead of final_answer JSON
        // If reply is very long and has no final_answer structure, it's stuck in a loop.
        // We increase this to 4000 to allow sufficient reasoning over large datasets (like calendar lists).
        const hasFinalAnswer = this.isFinalModelResponse(modelResponse);
        const isThinkingWall = !hasFinalAnswer;

        if (isThinkingWall) {
          recoveryAttempts += 1;
          if (recoveryAttempts > 2) {
            return {
              status: "error",
              reply: "I could not produce a valid next action for that request.",
              memoryEntries: modelResponse.memoryEntries || [],
            };
          }

          // Prose is never treated as a completed action because it may contain
          // an unexecuted promise.
          const completedTools = toolResults
            .filter(r => r.result.success && r.invocation.tool !== '_system')
            .map(r => r.invocation.tool)
            .join(', ');
          
          prompt = [
            `You are Aris. Stop all internal reasoning now and follow the required action or final JSON response.`,
            completedTools ? `You have successfully executed: ${completedTools}.` : `No tools were needed.`,
            `User's original request: ${userMessage}`,
            `If the request still needs an action, output exactly one JSON tool call using one of these canonical names: ${Array.from(this.supportedToolNames).join(", ")}.`,
            `Otherwise output ONLY this final JSON format and nothing else:`,
            `{"final_answer":"<your concise reply to the user>","memory_entries":[]}`,
          ].join('\n');
          continue;
        }

        await this.finalizeSuccessfulToolChain(userId, userMessage, toolResults);
        return {
          status: "finished",
          reply: lastModelReply || "I completed the task.",
          memoryEntries: modelResponse.memoryEntries || [],
          mediaAttachments: this.extractMediaAttachments(toolResults),
        };
      }

      const normalizedInvocations = invocations.map((inv) =>
        this.applyRequestSpecificDefaults(this.normalizeToolInvocation(inv), userMessage, sessionId)
      );
      info(`[arisService] executing ${normalizedInvocations.length} normalized tool invocation(s): ${normalizedInvocations.map((invocation) => `${invocation.tool}:${JSON.stringify(invocation.payload).slice(0, 500)}`).join(" | ")}`);

      const pendingIndex = normalizedInvocations.findIndex((inv) => this.needsHumanApproval(inv, sessionId));
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
          return this.executeToolCall(userId, inv, sessionId, replyToWhatsappMessage);
        })
      );

      for (let i = 0; i < normalizedInvocations.length; i++) {
        toolResults.push({ invocation: normalizedInvocations[i], result: results[i] });
      }

      await Promise.all(normalizedInvocations.map((invocation, index) =>
        this.recordToolObservation(userId, sessionId, invocation, results[index])
      ));

      const joinRequested = /\b(join|enter|connect to|attend)\b|\bjoin now\b/i.test(userMessage);
      const calendarResult = toolResults.find(
        (entry) => entry.invocation.tool === "google_calendar_events" && entry.result.success
      );
      const meetingEvent = Array.isArray(calendarResult?.result.data)
        ? calendarResult.result.data
            .filter((event: any) => typeof event?.meetingUrl === "string")
            .sort((left: any, right: any) => {
              const leftStart = new Date(left.start?.dateTime || left.start?.date || 0).getTime();
              const rightStart = new Date(right.start?.dateTime || right.start?.date || 0).getTime();
              return Math.abs(leftStart - Date.now()) - Math.abs(rightStart - Date.now());
            })[0]
        : undefined;
      const joinAlreadyAttempted = toolResults.some(
        (entry) => entry.invocation.tool === "join_meeting"
      );

      if (joinRequested && meetingEvent && !joinAlreadyAttempted) {
        const joinInvocation: ToolInvocation = {
          tool: "join_meeting",
          payload: { url: meetingEvent.meetingUrl },
        };
        onProgress?.("Joining the Google Meet...");
        const joinResult = await this.executeToolCall(userId, joinInvocation, sessionId, replyToWhatsappMessage);
        toolResults.push({ invocation: joinInvocation, result: joinResult });
      }

      const currentFailures = results.map((r, i) => r.success ? null : { inv: normalizedInvocations[i], err: r.error }).filter(Boolean) as Array<{inv: any, err: any}>;
      if (currentFailures.length > 0) {
        error(`[arisService] tool failures=${currentFailures.length}: ${currentFailures.map((failure) => `${failure.inv.tool}: ${failure.err || "unknown error"}`).join(" | ")}`);
        await this.maybeReviseSkillFromFailure(userId, userMessage, toolResults);
      }
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
            const dataSummary = this.summarizeToolData(rawData);
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
        const dataSummary = this.summarizeToolData(rawData);
        return `--- Data from ${tr.invocation.tool} ---\n${dataSummary}`;
      });

      const failureLines = toolResults
        .filter(tr => !tr.result.success && tr.invocation.tool !== '_system')
        .map(tr => `--- ${tr.invocation.tool} FAILED: ${tr.result.error} ---`);
      const alternativeLines = toolResults
        .filter(tr => !tr.result.success && tr.invocation.tool !== '_system')
        .map(tr => {
          const alternatives = this.getAlternativeTools(tr.invocation.tool);
          return alternatives.length > 0
            ? `Alternative tools for ${tr.invocation.tool}: ${alternatives.join(", ")}. Try one only if it can satisfy the same request.`
            : `No registered alternative exists for ${tr.invocation.tool}. Do not substitute an unrelated tool; explain the limitation if the request cannot be completed.`;
        });
      const canonicalToolManifest = Array.from(this.supportedToolNames).sort().join(", ");

      if (hasFailure) {
        prompt = [
          `You are Aris. A tool call failed. Adapt and continue.`,
          `User's request: "${userMessage}"`,
          `Only these exact tools are callable: ${canonicalToolManifest}`,
          ...failureLines,
          ...alternativeLines,
          ...dataLines,
          `Check the listed alternatives before giving up. Do not repeat the same failed tool call with the same parameters.`,
          `If an alternative can satisfy the request, output one JSON tool call using that alternative.`,
          `If you have enough data to answer (or no other approach), write a final answer.`,
          `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
          `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
          `If calling a tool, use that tool's documented top-level fields, for example: {"tool":"browser_read","url":"https://example.com"}`,
          `If answering the user: {"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
        ].join('\n');
        continue;
      }

      const finalPlan = this.buildExecutionPlan(userMessage, normalizedInvocations);
      if (currentFailures.length > 0 && results.some((r) => r.success)) {
        await this.maybeReviseSkillAfterRecovery(userId, userMessage, toolResults);
      }
      prompt = [
        `You are Aris. You just completed a tool call and retrieved the following data.`,
        `User's original request: "${userMessage}"`,
        `Only these exact tools are callable: ${canonicalToolManifest}`,
        `Execution plan:`,
        ...finalPlan.map((step) => `- ${step}`),
        locationContext,
        ``,
        ...dataLines,
        ``,
        `If you need more information to fully answer the request, output a JSON object to call the next tool.`,
        `If you have gathered all necessary information, write a warm, detailed, conversational response to the user.`,
        `CRITICAL INSTRUCTION: Your entire response must be a single, valid JSON object and NOTHING ELSE.`,
        `Do NOT include any reasoning, bullet points, or markdown formatting before the JSON.`,
        `If calling a tool, use that tool's documented top-level fields, for example: {"tool":"browser_read","url":"https://example.com"}`,
        `If answering the user: {"final_answer": "your warm, detailed conversational response here", "memory_entries": []}`,
      ].join('\n');
    }

    // Max iterations reached — synthesize answer from whatever data was collected
    const collectedData = toolResults
      .filter(tr => tr.result.success && tr.invocation.tool !== '_system')
      .map(tr => {
        const rawData = tr.result.data;
        const dataSummary = this.summarizeToolData(rawData);
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
      const finalResponse = await this.gemmaService.requestArisAdvice(
        finalSynthesisPrompt,
        [...(mediaParts || []), ...this.extractBrowserMediaParts(toolResults)]
      );
      await this.finalizeSuccessfulToolChain(userId, userMessage, toolResults);
      return {
        status: "finished",
        reply: finalResponse.reply || "I reached the limit but gathered some data.",
        memoryEntries: finalResponse.memoryEntries || [],
        mediaAttachments: this.extractMediaAttachments(toolResults),
      };
    }

    await this.finalizeSuccessfulToolChain(userId, userMessage, toolResults);
    return {
      status: "max_iterations_reached",
      reply: "I hit my processing limit on that one. Could you try rephrasing or narrowing the request?",
      memoryEntries: [],
      mediaAttachments: this.extractMediaAttachments(toolResults),
    };
  }

  private extractMediaAttachments(toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>) {
    const attachments: Array<{ mimeType: string; base64: string }> = [];
    for (const tr of toolResults) {
      if (!tr.result.success) continue;
      const data = tr.result.data as any;
      // audio_generate or morning_brief_send (app path) returns audioBase64 at the top level or nested under data.audio
      const directAudio = data?.audioBase64 ?? data?.audio?.audioBase64;
      if (directAudio && (tr.invocation.tool === "audio_generate" || tr.invocation.tool === "morning_brief_send")) {
        attachments.push({
          mimeType: data?.mimeType ?? data?.audio?.mimeType ?? "audio/mpeg",
          base64: directAudio,
        });
      }
      
    }
    return attachments;
  }

  private async finalizeSuccessfulToolChain(
    userId: number | undefined,
    userMessage: string,
    toolResults: Array<{ invocation: ToolInvocation; result: ToolExecutionResult }>
  ): Promise<void> {
    await this.maybeAutoCreateSkill(userId, userMessage, toolResults);
    await this.maybeCompletePendingTasks(userId, userMessage, toolResults);
    await this.completeExecutionPlanTasks(userId, userMessage);
  }

  private needsHumanApproval(invocation: ToolInvocation, sessionId?: string) {
    const normalizedTool = this.normalizeToolName(invocation.tool);
    const destructiveToolPatterns = [
      /^google_calendar_(create|batch_create|update|delete|import|move|patch|clear_calendar|delete_calendar|update_acl|delete_acl)$/,
      /^google_gmail_(send|draft_send)$/,
      /^whatsapp_outbox_cleanup$/,
    ];

    if (destructiveToolPatterns.some((pattern) => pattern.test(normalizedTool))) {
      return true;
    }

    if (normalizedTool === "audio_generate") {
      const requestedDestination = String(invocation.payload?.destination || "").toLowerCase();
      const isAppSession = sessionId?.startsWith("aris-android");
      const destination = sessionId === "whatsapp-direct" && requestedDestination !== "email"
        ? "whatsapp"
        : requestedDestination || (isAppSession ? "app" : "download");
      // "app" and "download" destinations return inline audio — no approval needed
      // Email always needs approval; WhatsApp only when it's an actual WhatsApp session
      if (destination === "app" || destination === "download") return false;
      return ["email", "whatsapp"].includes(destination);
    }

    if (normalizedTool === "skill_run") {
      return invocation.payload?.requiresApproval === true;
    }

    if (normalizedTool === "app_send_audio") {
      return true;
    }

    if (normalizedTool === "app_send_audio_batch") {
      return true;
    }

    if (normalizedTool === "morning_brief_send") {
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
    const recentObservations = this.getRecentToolObservations(userId, sessionId);
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

    if (!prefix && recentObservations.length) {
      const latest = recentObservations[recentObservations.length - 1];
      prefix = `Regarding the previous ${latest.tool.replace(/_/g, " ")} result, `;
    }

    if (prefix) {
      return `${prefix}${normalized}`;
    }

    return normalized;
  }

  private async attemptUrlExtraction(searchResponse: SearchResponse): Promise<ExtractResponse | undefined> {
    const urls = (searchResponse.results || [])
      .slice(0, 5)
      .map((item) => item.url)
      .filter((url) => typeof url === "string" && url.length > 0);

    if (!urls.length) {
      return undefined;
    }

    const timeoutMs = Math.max(60000, urls.length * 25000 + 10000);

    try {
      const browserResults = await this.researchBrowserService.readUrls(urls);
      const readable = browserResults.filter((result) => result.content.length > 100);
      if (readable.length > 0) {
        return {
          elapsedMs: 0,
          results: readable.map((result) => ({
            url: result.finalUrl || result.url,
            title: result.title,
            snippet: "",
            content: result.content,
            warnings: result.warnings,
          })),
        };
      }

      return await this.extractClient.extract({ urls, limit: 15000, timeoutMs });
    } catch (error) {
      info(`[arisService] failed to extract page content from urls=${urls.length}`);
      return this.extractClient.extract({ urls, limit: 15000, timeoutMs }).catch(() => undefined);
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
    const canonicalToolManifest = Array.from(this.supportedToolNames).sort().join(", ");

    const toolInstructions = [
      `You are Aris, an extremely conversational digital friend, an expert advisor, an emotional helper, and an aggressive, tactical life coach.`,
      `RUNTIME TOOL MANIFEST: The only callable tools are exactly these names: ${canonicalToolManifest}`,
      `Never invent a tool name, translate a tool name, or ask another service to perform a tool's job. If a capability is not in this manifest, explain that limitation after completing all available steps.`,
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
      `Use 'url_read' after a 'search' to go deeper — don't just rely on snippets, read the actual pages. One tool invocation may contain multiple URLs: {"tool":"url_read","urls":["https://example.com/a","https://example.com/b"]}.`,
      `BROWSER RESEARCH: Use 'browser_read' when an article requires JavaScript, client-side rendering, interaction, or visual inspection. Use 'browser_action' for bounded click, type, keypress, JavaScript evaluation, or screenshot actions. Browser actions must remain focused on research and may not submit forms, log in, purchase, send messages, or perform external side effects without explicit approval.`,
      `Use 'browser_search' when you need to search the web through a browser session. Then use 'browser_read' on relevant result URLs and read the full article before making claims. Example: {"tool":"browser_search","query":"latest topic"}. When reading several articles, make ONE browser_read call with a urls array, for example: {"tool":"browser_read","urls":["https://example.com/a","https://example.com/b"]}. Do not emit five separate browser_read calls when one batch can read them.`,
      `ADVANCED SEARCH: Both 'search' and 'browser_search' accept structured constraints. Use them instead of burying requirements in prose: {"tool":"search","query":"battery storage","domains":["reuters.com","iea.org"],"excludeDomains":["reddit.com"],"exactPhrase":"grid scale","location":"Kenya","timeRange":"month","after":"2026-08-01","before":"2026-09-07","intitle":"policy","inurl":"report","filetype":"pdf"}. 'site' is an alias for one domain; 'domains' accepts several. Use 'after' and 'before' for exact date ranges, 'timeRange' for relative freshness (day, week, month, year), 'location' for geographic relevance, 'intitle' for title matching, 'inurl' for URL path matching, and 'filetype' for documents. Normalize domains without https://. For high-precision research, start with the narrowest site/date constraints, then broaden only if results are insufficient. Use browser_search when the target site requires JavaScript or visual inspection, and use browser_read on the strongest results before answering.`,
      `For visual pages use {"tool":"browser_action","type":"screenshot"} or browser_read with includeScreenshot=true. Inspect the returned screenshot directly with your multimodal vision capability; do not call an external OCR service or claim that OCR is unavailable.`,
      `When a browser action fails, inspect the returned error, screenshot or DOM state, correct the selector or script, and retry with a bounded alternative. Do not repeat an identical failed action indefinitely.`,
      `RUNTIME SKILLS: Use 'skill_list' to inspect saved skills, 'skill_run' to execute one, and 'skill_create' or 'skill_revise' to build or correct a reusable workflow. A skill definition must contain a stable name, description, triggers, and 1-20 ordered steps. Each step calls an existing registered tool and may use {{input.field}} or {{savedResult.field}} templates.`,
      `When a research workflow succeeds repeatedly, propose saving it as a skill. When a skill fails, inspect its trace and error, correct the definition with 'skill_revise', and record a bounded retry. Never put credentials or destructive actions into a skill, and never use a skill to bypass approval requirements. Skill definitions are persisted in PostgreSQL and backed up as private JSON files in Google Drive.`,
      `MEETING BOT TOOL:`,
      `Use 'join_meeting' if the user asks you to join a Google Meet or Zoom meeting to take notes. Example: {"tool":"join_meeting","url":"https://meet.google.com/xyz"}`,
      `APP SEND: Use 'app_send_message' to queue a text message to the authenticated user's Aris Android app. The tool enqueues it in the outbox for the connected app session — no phone number needed. Example: {"tool":"app_send_message","message":"Don't forget your 3pm meeting!"}`,
      `AUDIO TOOL: Use 'audio_generate' when the user asks Aris to speak, create an audio file, email audio, or send audio. Available destinations: "app" — returns the audio inline to the Android chat (no approval needed, use this when the session is the Android companion app); "download" — same as app, inline base64 return; "email" — email the file (requires approval); "whatsapp" — queues a voice note to the connected WhatsApp self-chat (requires approval). When responding in an Android app session (sessionId starts with "aris-android"), always default to destination "app". Example: {"tool":"audio_generate","text":"Here is your news brief...","destination":"app"}`,
      `AUDIO NEWS RULE: When the user asks for today's news in audio on WhatsApp, first use fetch_news if no same-day result is available, then summarize the returned items into real spoken text and call audio_generate with destination "whatsapp". For an Android app request, use destination "app" instead. For a news podcast request, use fetch_news_podcast first and summarize its transcript. Never call audio_generate with "...", a placeholder.`,
      `Never invent tools named text_to_speech, send_audio_on_whatsapp, send_whatsapp_message, or similar. Use the exact registered tools audio_generate and app_send_message only. Never ask for a phone number or recipient — the outbox resolves the delivery target automatically.`,
      `OUTBOX HISTORY: Use 'whatsapp_outbox_history' when the user asks to see, list, review, or retrieve all queued messages (text, audio, podcasts) for the Aris app. Returns every message regardless of pending, sent, or failed status. Example: {"tool":"whatsapp_outbox_history"}`,
      `OUTBOX CLEANUP: Use 'whatsapp_outbox_cleanup' when the user explicitly asks to clear, cancel, or remove pending queued messages from the Aris app outbox. It takes no recipient or message field and permanently prevents pending messages from being delivered. This action requires user approval.`,
      `SECURE VAULT TOOLS:`,
      `The vault is an AES-256-GCM encrypted store for any sensitive information. Use it proactively whenever the user shares or asks about sensitive data.`,
      `Use 'vault_store' to encrypt and save any sensitive value. Examples of when to use it:`,
      `  - User says "My WiFi password is Abc12345" → {"tool":"vault_store","key":"wifi_password","value":"Abc12345"}`,
      `  - User says "My phone PIN is 2580" → {"tool":"vault_store","key":"phone_pin","value":"2580"}`,
      `  - User says "My MTN MoMo PIN is 1234" → {"tool":"vault_store","key":"momo_pin","value":"1234"}`,
      `  - User says "Store my Netflix password: pass123" → {"tool":"vault_store","key":"netflix_password","value":"pass123"}`,
      `  - User says "My bank account number is 012345678" → {"tool":"vault_store","key":"bank_account","value":"012345678"}`,
      `Use 'vault_retrieve' to decrypt and fetch a previously stored secret. Examples:`,
      `  - User says "What's my WiFi password?" → {"tool":"vault_retrieve","key":"wifi_password"}`,
      `  - User says "What PIN did I store for my phone?" → {"tool":"vault_retrieve","key":"phone_pin"}`,
      `CRITICAL VAULT RULE: If you detect a password, PIN, account number, secret key, or any credential in the user's message, you MUST call vault_store immediately — even if the user didn't explicitly ask you to save it.`,
      `CRITICAL VAULT RULE: Never echo a raw password or PIN in your final_answer. If you retrieve a secret, present it naturally: "Your WiFi password is stored. Here it is: [value]". Do not repeat it in memory_entries.`,
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
      `A tool call is not complete until its observation appears. Never claim that an action was sent, generated, saved, or completed based only on an intended tool call.`,
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
      ...(process.env.NEWS_PODCAST_RSS_URL ? [`A preferred news podcast RSS feed is configured. Also call fetch_news_podcast in the same batch so Aris can listen to it, store its context, and include it in the briefing.`] : []),
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
      `Resolve minor spelling, spacing, transliteration, and punctuation differences against remembered names, contact names, subjects, event titles, and tool results. Prefer the closest unambiguous match; ask a clarification only when two or more matches are genuinely plausible.`,
      `When a follow-up omits its subject, carry forward the most recent relevant entity and tool result. Do not reset context merely because the latest message is short.`,
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

