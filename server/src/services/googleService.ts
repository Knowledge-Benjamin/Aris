import dotenv from "dotenv";
import path from "path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { GoogleAccountRecord } from "../db/googleAccountStore";
import { info, error } from "../utils/logger";

const envFilePath = path.resolve(__dirname, "../../.env");

dotenv.config({ path: envFilePath });

function getGoogleEnvConfig() {
  dotenv.config({ path: envFilePath });
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim(),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(),
    redirectUri: process.env.GOOGLE_REDIRECT_URI?.trim(),
  };
}

const DEFAULT_SCOPES = [
  "https://mail.google.com",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];

function getOauthClient(redirectUriOverride?: string): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = getGoogleEnvConfig();
  const effectiveRedirectUri = redirectUriOverride?.trim() || redirectUri;
  info(`getOauthClient: effectiveRedirectUri=${effectiveRedirectUri ?? "<none>"}`);
  info(`getOauthClient: clientId=${clientId ? `${clientId.slice(0, 8)}...` : "<missing>"}`);
  if (!clientId || !clientSecret || !effectiveRedirectUri) {
    throw new Error(
      "Missing Google OAuth configuration. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, effectiveRedirectUri);
}

function buildExplicitGoogleAuthUrl(clientId: string, redirectUri: string): string {
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", DEFAULT_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  return authUrl.toString();
}

export class GoogleService {
  createAuthUrl(redirectUriOverride?: string): string {
    const { clientId, redirectUri } = getGoogleEnvConfig();
    const effectiveRedirectUri = redirectUriOverride?.trim() || redirectUri;
    if (!clientId || !effectiveRedirectUri) {
      throw new Error(
        "Missing Google OAuth configuration. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI."
      );
    }

    const authUrl = buildExplicitGoogleAuthUrl(clientId, effectiveRedirectUri);
    console.log("[googleService] createAuthUrl generated:", authUrl);
    return authUrl;
  }

  async exchangeCode(code: string, redirectUriOverride?: string) {
    info(`exchangeCode: starting token exchange. redirectUriOverride=${redirectUriOverride ?? "<none>"}`);
    const oauth2Client = getOauthClient(redirectUriOverride);
    try {
      const tokenResponse = await oauth2Client.getToken(code);
      const tokens = tokenResponse.tokens;
      oauth2Client.setCredentials(tokens);
      info(`exchangeCode: token exchange succeeded. scope=${tokens.scope ?? "<none>"}`);

      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const profile = userInfo.data;

      return {
        tokens,
        googleUserId: profile.id || "",
        googleEmail: profile.email || "",
        scopes: tokens.scope || DEFAULT_SCOPES.join(" "),
      };
    } catch (err: any) {
      error("exchangeCode failed", {
        message: err?.message,
        stack: err?.stack,
        codeSnippet: code ? `present length=${code.length}` : "<missing>",
      });
      throw err;
    }
  }

  buildAuthenticatedClient(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ): OAuth2Client {
    const oauth2Client = getOauthClient();
    oauth2Client.setCredentials({
      access_token: account.accessToken,
      refresh_token: account.refreshToken || undefined,
      expiry_date: account.tokenExpiry ? new Date(account.tokenExpiry).getTime() : undefined,
    });

    if (tokenUpdateHandler) {
      oauth2Client.on("tokens", async (tokens) => {
        try {
          await tokenUpdateHandler(tokens);
        } catch {
          // ignore token persistence failures
        }
      });
    }

    return oauth2Client;
  }

  async getGmailMessages(
    account: GoogleAccountRecord,
    maxResults = 5,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      labelIds: ["INBOX"],
    });

    const messages = listResponse.data.messages || [];
    if (!messages.length) {
      return [];
    }

    const details = await Promise.all(
      messages.map(async (message) => {
        if (!message.id) {
          return null;
        }
        const messageResponse = await gmail.users.messages.get({
          userId: "me",
          id: message.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });
        const msg = messageResponse.data;
        const headers = msg.payload?.headers || [];
        const subject = headers.find((h) => h.name === "Subject")?.value || "";
        const from = headers.find((h) => h.name === "From")?.value || "";
        const date = headers.find((h) => h.name === "Date")?.value || "";

        return {
          id: message.id,
          threadId: msg.threadId,
          subject,
          from,
          date,
          snippet: msg.snippet || "",
          labelIds: msg.labelIds || [],
        };
      })
    );

    return details.filter(Boolean);
  }

  async getCalendarEvents(
    account: GoogleAccountRecord,
    maxResults = 10,
    timeMin?: string,
    timeMax?: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const now = new Date().toISOString();

    const listArgs: Record<string, unknown> = {
      calendarId: "primary",
      timeMin: timeMin || now,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    };

    if (timeMax) {
      listArgs.timeMax = timeMax;
    }

    const response = await calendar.events.list(listArgs as any);

    return (response.data.items || []).map((event) => ({
      id: event.id,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      attendees: event.attendees,
      status: event.status,
    }));
  }

  async getCalendarEvent(
    account: GoogleAccountRecord,
    eventId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.get({ calendarId: "primary", eventId });
    const event = response.data;
    return {
      id: event.id,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      attendees: event.attendees,
      status: event.status,
    };
  }

  async createCalendarEvent(
    account: GoogleAccountRecord,
    eventPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: eventPayload,
    });
    return response.data;
  }

  async updateCalendarEvent(
    account: GoogleAccountRecord,
    eventId: string,
    eventPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.update({
      calendarId: "primary",
      eventId,
      requestBody: eventPayload,
    });
    return response.data;
  }

  async deleteCalendarEvent(
    account: GoogleAccountRecord,
    eventId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.events.delete({ calendarId: "primary", eventId });
    return { success: true };
  }

  async importCalendarEvent(
    account: GoogleAccountRecord,
    eventPayload: Record<string, unknown>,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.import({ calendarId, requestBody: eventPayload });
    return response.data;
  }

  async getCalendarEventInstances(
    account: GoogleAccountRecord,
    eventId: string,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.instances({ calendarId, eventId });
    return response.data.items || [];
  }

  async moveCalendarEvent(
    account: GoogleAccountRecord,
    eventId: string,
    destinationCalendarId: string,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.move({ calendarId, eventId, destination: destinationCalendarId });
    return response.data;
  }

  async patchCalendarEvent(
    account: GoogleAccountRecord,
    eventId: string,
    eventPayload: Record<string, unknown>,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.patch({ calendarId, eventId, requestBody: eventPayload });
    return response.data;
  }

  async quickAddCalendarEvent(
    account: GoogleAccountRecord,
    text: string,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.quickAdd({ calendarId, text });
    return response.data;
  }

  async watchCalendarEvents(
    account: GoogleAccountRecord,
    channelPayload: Record<string, unknown>,
    calendarId = "primary",
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.events.watch({ calendarId, requestBody: channelPayload });
    return response.data;
  }

  async listCalendarListEntries(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.list({});
    return response.data.items || [];
  }

  async getCalendarListEntry(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.get({ calendarId });
    return response.data;
  }

  async insertCalendarListEntry(
    account: GoogleAccountRecord,
    requestBody: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.insert({ requestBody });
    return response.data;
  }

  async updateCalendarListEntry(
    account: GoogleAccountRecord,
    calendarId: string,
    requestBody: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.update({ calendarId, requestBody });
    return response.data;
  }

  async patchCalendarListEntry(
    account: GoogleAccountRecord,
    calendarId: string,
    requestBody: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.patch({ calendarId, requestBody });
    return response.data;
  }

  async deleteCalendarListEntry(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.calendarList.delete({ calendarId });
    return { success: true };
  }

  async watchCalendarList(
    account: GoogleAccountRecord,
    channelPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendarList.watch({ requestBody: channelPayload });
    return response.data;
  }

  async getCalendar(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendars.get({ calendarId });
    return response.data;
  }

  async createCalendar(
    account: GoogleAccountRecord,
    calendarPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendars.insert({ requestBody: calendarPayload });
    return response.data;
  }

  async updateCalendar(
    account: GoogleAccountRecord,
    calendarId: string,
    calendarPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendars.update({ calendarId, requestBody: calendarPayload });
    return response.data;
  }

  async patchCalendar(
    account: GoogleAccountRecord,
    calendarId: string,
    calendarPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.calendars.patch({ calendarId, requestBody: calendarPayload });
    return response.data;
  }

  async deleteCalendar(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.calendars.delete({ calendarId });
    return { success: true };
  }

  async clearCalendar(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.calendars.clear({ calendarId });
    return { success: true };
  }

  async listAclRules(
    account: GoogleAccountRecord,
    calendarId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.list({ calendarId });
    return response.data.items || [];
  }

  async getAclRule(
    account: GoogleAccountRecord,
    calendarId: string,
    ruleId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.get({ calendarId, ruleId });
    return response.data;
  }

  async insertAclRule(
    account: GoogleAccountRecord,
    calendarId: string,
    rulePayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.insert({ calendarId, requestBody: rulePayload });
    return response.data;
  }

  async updateAclRule(
    account: GoogleAccountRecord,
    calendarId: string,
    ruleId: string,
    rulePayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.update({ calendarId, ruleId, requestBody: rulePayload });
    return response.data;
  }

  async patchAclRule(
    account: GoogleAccountRecord,
    calendarId: string,
    ruleId: string,
    rulePayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.patch({ calendarId, ruleId, requestBody: rulePayload });
    return response.data;
  }

  async deleteAclRule(
    account: GoogleAccountRecord,
    calendarId: string,
    ruleId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.acl.delete({ calendarId, ruleId });
    return { success: true };
  }

  async watchAcl(
    account: GoogleAccountRecord,
    calendarId: string,
    channelPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.acl.watch({ calendarId, requestBody: channelPayload });
    return response.data;
  }

  async getColors(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.colors.get();
    return response.data;
  }

  async queryFreeBusy(
    account: GoogleAccountRecord,
    requestBody: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.freebusy.query({ requestBody });
    return response.data;
  }

  async listSettings(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.settings.list();
    return response.data.items || [];
  }

  async getSetting(
    account: GoogleAccountRecord,
    setting: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.settings.get({ setting });
    return response.data;
  }

  async watchSettings(
    account: GoogleAccountRecord,
    channelPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    const response = await calendar.settings.watch({ requestBody: channelPayload });
    return response.data;
  }

  async stopChannel(
    account: GoogleAccountRecord,
    channelPayload: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const calendar = google.calendar({ version: "v3", auth: authClient });
    await calendar.channels.stop({ requestBody: channelPayload });
    return { success: true };
  }

  async getGmailMessageById(
    account: GoogleAccountRecord,
    messageId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const message = response.data;
    const headers = message.payload?.headers || [];
    const subject = headers.find((header) => header.name?.toLowerCase() === "subject")?.value || "";
    const from = headers.find((header) => header.name?.toLowerCase() === "from")?.value || "";
    const to = headers.find((header) => header.name?.toLowerCase() === "to")?.value || "";
    const date = headers.find((header) => header.name?.toLowerCase() === "date")?.value || "";
    const bodyText = this.getMessageBody(message.payload);
    const links = this.extractLinksFromText(bodyText);
    const attachments = this.extractAttachments(message.payload);

    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds || [],
      snippet: message.snippet,
      historyId: message.historyId,
      internalDate: message.internalDate,
      payload: message.payload,
      headers: headers.map((header) => ({ name: header.name, value: header.value })),
      subject,
      from,
      to,
      date,
      body: bodyText,
      links,
      attachments,
    };
  }

  async getMessageAttachment(
    account: GoogleAccountRecord,
    messageId: string,
    attachmentId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });

    return {
      attachmentId: response.data.attachmentId,
      size: response.data.size,
      data: response.data.data,
    };
  }

  async listGmailThreads(
    account: GoogleAccountRecord,
    maxResults = 10,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const listResponse = await gmail.users.threads.list({
      userId: "me",
      maxResults,
    });

    const threads = listResponse.data.threads || [];
    return Promise.all(
      threads.map(async (thread) => {
        if (!thread.id) {
          return null;
        }
        const threadResponse = await gmail.users.threads.get({
          userId: "me",
          id: thread.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });
        return threadResponse.data;
      })
    ).then((items) => items.filter(Boolean));
  }

  async getGmailThread(
    account: GoogleAccountRecord,
    threadId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    return response.data;
  }

  async listDrafts(
    account: GoogleAccountRecord,
    maxResults = 10,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.drafts.list({
      userId: "me",
      maxResults,
    });
    return response.data.drafts || [];
  }

  async getDraft(
    account: GoogleAccountRecord,
    draftId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.drafts.get({
      userId: "me",
      id: draftId,
      format: "full",
    });
    return response.data;
  }

  async deleteDraft(
    account: GoogleAccountRecord,
    draftId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    await gmail.users.drafts.delete({
      userId: "me",
      id: draftId,
    });
    return { success: true };
  }

  async deleteMessage(
    account: GoogleAccountRecord,
    messageId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    await gmail.users.messages.delete({ userId: "me", id: messageId });
    return { success: true };
  }

  async batchDeleteMessages(
    account: GoogleAccountRecord,
    ids: string[],
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids } });
    return { success: true };
  }

  async batchModifyMessages(
    account: GoogleAccountRecord,
    ids: string[],
    addLabelIds: string[] = [],
    removeLabelIds: string[] = [],
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        addLabelIds,
        removeLabelIds,
      },
    });
    return response.data;
  }

  async importMessage(
    account: GoogleAccountRecord,
    rawMessage: string,
    threadId?: string,
    internalDateSource?: string,
    neverMarkSpam?: boolean,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const requestBody: any = { raw: rawMessage };
    if (threadId) requestBody.threadId = threadId;
    if (internalDateSource) requestBody.internalDateSource = internalDateSource;
    if (typeof neverMarkSpam === "boolean") requestBody.neverMarkSpam = neverMarkSpam;
    const response = await gmail.users.messages.import({ userId: "me", requestBody });
    return response.data;
  }

  async insertMessage(
    account: GoogleAccountRecord,
    rawMessage: string,
    threadId?: string,
    internalDateSource?: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const requestBody: any = { raw: rawMessage };
    if (threadId) requestBody.threadId = threadId;
    if (internalDateSource) requestBody.internalDateSource = internalDateSource;
    const response = await gmail.users.messages.insert({ userId: "me", requestBody });
    return response.data;
  }

  async modifyMessage(
    account: GoogleAccountRecord,
    messageId: string,
    addLabelIds: string[] = [],
    removeLabelIds: string[] = [],
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });
    return response.data;
  }

  async trashMessage(
    account: GoogleAccountRecord,
    messageId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.trash({ userId: "me", id: messageId });
    return response.data;
  }

  async untrashMessage(
    account: GoogleAccountRecord,
    messageId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.untrash({ userId: "me", id: messageId });
    return response.data;
  }

  async deleteThread(
    account: GoogleAccountRecord,
    threadId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    await gmail.users.threads.delete({ userId: "me", id: threadId });
    return { success: true };
  }

  async modifyThread(
    account: GoogleAccountRecord,
    threadId: string,
    addLabelIds: string[] = [],
    removeLabelIds: string[] = [],
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.threads.modify({
      userId: "me",
      id: threadId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });
    return response.data;
  }

  async trashThread(
    account: GoogleAccountRecord,
    threadId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.threads.trash({ userId: "me", id: threadId });
    return response.data;
  }

  async untrashThread(
    account: GoogleAccountRecord,
    threadId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.threads.untrash({ userId: "me", id: threadId });
    return response.data;
  }

  async getLabel(
    account: GoogleAccountRecord,
    labelId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.labels.get({ userId: "me", id: labelId });
    return response.data;
  }

  async listLabels(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.labels.list({ userId: "me" });
    return response.data.labels || [];
  }

  async createLabel(
    account: GoogleAccountRecord,
    label: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.labels.create({ userId: "me", requestBody: label });
    return response.data;
  }

  async updateLabel(
    account: GoogleAccountRecord,
    labelId: string,
    label: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.labels.update({ userId: "me", id: labelId, requestBody: label });
    return response.data;
  }

  async patchLabel(
    account: GoogleAccountRecord,
    labelId: string,
    label: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.labels.patch({ userId: "me", id: labelId, requestBody: label });
    return response.data;
  }

  async deleteLabel(
    account: GoogleAccountRecord,
    labelId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    await gmail.users.labels.delete({ userId: "me", id: labelId });
    return { success: true };
  }

  async getUserProfile(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.getProfile({ userId: "me" });
    return response.data;
  }

  async watch(
    account: GoogleAccountRecord,
    topicName: string,
    labelIds?: string[],
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const requestBody: any = { topicName };
    if (labelIds && labelIds.length) {
      requestBody.labelIds = labelIds;
    }
    const response = await gmail.users.watch({ userId: "me", requestBody });
    return response.data;
  }

  async stop(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.stop({ userId: "me" });
    return response.data;
  }

  async getAutoForwarding(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.getAutoForwarding({ userId: "me" });
    return response.data;
  }

  async updateAutoForwarding(
    account: GoogleAccountRecord,
    autoForwarding: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.updateAutoForwarding({ userId: "me", requestBody: autoForwarding });
    return response.data;
  }

  async getImap(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.getImap({ userId: "me" });
    return response.data;
  }

  async updateImap(
    account: GoogleAccountRecord,
    imapSettings: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.updateImap({ userId: "me", requestBody: imapSettings });
    return response.data;
  }

  async getLanguage(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.getLanguage({ userId: "me" });
    return response.data;
  }

  async updateLanguage(
    account: GoogleAccountRecord,
    languageSettings: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.updateLanguage({ userId: "me", requestBody: languageSettings });
    return response.data;
  }

  async getPop(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.getPop({ userId: "me" });
    return response.data;
  }

  async updatePop(
    account: GoogleAccountRecord,
    popSettings: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.updatePop({ userId: "me", requestBody: popSettings });
    return response.data;
  }

  async getVacation(
    account: GoogleAccountRecord,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.getVacation({ userId: "me" });
    return response.data;
  }

  async updateVacation(
    account: GoogleAccountRecord,
    vacationSettings: Record<string, unknown>,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.settings.updateVacation({ userId: "me", requestBody: vacationSettings });
    return response.data;
  }

  async createDraft(
    account: GoogleAccountRecord,
    recipient: string,
    subject: string,
    bodyText: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    if (!account.googleEmail) {
      throw new Error("Google account email is required to create a draft.");
    }
    const rawMessage = this.buildRawEmail(account.googleEmail, recipient, subject, bodyText);
    const encoded = this.encodeMessage(rawMessage);
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw: encoded,
        },
      },
    });
    return response.data;
  }

  async updateDraft(
    account: GoogleAccountRecord,
    draftId: string,
    recipient: string,
    subject: string,
    bodyText: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    if (!account.googleEmail) {
      throw new Error("Google account email is required to update a draft.");
    }
    const rawMessage = this.buildRawEmail(account.googleEmail, recipient, subject, bodyText);
    const encoded = this.encodeMessage(rawMessage);
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: {
        message: {
          raw: encoded,
        },
      },
    });
    return response.data;
  }

  async sendDraft(
    account: GoogleAccountRecord,
    draftId: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.drafts.send({
      userId: "me",
      requestBody: {
        id: draftId,
      },
    });
    return response.data;
  }

  private buildRawEmail(from: string, to: string, subject: string, bodyText: string) {
    return [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      bodyText,
    ].join("\r\n");
  }

  private encodeMessage(raw: string) {
    return Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private getMessageBody(payload: any): string {
    if (!payload) {
      return "";
    }

    if (payload.body?.data) {
      return this.decodeBase64Url(payload.body.data);
    }

    if (payload.parts?.length) {
      for (const part of payload.parts) {
        const body = this.getMessageBody(part);
        if (body) {
          return body;
        }
      }
    }

    return "";
  }

  private extractLinksFromText(text: string): string[] {
    if (!text) {
      return [];
    }

    const matches = text.match(/https?:\/\/[\w\-._~:/?#[\]@!$&'()*+,;=%]+/g);
    if (!matches) {
      return [];
    }

    return Array.from(new Set(matches));
  }

  private extractAttachments(payload: any): Array<{ filename: string; mimeType?: string; size?: number; attachmentId?: string; inline?: boolean }> {
    const attachments: Array<{ filename: string; mimeType?: string; size?: number; attachmentId?: string; inline?: boolean }> = [];

    const scanPart = (part: any) => {
      if (!part || typeof part !== "object") {
        return;
      }

      if (part.filename && part.filename.trim()) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: typeof part.body?.size === "number" ? part.body.size : undefined,
          attachmentId: part.body?.attachmentId,
          inline: part.headers?.some((header: any) => header.name?.toLowerCase() === "content-disposition" && /inline/i.test(header.value)),
        });
      }

      if (Array.isArray(part.parts)) {
        part.parts.forEach(scanPart);
      }
    };

    scanPart(payload);
    return attachments;
  }

  private decodeBase64Url(value: string) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  }

  async sendEmail(
    account: GoogleAccountRecord,
    recipient: string,
    subject: string,
    bodyText: string,
    tokenUpdateHandler?: (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => Promise<void>
  ) {
    if (!account.googleEmail) {
      throw new Error("Google account email is required to send email.");
    }

    const rawMessage = [
      `From: ${account.googleEmail}`,
      `To: ${recipient}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      bodyText,
    ].join("\r\n");

    const encoded = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const authClient = this.buildAuthenticatedClient(account, tokenUpdateHandler);
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encoded,
      },
    });

    return response.data;
  }
}
