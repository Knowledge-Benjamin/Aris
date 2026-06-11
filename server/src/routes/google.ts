import { Router } from "express";
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  getGoogleStatus,
  disconnectGoogle,
  getCalendarEvents,
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getGmailMessages,
  getGmailMessageById,
  getGmailThreads,
  getGmailThread,
  listGmailDrafts,
  createGmailDraft,
  updateGmailDraft,
  sendGmailDraft,
  sendGmailMessage,
  deleteGmailMessage,
  batchDeleteGmailMessages,
  batchModifyGmailMessages,
  modifyGmailMessage,
  trashGmailMessage,
  untrashGmailMessage,
  importGmailMessage,
  insertGmailMessage,
  deleteGmailThread,
  modifyGmailThread,
  trashGmailThread,
  untrashGmailThread,
  getGmailAttachment,
  getGmailLabels,
  getGmailLabel,
  createGmailLabel,
  updateGmailLabel,
  patchGmailLabel,
  deleteGmailLabel,
  getGmailProfile,
  watchGmail,
  stopGmailWatch,
  getGmailSettingsAutoForwarding,
  updateGmailSettingsAutoForwarding,
  getGmailSettingsImap,
  updateGmailSettingsImap,
  getGmailSettingsLanguage,
  updateGmailSettingsLanguage,
  getGmailSettingsPop,
  updateGmailSettingsPop,
  getGmailSettingsVacation,
  updateGmailSettingsVacation,
  importCalendarEvent,
  getCalendarEventInstances,
  moveCalendarEvent,
  patchCalendarEvent,
  quickAddCalendarEvent,
  watchCalendarEvents,
  listCalendarListEntries,
  getCalendarListEntry,
  insertCalendarListEntry,
  updateCalendarListEntry,
  patchCalendarListEntry,
  deleteCalendarListEntry,
  watchCalendarList,
  getCalendar,
  createCalendar,
  updateCalendar,
  patchCalendar,
  deleteCalendar,
  clearCalendar,
  listAclRules,
  getAclRule,
  insertAclRule,
  updateAclRule,
  patchAclRule,
  deleteAclRule,
  watchAcl,
  getColors,
  queryFreeBusy,
  listSettings,
  getSetting,
  watchSettings,
  stopChannel,
} from "../controllers/googleController";
import { authenticate } from "../middleware/authMiddleware";

const router = Router();

router.get("/url", authenticate, getGoogleAuthUrl);
router.post("/callback", authenticate, handleGoogleCallback);
router.get("/status", authenticate, getGoogleStatus);
router.post("/disconnect", authenticate, disconnectGoogle);

router.get("/calendar/events", authenticate, getCalendarEvents);
router.get("/calendar/events/:eventId", authenticate, getCalendarEvent);
router.post("/calendar/events", authenticate, createCalendarEvent);
router.put("/calendar/events/:eventId", authenticate, updateCalendarEvent);
router.patch("/calendar/events/:eventId", authenticate, patchCalendarEvent);
router.delete("/calendar/events/:eventId", authenticate, deleteCalendarEvent);
router.post("/calendar/events/import", authenticate, importCalendarEvent);
router.get("/calendar/events/:eventId/instances", authenticate, getCalendarEventInstances);
router.post("/calendar/events/:eventId/move", authenticate, moveCalendarEvent);
router.post("/calendar/events/quickAdd", authenticate, quickAddCalendarEvent);
router.post("/calendar/events/watch", authenticate, watchCalendarEvents);

router.get("/calendar/list", authenticate, listCalendarListEntries);
router.get("/calendar/list/:calendarId", authenticate, getCalendarListEntry);
router.post("/calendar/list", authenticate, insertCalendarListEntry);
router.put("/calendar/list/:calendarId", authenticate, updateCalendarListEntry);
router.patch("/calendar/list/:calendarId", authenticate, patchCalendarListEntry);
router.delete("/calendar/list/:calendarId", authenticate, deleteCalendarListEntry);
router.post("/calendar/list/watch", authenticate, watchCalendarList);

router.get("/calendar/calendars/:calendarId", authenticate, getCalendar);
router.post("/calendar/calendars", authenticate, createCalendar);
router.put("/calendar/calendars/:calendarId", authenticate, updateCalendar);
router.patch("/calendar/calendars/:calendarId", authenticate, patchCalendar);
router.delete("/calendar/calendars/:calendarId", authenticate, deleteCalendar);
router.post("/calendar/calendars/:calendarId/clear", authenticate, clearCalendar);

router.get("/calendar/acl/:calendarId", authenticate, listAclRules);
router.get("/calendar/acl/:calendarId/:ruleId", authenticate, getAclRule);
router.post("/calendar/acl/:calendarId", authenticate, insertAclRule);
router.put("/calendar/acl/:calendarId/:ruleId", authenticate, updateAclRule);
router.patch("/calendar/acl/:calendarId/:ruleId", authenticate, patchAclRule);
router.delete("/calendar/acl/:calendarId/:ruleId", authenticate, deleteAclRule);
router.post("/calendar/acl/:calendarId/watch", authenticate, watchAcl);

router.get("/calendar/colors", authenticate, getColors);
router.post("/calendar/freebusy", authenticate, queryFreeBusy);
router.get("/calendar/settings", authenticate, listSettings);
router.get("/calendar/settings/:setting", authenticate, getSetting);
router.post("/calendar/settings/watch", authenticate, watchSettings);
router.post("/calendar/channels/stop", authenticate, stopChannel);

router.get("/gmail/messages", authenticate, getGmailMessages);
router.get("/gmail/messages/:messageId", authenticate, getGmailMessageById);
router.delete("/gmail/messages/:messageId", authenticate, deleteGmailMessage);
router.post("/gmail/messages/batchDelete", authenticate, batchDeleteGmailMessages);
router.post("/gmail/messages/batchModify", authenticate, batchModifyGmailMessages);
router.post("/gmail/messages/:messageId/modify", authenticate, modifyGmailMessage);
router.post("/gmail/messages/:messageId/trash", authenticate, trashGmailMessage);
router.post("/gmail/messages/:messageId/untrash", authenticate, untrashGmailMessage);
router.post("/gmail/messages/import", authenticate, importGmailMessage);
router.post("/gmail/messages/insert", authenticate, insertGmailMessage);
router.get("/gmail/messages/:messageId/attachments/:attachmentId", authenticate, getGmailAttachment);
router.get("/gmail/threads", authenticate, getGmailThreads);
router.get("/gmail/threads/:threadId", authenticate, getGmailThread);
router.delete("/gmail/threads/:threadId", authenticate, deleteGmailThread);
router.post("/gmail/threads/:threadId/modify", authenticate, modifyGmailThread);
router.post("/gmail/threads/:threadId/trash", authenticate, trashGmailThread);
router.post("/gmail/threads/:threadId/untrash", authenticate, untrashGmailThread);
router.get("/gmail/drafts", authenticate, listGmailDrafts);
router.post("/gmail/drafts", authenticate, createGmailDraft);
router.put("/gmail/drafts/:draftId", authenticate, updateGmailDraft);
router.post("/gmail/drafts/:draftId/send", authenticate, sendGmailDraft);
router.post("/gmail/send", authenticate, sendGmailMessage);
router.get("/gmail/labels", authenticate, getGmailLabels);
router.get("/gmail/labels/:labelId", authenticate, getGmailLabel);
router.post("/gmail/labels", authenticate, createGmailLabel);
router.put("/gmail/labels/:labelId", authenticate, updateGmailLabel);
router.patch("/gmail/labels/:labelId", authenticate, patchGmailLabel);
router.delete("/gmail/labels/:labelId", authenticate, deleteGmailLabel);
router.get("/gmail/profile", authenticate, getGmailProfile);
router.post("/gmail/watch", authenticate, watchGmail);
router.post("/gmail/watch/stop", authenticate, stopGmailWatch);
router.get("/gmail/settings/autoForwarding", authenticate, getGmailSettingsAutoForwarding);
router.put("/gmail/settings/autoForwarding", authenticate, updateGmailSettingsAutoForwarding);
router.get("/gmail/settings/imap", authenticate, getGmailSettingsImap);
router.put("/gmail/settings/imap", authenticate, updateGmailSettingsImap);
router.get("/gmail/settings/language", authenticate, getGmailSettingsLanguage);
router.put("/gmail/settings/language", authenticate, updateGmailSettingsLanguage);
router.get("/gmail/settings/pop", authenticate, getGmailSettingsPop);
router.put("/gmail/settings/pop", authenticate, updateGmailSettingsPop);
router.get("/gmail/settings/vacation", authenticate, getGmailSettingsVacation);
router.put("/gmail/settings/vacation", authenticate, updateGmailSettingsVacation);

export default router;
