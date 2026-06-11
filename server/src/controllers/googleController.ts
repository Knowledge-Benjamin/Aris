import { Request, Response } from "express";
import { getDatabasePool } from "../db/db";
import { GoogleAccountStore } from "../db/googleAccountStore";
import { GoogleService } from "../services/googleService";
import { AuthenticatedRequest } from "../middleware/authMiddleware";
import { info, error } from "../utils/logger";

const pool = getDatabasePool();
const googleAccountStore = new GoogleAccountStore(pool);
const googleService = new GoogleService();

export function getGoogleAuthUrl(req: Request, res: Response) {
  try {
    const redirectUri = typeof req.query.redirectUri === "string" ? req.query.redirectUri : undefined;
    info(`getGoogleAuthUrl request received: method=${req.method} path=${req.originalUrl}`);
    info(`getGoogleAuthUrl query.redirectUri=${redirectUri ?? "<none>"}`);
    info(`getGoogleAuthUrl headers: ${JSON.stringify({
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      "x-forwarded-for": req.headers["x-forwarded-for"],
    })}`);

    const authUrl = googleService.createAuthUrl(redirectUri);
    info(`Generated Google auth URL for redirectUri=${redirectUri ?? "<env>"}`);
    info(`Auth URL returned: ${authUrl}`);

    return res.json({ authUrl });
  } catch (error: any) {
    error("getGoogleAuthUrl error", {
      message: error?.message,
      stack: error?.stack,
      query: req.query,
    });
    return res.status(500).json({ error: "Unable to create Google OAuth URL." });
  }
}

export async function handleGoogleCallback(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const { code, redirectUri } = req.body;

    info(`handleGoogleCallback request received: method=${req.method} path=${req.originalUrl}`);
    info(`handleGoogleCallback headers: ${JSON.stringify({
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      "x-forwarded-for": req.headers["x-forwarded-for"],
    })}`);
    info(`handleGoogleCallback body redirectUri=${typeof redirectUri === "string" ? redirectUri : "<none>"}`);
    info(`authenticated userId=${userId ?? "<none>"}`);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Google authorization code is required." });
    }
    const redirectUriOverride = typeof redirectUri === "string" ? redirectUri : undefined;

    const { tokens, googleUserId, googleEmail, scopes } = await googleService.exchangeCode(code, redirectUriOverride);
    info(`Google code exchanged successfully. googleUserId=${googleUserId} googleEmail=${googleEmail} scopes=${scopes}`);

    await googleAccountStore.saveGoogleAccount(
      userId,
      googleUserId,
      googleEmail,
      tokens.access_token ?? undefined,
      tokens.refresh_token ?? undefined,
      tokens.expiry_date ?? undefined,
      scopes
    );

    return res.json({ success: true, googleEmail, googleUserId, scopes });
  } catch (err: any) {
    error("handleGoogleCallback error", {
      message: err?.message,
      stack: err?.stack,
      body: req.body,
      query: req.query,
    });
    return res.status(500).json({ error: "Google OAuth callback failed." });
  }
}

export async function getGoogleStatus(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.json({ connected: false });
    }

    return res.json({
      connected: true,
      googleEmail: account.googleEmail,
      googleUserId: account.googleUserId,
      scopes: account.scopes ? account.scopes.split(" ") : [],
      tokenExpiry: account.tokenExpiry,
    });
  } catch (error: any) {
    console.error("getGoogleStatus error", error);
    return res.status(500).json({ error: "Unable to fetch Google connection status." });
  }
}

async function getAuthenticatedGoogleAccount(req: Request, res: Response) {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.authUserId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized." });
    return null;
  }
  const account = await googleAccountStore.getGoogleAccount(userId);
  if (!account) {
    res.status(404).json({ error: "Google account not connected." });
    return null;
  }
  return account;
}

function createTokenUpdateHandler(userId: number) {
  return async (tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
    scope?: string | null;
  }) => {
    await googleAccountStore.updateGoogleTokens(
      userId,
      tokens.access_token ?? undefined,
      tokens.refresh_token ?? undefined,
      tokens.expiry_date ?? undefined,
      tokens.scope ?? undefined
    );
  };
}

export async function disconnectGoogle(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    await googleAccountStore.deleteGoogleAccount(userId);
    return res.json({ success: true });
  } catch (error: any) {
    console.error("disconnectGoogle error", error);
    return res.status(500).json({ error: "Unable to disconnect Google account." });
  }
}

export async function getCalendarEvents(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "Google account not connected." });
    }

    const events = await googleService.getCalendarEvents(
      account,
      10,
      undefined,
      undefined,
      async (tokens) => {
        await googleAccountStore.updateGoogleTokens(
          userId,
          tokens.access_token ?? undefined,
          tokens.refresh_token ?? undefined,
          tokens.expiry_date ?? undefined,
          tokens.scope ?? undefined
        );
      }
    );
    return res.json({ events });
  } catch (error: any) {
    console.error("getCalendarEvents error", error);
    return res.status(500).json({ error: "Unable to fetch Google Calendar events." });
  }
}

export async function getCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required." });
    }

    const event = await googleService.getCalendarEvent(
      account,
      eventId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("getCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to fetch Google Calendar event." });
  }
}

export async function createCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const { summary, description, location, start, end, attendees } = req.body;
    if (!summary || !start || !end) {
      return res.status(400).json({ error: "Event summary, start, and end are required." });
    }

    const eventPayload: Record<string, unknown> = {
      summary,
      description,
      location,
      start,
      end,
      attendees,
    };

    const event = await googleService.createCalendarEvent(
      account,
      eventPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("createCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to create Google Calendar event." });
  }
}

export async function updateCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required." });
    }

    const { summary, description, location, start, end, attendees } = req.body;
    const eventPayload: Record<string, unknown> = {};
    if (summary !== undefined) eventPayload.summary = summary;
    if (description !== undefined) eventPayload.description = description;
    if (location !== undefined) eventPayload.location = location;
    if (start !== undefined) eventPayload.start = start;
    if (end !== undefined) eventPayload.end = end;
    if (attendees !== undefined) eventPayload.attendees = attendees;

    const event = await googleService.updateCalendarEvent(
      account,
      eventId,
      eventPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("updateCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to update Google Calendar event." });
  }
}

export async function deleteCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required." });
    }

    await googleService.deleteCalendarEvent(
      account,
      eventId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to delete Google Calendar event." });
  }
}

export async function importCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventPayload = typeof req.body === "object" && req.body ? req.body.event || req.body : undefined;
    const calendarId = typeof req.body.calendarId === "string" ? req.body.calendarId : "primary";
    if (!eventPayload || typeof eventPayload !== "object") {
      return res.status(400).json({ error: "Event payload is required." });
    }

    const event = await googleService.importCalendarEvent(
      account,
      eventPayload,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("importCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to import Google Calendar event." });
  }
}

export async function getCalendarEventInstances(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    const calendarId = typeof req.query.calendarId === "string" ? req.query.calendarId : "primary";
    if (!eventId) {
      return res.status(400).json({ error: "Event ID is required." });
    }

    const instances = await googleService.getCalendarEventInstances(
      account,
      eventId,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ instances });
  } catch (error: any) {
    console.error("getCalendarEventInstances error", error);
    return res.status(500).json({ error: "Unable to fetch Google Calendar event instances." });
  }
}

export async function moveCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    const destinationCalendarId = typeof req.body.destinationCalendarId === "string" ? req.body.destinationCalendarId : undefined;
    const calendarId = typeof req.body.calendarId === "string" ? req.body.calendarId : "primary";
    if (!eventId || !destinationCalendarId) {
      return res.status(400).json({ error: "Event ID and destinationCalendarId are required." });
    }

    const event = await googleService.moveCalendarEvent(
      account,
      eventId,
      destinationCalendarId,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("moveCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to move Google Calendar event." });
  }
}

export async function patchCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const eventId = req.params.eventId;
    const eventPayload = typeof req.body === "object" && req.body ? req.body.event || req.body : undefined;
    const calendarId = typeof req.body.calendarId === "string" ? req.body.calendarId : "primary";
    if (!eventId || !eventPayload || typeof eventPayload !== "object") {
      return res.status(400).json({ error: "Event ID and update payload are required." });
    }

    const event = await googleService.patchCalendarEvent(
      account,
      eventId,
      eventPayload,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("patchCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to patch Google Calendar event." });
  }
}

export async function quickAddCalendarEvent(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const text = typeof req.body.text === "string" ? req.body.text : undefined;
    const calendarId = typeof req.body.calendarId === "string" ? req.body.calendarId : "primary";
    if (!text) {
      return res.status(400).json({ error: "Quick add text is required." });
    }

    const event = await googleService.quickAddCalendarEvent(
      account,
      text,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ event });
  } catch (error: any) {
    console.error("quickAddCalendarEvent error", error);
    return res.status(500).json({ error: "Unable to add Google Calendar quick event." });
  }
}

export async function watchCalendarEvents(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const channelPayload = typeof req.body === "object" && req.body ? req.body.channel || req.body : undefined;
    const calendarId = typeof req.body.calendarId === "string" ? req.body.calendarId : "primary";
    if (!channelPayload || typeof channelPayload !== "object") {
      return res.status(400).json({ error: "Channel payload is required for watch." });
    }

    const result = await googleService.watchCalendarEvents(
      account,
      channelPayload,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("watchCalendarEvents error", error);
    return res.status(500).json({ error: "Unable to watch Google Calendar events." });
  }
}

export async function listCalendarListEntries(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const entries = await googleService.listCalendarListEntries(
      account,
      createTokenUpdateHandler(userId)
    );
    return res.json({ entries });
  } catch (error: any) {
    console.error("listCalendarListEntries error", error);
    return res.status(500).json({ error: "Unable to list calendar list entries." });
  }
}

export async function getCalendarListEntry(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    const entry = await googleService.getCalendarListEntry(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ entry });
  } catch (error: any) {
    console.error("getCalendarListEntry error", error);
    return res.status(500).json({ error: "Unable to fetch calendar list entry." });
  }
}

export async function insertCalendarListEntry(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar list entry payload is required." });
    }

    const entry = await googleService.insertCalendarListEntry(
      account,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ entry });
  } catch (error: any) {
    console.error("insertCalendarListEntry error", error);
    return res.status(500).json({ error: "Unable to insert calendar list entry." });
  }
}

export async function updateCalendarListEntry(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!calendarId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID and payload are required." });
    }

    const entry = await googleService.updateCalendarListEntry(
      account,
      calendarId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ entry });
  } catch (error: any) {
    console.error("updateCalendarListEntry error", error);
    return res.status(500).json({ error: "Unable to update calendar list entry." });
  }
}

export async function patchCalendarListEntry(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!calendarId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID and payload are required." });
    }

    const entry = await googleService.patchCalendarListEntry(
      account,
      calendarId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ entry });
  } catch (error: any) {
    console.error("patchCalendarListEntry error", error);
    return res.status(500).json({ error: "Unable to patch calendar list entry." });
  }
}

export async function deleteCalendarListEntry(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    await googleService.deleteCalendarListEntry(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteCalendarListEntry error", error);
    return res.status(500).json({ error: "Unable to delete calendar list entry." });
  }
}

export async function watchCalendarList(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const channelPayload = typeof req.body === "object" && req.body ? req.body.channel || req.body : undefined;
    if (!channelPayload || typeof channelPayload !== "object") {
      return res.status(400).json({ error: "Channel payload is required for watch." });
    }

    const result = await googleService.watchCalendarList(
      account,
      channelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("watchCalendarList error", error);
    return res.status(500).json({ error: "Unable to watch calendar list." });
  }
}

export async function getCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    const calendar = await googleService.getCalendar(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ calendar });
  } catch (error: any) {
    console.error("getCalendar error", error);
    return res.status(500).json({ error: "Unable to fetch calendar metadata." });
  }
}

export async function createCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar payload is required." });
    }

    const calendar = await googleService.createCalendar(
      account,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ calendar });
  } catch (error: any) {
    console.error("createCalendar error", error);
    return res.status(500).json({ error: "Unable to create calendar." });
  }
}

export async function updateCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!calendarId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID and payload are required." });
    }

    const calendar = await googleService.updateCalendar(
      account,
      calendarId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ calendar });
  } catch (error: any) {
    console.error("updateCalendar error", error);
    return res.status(500).json({ error: "Unable to update calendar." });
  }
}

export async function patchCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const payload = typeof req.body === "object" && req.body ? req.body : undefined;
    if (!calendarId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID and payload are required." });
    }

    const calendar = await googleService.patchCalendar(
      account,
      calendarId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ calendar });
  } catch (error: any) {
    console.error("patchCalendar error", error);
    return res.status(500).json({ error: "Unable to patch calendar." });
  }
}

export async function deleteCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    await googleService.deleteCalendar(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteCalendar error", error);
    return res.status(500).json({ error: "Unable to delete calendar." });
  }
}

export async function clearCalendar(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    await googleService.clearCalendar(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error("clearCalendar error", error);
    return res.status(500).json({ error: "Unable to clear calendar." });
  }
}

export async function listAclRules(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    if (!calendarId) {
      return res.status(400).json({ error: "Calendar ID is required." });
    }

    const rules = await googleService.listAclRules(
      account,
      calendarId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ rules });
  } catch (error: any) {
    console.error("listAclRules error", error);
    return res.status(500).json({ error: "Unable to list ACL rules." });
  }
}

export async function getAclRule(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const ruleId = req.params.ruleId;
    if (!calendarId || !ruleId) {
      return res.status(400).json({ error: "Calendar ID and rule ID are required." });
    }

    const rule = await googleService.getAclRule(
      account,
      calendarId,
      ruleId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ rule });
  } catch (error: any) {
    console.error("getAclRule error", error);
    return res.status(500).json({ error: "Unable to fetch ACL rule." });
  }
}

export async function insertAclRule(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const payload = typeof req.body === "object" && req.body ? req.body.rule || req.body : undefined;
    if (!calendarId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID and ACL rule payload are required." });
    }

    const rule = await googleService.insertAclRule(
      account,
      calendarId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ rule });
  } catch (error: any) {
    console.error("insertAclRule error", error);
    return res.status(500).json({ error: "Unable to insert ACL rule." });
  }
}

export async function updateAclRule(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const ruleId = req.params.ruleId;
    const payload = typeof req.body === "object" && req.body ? req.body.rule || req.body : undefined;
    if (!calendarId || !ruleId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID, rule ID, and payload are required." });
    }

    const rule = await googleService.updateAclRule(
      account,
      calendarId,
      ruleId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ rule });
  } catch (error: any) {
    console.error("updateAclRule error", error);
    return res.status(500).json({ error: "Unable to update ACL rule." });
  }
}

export async function patchAclRule(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const ruleId = req.params.ruleId;
    const payload = typeof req.body === "object" && req.body ? req.body.rule || req.body : undefined;
    if (!calendarId || !ruleId || !payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Calendar ID, rule ID, and payload are required." });
    }

    const rule = await googleService.patchAclRule(
      account,
      calendarId,
      ruleId,
      payload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ rule });
  } catch (error: any) {
    console.error("patchAclRule error", error);
    return res.status(500).json({ error: "Unable to patch ACL rule." });
  }
}

export async function deleteAclRule(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const ruleId = req.params.ruleId;
    if (!calendarId || !ruleId) {
      return res.status(400).json({ error: "Calendar ID and rule ID are required." });
    }

    await googleService.deleteAclRule(
      account,
      calendarId,
      ruleId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteAclRule error", error);
    return res.status(500).json({ error: "Unable to delete ACL rule." });
  }
}

export async function watchAcl(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const calendarId = req.params.calendarId;
    const channelPayload = typeof req.body === "object" && req.body ? req.body.channel || req.body : undefined;
    if (!calendarId || !channelPayload || typeof channelPayload !== "object") {
      return res.status(400).json({ error: "Calendar ID and channel payload are required." });
    }

    const result = await googleService.watchAcl(
      account,
      calendarId,
      channelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("watchAcl error", error);
    return res.status(500).json({ error: "Unable to watch ACL." });
  }
}

export async function getColors(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const colors = await googleService.getColors(
      account,
      createTokenUpdateHandler(userId)
    );
    return res.json({ colors });
  } catch (error: any) {
    console.error("getColors error", error);
    return res.status(500).json({ error: "Unable to fetch calendar colors." });
  }
}

export async function queryFreeBusy(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const requestBody = typeof req.body === "object" && req.body ? req.body.requestBody || req.body : undefined;
    if (!requestBody || typeof requestBody !== "object") {
      return res.status(400).json({ error: "Freebusy request body is required." });
    }

    const result = await googleService.queryFreeBusy(
      account,
      requestBody,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("queryFreeBusy error", error);
    return res.status(500).json({ error: "Unable to query free/busy information." });
  }
}

export async function listSettings(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settings = await googleService.listSettings(
      account,
      createTokenUpdateHandler(userId)
    );
    return res.json({ settings });
  } catch (error: any) {
    console.error("listSettings error", error);
    return res.status(500).json({ error: "Unable to list calendar settings." });
  }
}

export async function getSetting(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const setting = req.params.setting;
    if (!setting) {
      return res.status(400).json({ error: "Setting key is required." });
    }

    const value = await googleService.getSetting(
      account,
      setting,
      createTokenUpdateHandler(userId)
    );
    return res.json({ value });
  } catch (error: any) {
    console.error("getSetting error", error);
    return res.status(500).json({ error: "Unable to fetch calendar setting." });
  }
}

export async function watchSettings(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const channelPayload = typeof req.body === "object" && req.body ? req.body.channel || req.body : undefined;
    if (!channelPayload || typeof channelPayload !== "object") {
      return res.status(400).json({ error: "Channel payload is required for watch." });
    }

    const result = await googleService.watchSettings(
      account,
      channelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("watchSettings error", error);
    return res.status(500).json({ error: "Unable to watch calendar settings." });
  }
}

export async function stopChannel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const channelPayload = typeof req.body === "object" && req.body ? req.body.channel || req.body : undefined;
    if (!channelPayload || typeof channelPayload !== "object") {
      return res.status(400).json({ error: "Channel payload is required to stop watch." });
    }

    const result = await googleService.stopChannel(
      account,
      channelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ result });
  } catch (error: any) {
    console.error("stopChannel error", error);
    return res.status(500).json({ error: "Unable to stop calendar channel." });
  }
}

export async function getGmailMessageById(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    if (!messageId) {
      return res.status(400).json({ error: "Message ID is required." });
    }

    const message = await googleService.getGmailMessageById(
      account,
      messageId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ message });
  } catch (error: any) {
    console.error("getGmailMessageById error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail message." });
  }
}

export async function getGmailThreads(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const maxResults = Number(req.query.maxResults) || 10;
    const threads = await googleService.listGmailThreads(
      account,
      maxResults,
      createTokenUpdateHandler(userId)
    );
    return res.json({ threads });
  } catch (error: any) {
    console.error("getGmailThreads error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail threads." });
  }
}

export async function getGmailThread(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const threadId = req.params.threadId;
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required." });
    }

    const thread = await googleService.getGmailThread(
      account,
      threadId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ thread });
  } catch (error: any) {
    console.error("getGmailThread error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail thread." });
  }
}

export async function listGmailDrafts(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const maxResults = Number(req.query.maxResults) || 10;
    const drafts = await googleService.listDrafts(
      account,
      maxResults,
      createTokenUpdateHandler(userId)
    );
    return res.json({ drafts });
  } catch (error: any) {
    console.error("listGmailDrafts error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail drafts." });
  }
}

export async function createGmailDraft(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: "Recipient, subject, and body are required." });
    }

    const draft = await googleService.createDraft(
      account,
      to,
      subject,
      body,
      createTokenUpdateHandler(userId)
    );
    return res.json({ draft });
  } catch (error: any) {
    console.error("createGmailDraft error", error);
    return res.status(500).json({ error: "Unable to create Gmail draft." });
  }
}

export async function updateGmailDraft(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const draftId = req.params.draftId;
    const { to, subject, body } = req.body;
    if (!draftId || !to || !subject || !body) {
      return res.status(400).json({ error: "Draft ID, recipient, subject, and body are required." });
    }

    const draft = await googleService.updateDraft(
      account,
      draftId,
      to,
      subject,
      body,
      createTokenUpdateHandler(userId)
    );
    return res.json({ draft });
  } catch (error: any) {
    console.error("updateGmailDraft error", error);
    return res.status(500).json({ error: "Unable to update Gmail draft." });
  }
}

export async function sendGmailDraft(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const draftId = req.params.draftId;
    if (!draftId) {
      return res.status(400).json({ error: "Draft ID is required." });
    }

    const message = await googleService.sendDraft(
      account,
      draftId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ message });
  } catch (error: any) {
    console.error("sendGmailDraft error", error);
    return res.status(500).json({ error: "Unable to send Gmail draft." });
  }
}

export async function getGmailMessages(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "Google account not connected." });
    }

    const messages = await googleService.getGmailMessages(account, 10, async (tokens) => {
      await googleAccountStore.updateGoogleTokens(
        userId,
        tokens.access_token ?? undefined,
        tokens.refresh_token ?? undefined,
        tokens.expiry_date ?? undefined,
        tokens.scope ?? undefined
      );
    });
    return res.json({ messages });
  } catch (error: any) {
    console.error("getGmailMessages error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail messages." });
  }
}

export async function sendGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const { to, subject, body } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    if (!to || typeof to !== "string") {
      return res.status(400).json({ error: "Recipient email is required." });
    }
    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "Email subject is required." });
    }
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: "Email body is required." });
    }

    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "Google account not connected." });
    }

    const response = await googleService.sendEmail(
      account,
      to,
      subject,
      body,
      async (tokens) => {
        await googleAccountStore.updateGoogleTokens(
          userId,
          tokens.access_token ?? undefined,
          tokens.refresh_token ?? undefined,
          tokens.expiry_date ?? undefined,
          tokens.scope ?? undefined
        );
      }
    );
    return res.json({ success: true, messageId: response.id, threadId: response.threadId });
  } catch (error: any) {
    console.error("sendGmailMessage error", error);
    return res.status(500).json({ error: "Unable to send Gmail message." });
  }
}

export async function deleteGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    if (!messageId) {
      return res.status(400).json({ error: "Message ID is required." });
    }

    await googleService.deleteMessage(account, messageId, createTokenUpdateHandler(userId));
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteGmailMessage error", error);
    return res.status(500).json({ error: "Unable to delete Gmail message." });
  }
}

export async function batchDeleteGmailMessages(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) {
      return res.status(400).json({ error: "Message IDs are required." });
    }

    await googleService.batchDeleteMessages(account, ids, createTokenUpdateHandler(userId));
    return res.json({ success: true });
  } catch (error: any) {
    console.error("batchDeleteGmailMessages error", error);
    return res.status(500).json({ error: "Unable to batch delete Gmail messages." });
  }
}

export async function batchModifyGmailMessages(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const addLabelIds = Array.isArray(req.body.addLabelIds) ? req.body.addLabelIds : [];
    const removeLabelIds = Array.isArray(req.body.removeLabelIds) ? req.body.removeLabelIds : [];
    if (!ids.length) {
      return res.status(400).json({ error: "Message IDs are required." });
    }

    const result = await googleService.batchModifyMessages(
      account,
      ids,
      addLabelIds,
      removeLabelIds,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("batchModifyGmailMessages error", error);
    return res.status(500).json({ error: "Unable to batch modify Gmail messages." });
  }
}

export async function modifyGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    const addLabelIds = Array.isArray(req.body.addLabelIds) ? req.body.addLabelIds : [];
    const removeLabelIds = Array.isArray(req.body.removeLabelIds) ? req.body.removeLabelIds : [];
    if (!messageId) {
      return res.status(400).json({ error: "Message ID is required." });
    }

    const result = await googleService.modifyMessage(
      account,
      messageId,
      addLabelIds,
      removeLabelIds,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("modifyGmailMessage error", error);
    return res.status(500).json({ error: "Unable to modify Gmail message." });
  }
}

export async function trashGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    if (!messageId) {
      return res.status(400).json({ error: "Message ID is required." });
    }

    const result = await googleService.trashMessage(account, messageId, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("trashGmailMessage error", error);
    return res.status(500).json({ error: "Unable to trash Gmail message." });
  }
}

export async function untrashGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    if (!messageId) {
      return res.status(400).json({ error: "Message ID is required." });
    }

    const result = await googleService.untrashMessage(account, messageId, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("untrashGmailMessage error", error);
    return res.status(500).json({ error: "Unable to untrash Gmail message." });
  }
}

export async function importGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const raw = typeof req.body.raw === "string" ? req.body.raw : req.body.rawMessage;
    const threadId = typeof req.body.threadId === "string" ? req.body.threadId : undefined;
    const internalDateSource = typeof req.body.internalDateSource === "string" ? req.body.internalDateSource : undefined;
    const neverMarkSpam = typeof req.body.neverMarkSpam === "boolean" ? req.body.neverMarkSpam : undefined;

    if (!raw) {
      return res.status(400).json({ error: "Raw message content is required." });
    }

    const result = await googleService.importMessage(
      account,
      raw,
      threadId,
      internalDateSource,
      neverMarkSpam,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("importGmailMessage error", error);
    return res.status(500).json({ error: "Unable to import Gmail message." });
  }
}

export async function insertGmailMessage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const raw = typeof req.body.raw === "string" ? req.body.raw : req.body.rawMessage;
    const threadId = typeof req.body.threadId === "string" ? req.body.threadId : undefined;
    const internalDateSource = typeof req.body.internalDateSource === "string" ? req.body.internalDateSource : undefined;

    if (!raw) {
      return res.status(400).json({ error: "Raw message content is required." });
    }

    const result = await googleService.insertMessage(
      account,
      raw,
      threadId,
      internalDateSource,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("insertGmailMessage error", error);
    return res.status(500).json({ error: "Unable to insert Gmail message." });
  }
}

export async function getGmailAttachment(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const messageId = req.params.messageId;
    const attachmentId = req.params.attachmentId;
    if (!messageId || !attachmentId) {
      return res.status(400).json({ error: "Message ID and attachment ID are required." });
    }

    const attachment = await googleService.getMessageAttachment(
      account,
      messageId,
      attachmentId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ attachment });
  } catch (error: any) {
    console.error("getGmailAttachment error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail attachment." });
  }
}

export async function deleteGmailThread(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const threadId = req.params.threadId;
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required." });
    }

    await googleService.deleteThread(account, threadId, createTokenUpdateHandler(userId));
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteGmailThread error", error);
    return res.status(500).json({ error: "Unable to delete Gmail thread." });
  }
}

export async function modifyGmailThread(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const threadId = req.params.threadId;
    const addLabelIds = Array.isArray(req.body.addLabelIds) ? req.body.addLabelIds : [];
    const removeLabelIds = Array.isArray(req.body.removeLabelIds) ? req.body.removeLabelIds : [];
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required." });
    }

    const result = await googleService.modifyThread(
      account,
      threadId,
      addLabelIds,
      removeLabelIds,
      createTokenUpdateHandler(userId)
    );
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("modifyGmailThread error", error);
    return res.status(500).json({ error: "Unable to modify Gmail thread." });
  }
}

export async function trashGmailThread(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const threadId = req.params.threadId;
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required." });
    }

    const result = await googleService.trashThread(account, threadId, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("trashGmailThread error", error);
    return res.status(500).json({ error: "Unable to trash Gmail thread." });
  }
}

export async function untrashGmailThread(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const threadId = req.params.threadId;
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required." });
    }

    const result = await googleService.untrashThread(account, threadId, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("untrashGmailThread error", error);
    return res.status(500).json({ error: "Unable to untrash Gmail thread." });
  }
}

export async function getGmailLabels(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "Google account not connected." });
    }

    const labels = await googleService.listLabels(account, async (tokens) => {
      await googleAccountStore.updateGoogleTokens(
        userId,
        tokens.access_token ?? undefined,
        tokens.refresh_token ?? undefined,
        tokens.expiry_date ?? undefined,
        tokens.scope ?? undefined
      );
    });
    return res.json({ labels });
  } catch (error: any) {
    console.error("getGmailLabels error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail labels." });
  }
}

export async function getGmailLabel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const labelId = req.params.labelId;
    if (!labelId) {
      return res.status(400).json({ error: "Label ID is required." });
    }

    const label = await googleService.getLabel(
      account,
      labelId,
      createTokenUpdateHandler(userId)
    );
    return res.json({ label });
  } catch (error: any) {
    console.error("getGmailLabel error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail label." });
  }
}

export async function createGmailLabel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const labelPayload = req.body;
    if (!labelPayload || typeof labelPayload !== "object") {
      return res.status(400).json({ error: "Label payload is required." });
    }

    const label = await googleService.createLabel(
      account,
      labelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ label });
  } catch (error: any) {
    console.error("createGmailLabel error", error);
    return res.status(500).json({ error: "Unable to create Gmail label." });
  }
}

export async function updateGmailLabel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const labelId = req.params.labelId;
    const labelPayload = req.body;
    if (!labelId || !labelPayload || typeof labelPayload !== "object") {
      return res.status(400).json({ error: "Label ID and payload are required." });
    }

    const label = await googleService.updateLabel(
      account,
      labelId,
      labelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ label });
  } catch (error: any) {
    console.error("updateGmailLabel error", error);
    return res.status(500).json({ error: "Unable to update Gmail label." });
  }
}

export async function patchGmailLabel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const labelId = req.params.labelId;
    const labelPayload = req.body;
    if (!labelId || !labelPayload || typeof labelPayload !== "object") {
      return res.status(400).json({ error: "Label ID and payload are required." });
    }

    const label = await googleService.patchLabel(
      account,
      labelId,
      labelPayload,
      createTokenUpdateHandler(userId)
    );
    return res.json({ label });
  } catch (error: any) {
    console.error("patchGmailLabel error", error);
    return res.status(500).json({ error: "Unable to patch Gmail label." });
  }
}

export async function deleteGmailLabel(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const labelId = req.params.labelId;
    if (!labelId) {
      return res.status(400).json({ error: "Label ID is required." });
    }

    await googleService.deleteLabel(account, labelId, createTokenUpdateHandler(userId));
    return res.json({ success: true });
  } catch (error: any) {
    console.error("deleteGmailLabel error", error);
    return res.status(500).json({ error: "Unable to delete Gmail label." });
  }
}

export async function getGmailProfile(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    const account = await googleAccountStore.getGoogleAccount(userId);
    if (!account) {
      return res.status(404).json({ error: "Google account not connected." });
    }

    const profile = await googleService.getUserProfile(account, async (tokens) => {
      await googleAccountStore.updateGoogleTokens(
        userId,
        tokens.access_token ?? undefined,
        tokens.refresh_token ?? undefined,
        tokens.expiry_date ?? undefined,
        tokens.scope ?? undefined
      );
    });
    return res.json({ profile });
  } catch (error: any) {
    console.error("getGmailProfile error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail profile." });
  }
}

export async function watchGmail(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const topicName = typeof req.body.topicName === "string" ? req.body.topicName : undefined;
    const labelIds = Array.isArray(req.body.labelIds) ? req.body.labelIds : undefined;
    if (!topicName) {
      return res.status(400).json({ error: "Topic name is required." });
    }

    const result = await googleService.watch(account, topicName, labelIds, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("watchGmail error", error);
    return res.status(500).json({ error: "Unable to create Gmail watch." });
  }
}

export async function stopGmailWatch(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.stop(account, createTokenUpdateHandler(userId));
    return res.json({ success: true, result });
  } catch (error: any) {
    console.error("stopGmailWatch error", error);
    return res.status(500).json({ error: "Unable to stop Gmail watch." });
  }
}

export async function getGmailSettingsAutoForwarding(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.getAutoForwarding(account, createTokenUpdateHandler(userId));
    return res.json({ autoForwarding: result });
  } catch (error: any) {
    console.error("getGmailSettingsAutoForwarding error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail auto-forwarding settings." });
  }
}

export async function updateGmailSettingsAutoForwarding(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settingsPayload = req.body;
    if (!settingsPayload || typeof settingsPayload !== "object") {
      return res.status(400).json({ error: "Auto-forwarding settings payload is required." });
    }

    const result = await googleService.updateAutoForwarding(account, settingsPayload, createTokenUpdateHandler(userId));
    return res.json({ autoForwarding: result });
  } catch (error: any) {
    console.error("updateGmailSettingsAutoForwarding error", error);
    return res.status(500).json({ error: "Unable to update Gmail auto-forwarding settings." });
  }
}

export async function getGmailSettingsImap(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.getImap(account, createTokenUpdateHandler(userId));
    return res.json({ imap: result });
  } catch (error: any) {
    console.error("getGmailSettingsImap error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail IMAP settings." });
  }
}

export async function updateGmailSettingsImap(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settingsPayload = req.body;
    if (!settingsPayload || typeof settingsPayload !== "object") {
      return res.status(400).json({ error: "IMAP settings payload is required." });
    }

    const result = await googleService.updateImap(account, settingsPayload, createTokenUpdateHandler(userId));
    return res.json({ imap: result });
  } catch (error: any) {
    console.error("updateGmailSettingsImap error", error);
    return res.status(500).json({ error: "Unable to update Gmail IMAP settings." });
  }
}

export async function getGmailSettingsLanguage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.getLanguage(account, createTokenUpdateHandler(userId));
    return res.json({ language: result });
  } catch (error: any) {
    console.error("getGmailSettingsLanguage error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail language settings." });
  }
}

export async function updateGmailSettingsLanguage(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settingsPayload = req.body;
    if (!settingsPayload || typeof settingsPayload !== "object") {
      return res.status(400).json({ error: "Language settings payload is required." });
    }

    const result = await googleService.updateLanguage(account, settingsPayload, createTokenUpdateHandler(userId));
    return res.json({ language: result });
  } catch (error: any) {
    console.error("updateGmailSettingsLanguage error", error);
    return res.status(500).json({ error: "Unable to update Gmail language settings." });
  }
}

export async function getGmailSettingsPop(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.getPop(account, createTokenUpdateHandler(userId));
    return res.json({ pop: result });
  } catch (error: any) {
    console.error("getGmailSettingsPop error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail POP settings." });
  }
}

export async function updateGmailSettingsPop(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settingsPayload = req.body;
    if (!settingsPayload || typeof settingsPayload !== "object") {
      return res.status(400).json({ error: "POP settings payload is required." });
    }

    const result = await googleService.updatePop(account, settingsPayload, createTokenUpdateHandler(userId));
    return res.json({ pop: result });
  } catch (error: any) {
    console.error("updateGmailSettingsPop error", error);
    return res.status(500).json({ error: "Unable to update Gmail POP settings." });
  }
}

export async function getGmailSettingsVacation(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const result = await googleService.getVacation(account, createTokenUpdateHandler(userId));
    return res.json({ vacation: result });
  } catch (error: any) {
    console.error("getGmailSettingsVacation error", error);
    return res.status(500).json({ error: "Unable to fetch Gmail vacation settings." });
  }
}

export async function updateGmailSettingsVacation(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const account = await getAuthenticatedGoogleAccount(req, res);
    if (!account || !userId) {
      return;
    }

    const settingsPayload = req.body;
    if (!settingsPayload || typeof settingsPayload !== "object") {
      return res.status(400).json({ error: "Vacation settings payload is required." });
    }

    const result = await googleService.updateVacation(account, settingsPayload, createTokenUpdateHandler(userId));
    return res.json({ vacation: result });
  } catch (error: any) {
    console.error("updateGmailSettingsVacation error", error);
    return res.status(500).json({ error: "Unable to update Gmail vacation settings." });
  }
}
