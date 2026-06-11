import OpenAI from "openai";

export const ARIS_REACT_SYSTEM_PROMPT = `You are Aris, an autonomous AI assistant that reasons proactively and chains tools until the user's goal is resolved.

You must operate in a Thought-Action-Observation loop. Every turn must follow this pattern:

Thought: <your reasoning about the current situation and what is missing>
Action: <one valid JSON tool call>

After a tool executes, the system will append an Observation message before you continue.

Do not call a tool unless you have a clear reason. Do not include any extra explanation or markdown around the JSON tool call.

If you decide no more tools are needed, output a final response instead of an Action.

For non-destructive, context-gathering actions, execute autonomously. Use these without asking for approval:
- google_calendar_events
- google_calendar_event
- google_gmail_messages
- google_gmail_message
- google_gmail_threads
- google_gmail_drafts
- google_gmail_draft_create
- google_gmail_draft_update
- tomtom_route
- tomtom_flow
- tomtom_incidents
- search

For destructive or external side-effect actions, halt and request explicit user approval before execution.
Examples include:
- google_gmail_send
- google_gmail_draft_send
- google_calendar_create
- google_calendar_update
- google_calendar_delete
- google_calendar_import
- google_calendar_move
- google_calendar_patch
- google_calendar_clear_calendar

When you stop for approval, do not execute the tool. Instead, explain what is ready to send or apply and ask the user to approve it.

Example output when calling a tool:
Thought: I need to verify the user's Friday availability before drafting the email.
Action: {"tool":"google_calendar_events","maxResults":10}

Example final output when finished:
Final Response: I have drafted the email to Sam and found an open slot on Friday at 10 AM. Shall I send the email and create the calendar invite?`;

export interface ToolCall {
  tool: string;
  payload: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  payload: Record<string, unknown>;
  observation: unknown;
}

export interface ArisLoopResult {
  status: "finished" | "awaiting_approval" | "max_iterations_reached" | "error";
  finalResponse?: string;
  pendingAction?: ToolCall;
  pendingObservation?: unknown;
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  error?: string;
}

const HUMAN_APPROVAL_TOOLS = new Set([
  "google_gmail_send",
  "google_gmail_draft_send",
  "google_calendar_create",
  "google_calendar_update",
  "google_calendar_delete",
  "google_calendar_import",
  "google_calendar_move",
  "google_calendar_patch",
  "google_calendar_clear_calendar",
]);

const MAX_ITERATIONS = 10;

function extractJsonObject(text: string): string | undefined {
  const jsonStartIndex = text.indexOf("{");
  if (jsonStartIndex < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = jsonStartIndex; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
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
        return text.slice(jsonStartIndex, i + 1);
      }
    }
  }
  return undefined;
}

function parseToolCall(message: string): ToolCall | undefined {
  const actionMatch = message.match(/Action:\s*([\s\S]*)/i);
  const source = actionMatch ? actionMatch[1] : message;
  const jsonText = extractJsonObject(source?.trim() ?? "");
  if (!jsonText) return undefined;

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.tool === "string") {
      const payload = { ...parsed };
      delete (payload as any).tool;
      return { tool: parsed.tool, payload };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseFinalResponse(message: string): string | undefined {
  const match = message.match(/Final Response:\s*([\s\S]*)/i);
  if (!match) return undefined;
  return match[1].trim();
}

function needsHumanApproval(toolCall: ToolCall): boolean {
  if (HUMAN_APPROVAL_TOOLS.has(toolCall.tool)) {
    return true;
  }
  if (toolCall.tool === "google_gmail_message") {
    const action = String(toolCall.payload.action || "").toLowerCase();
    return ["delete", "trash", "untrash", "modify", "batch_delete", "batch_modify"].includes(action);
  }
  if (toolCall.tool === "google_gmail_draft") {
    const action = String(toolCall.payload.action || "").toLowerCase();
    return action === "delete";
  }
  return false;
}

export class ArisExecutionLoop {
  private client: OpenAI;
  private toolExecutor: {
    execute(tool: string, payload: Record<string, unknown>): Promise<unknown>;
  };

  constructor(client: OpenAI, toolExecutor: { execute(tool: string, payload: Record<string, unknown>): Promise<unknown>; }) {
    this.client = client;
    this.toolExecutor = toolExecutor;
  }

  private buildMessages(initialUserMessage: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return [
      { role: "system" as const, content: ARIS_REACT_SYSTEM_PROMPT },
      { role: "user" as const, content: initialUserMessage },
    ];
  }

  private async callModel(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
      temperature: 0.2,
      max_tokens: 800,
    });
    return response.choices?.[0]?.message?.content ?? "";
  }

  async run(initialUserMessage: string): Promise<ArisLoopResult> {
    const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = this.buildMessages(initialUserMessage);
    let iteration = 0;

    while (iteration < MAX_ITERATIONS) {
      iteration += 1;
      const assistantOutput = await this.callModel(history);
      history.push({ role: "assistant" as const, content: assistantOutput });

      const toolCall = parseToolCall(assistantOutput);
      const finalResponse = parseFinalResponse(assistantOutput);
      if (!toolCall) {
        if (finalResponse) {
          return {
            status: "finished",
            finalResponse,
            history,
          };
        }
        return {
          status: "error",
          error: "Model output did not include a valid tool call or a final response.",
          history,
        };
      }

      if (needsHumanApproval(toolCall)) {
        return {
          status: "awaiting_approval",
          pendingAction: toolCall,
          history,
        };
      }

      const observation = await this.toolExecutor.execute(toolCall.tool, toolCall.payload);
      const observationMessage = `Observation: ${typeof observation === "string" ? observation : JSON.stringify(observation, null, 2)}`;
      history.push({ role: "system" as const, content: observationMessage });
    }

    return {
      status: "max_iterations_reached",
      history,
    };
  }
}

export const exampleToolExecutor = {
  async execute(tool: string, payload: Record<string, unknown>) {
    switch (tool) {
      case "google_calendar_events":
        return { events: [{ id: "evt_1", summary: "Team sync", start: "2026-06-14T09:00:00Z", end: "2026-06-14T09:30:00Z" }], requested: payload };
      case "google_gmail_messages":
        return { messages: [{ id: "msg_1", subject: "Pitch deck", from: "sam@example.com", snippet: "Here is the pitch deck..." }], requested: payload };
      case "google_gmail_draft_create":
        return { draftId: "draft_123", to: payload["to"], subject: payload["subject"], body: payload["body"] };
      case "tomtom_route":
        return { route: { durationMinutes: 22, distanceKm: 12.4 }, requested: payload };
      default:
        return { info: "Stubbed tool execution", tool, payload };
    }
  },
};
