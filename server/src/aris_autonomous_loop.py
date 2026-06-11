import json
from typing import Any, Dict, List, Optional
from openai import OpenAI

ARIS_REACT_SYSTEM_PROMPT = """You are Aris, an autonomous AI assistant that reasons proactively and chains tools until the user's goal is resolved.

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
Final Response: I have drafted the email to Sam and found an open slot on Friday at 10 AM. Shall I send the email and create the calendar invite?"""

HUMAN_APPROVAL_TOOLS = {
    "google_gmail_send",
    "google_gmail_draft_send",
    "google_calendar_create",
    "google_calendar_update",
    "google_calendar_delete",
    "google_calendar_import",
    "google_calendar_move",
    "google_calendar_patch",
    "google_calendar_clear_calendar",
}

MAX_ITERATIONS = 10


def extract_json_object(text: str) -> Optional[str]:
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i, ch in enumerate(text[start:], start=start):
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def parse_tool_call(message: str) -> Optional[Dict[str, Any]]:
    action_match = None
    for line in message.splitlines():
        if line.strip().startswith("Action:"):
            action_match = line.split("Action:", 1)[1]
            break
    source = action_match or message
    json_text = extract_json_object(source)
    if not json_text:
        return None
    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict) and isinstance(parsed.get("tool"), str):
        parsed_payload = dict(parsed)
        parsed_payload.pop("tool", None)
        return {"tool": parsed["tool"], "payload": parsed_payload}
    return None


def parse_final_response(message: str) -> Optional[str]:
    for line in message.splitlines():
        if line.strip().startswith("Final Response:"):
            return line.split("Final Response:", 1)[1].strip()
    return None


def needs_human_approval(tool_call: Dict[str, Any]) -> bool:
    tool_name = tool_call["tool"]
    if tool_name in HUMAN_APPROVAL_TOOLS:
        return True
    if tool_name == "google_gmail_message":
        action = str(tool_call["payload"].get("action", "")).lower()
        return action in {"delete", "trash", "untrash", "modify", "batch_delete", "batch_modify"}
    if tool_name == "google_gmail_draft":
        action = str(tool_call["payload"].get("action", "")).lower()
        return action == "delete"
    return False


class ToolExecutor:
    async def execute(self, tool: str, payload: Dict[str, Any]) -> Any:
        if tool == "google_calendar_events":
            return {
                "events": [
                    {"id": "evt_1", "summary": "Friday sync", "start": "2026-06-14T10:00:00Z", "end": "2026-06-14T10:30:00Z"}
                ],
                "requested": payload,
            }
        if tool == "google_gmail_messages":
            return {
                "messages": [
                    {"id": "msg_1", "subject": "Pitch deck", "from": "sam@example.com", "snippet": "Attached is the pitch deck for Friday."}
                ],
                "requested": payload,
            }
        if tool == "google_gmail_draft_create":
            return {
                "draftId": "draft_123",
                "to": payload.get("to"),
                "subject": payload.get("subject"),
                "body": payload.get("body"),
            }
        if tool == "tomtom_route":
            return {
                "route": {"durationMinutes": 18, "distanceKm": 12.7},
                "requested": payload,
            }
        return {"tool": tool, "payload": payload, "info": "stubbed execution"}


class ArisExecutionLoop:
    def __init__(self, client: OpenAI, tool_executor: ToolExecutor):
        self.client = client
        self.tool_executor = tool_executor

    def build_messages(self, initial_user_message: str) -> List[Dict[str, str]]:
        return [
            {"role": "system", "content": ARIS_REACT_SYSTEM_PROMPT},
            {"role": "user", "content": initial_user_message},
        ]

    async def call_model(self, messages: List[Dict[str, str]]) -> str:
        response = await self.client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            temperature=0.2,
            max_tokens=800,
        )
        return response.choices[0].message.content

    async def run(self, initial_user_message: str) -> Dict[str, Any]:
        messages = self.build_messages(initial_user_message)
        iteration = 0

        while iteration < MAX_ITERATIONS:
            iteration += 1
            assistant_content = await self.call_model(messages)
            messages.append({"role": "assistant", "content": assistant_content})

            tool_call = parse_tool_call(assistant_content)
            final_response = parse_final_response(assistant_content)
            if not tool_call:
                if final_response:
                    return {
                        "status": "finished",
                        "final_response": final_response,
                        "history": messages,
                    }
                return {
                    "status": "error",
                    "error": "Model output did not include a valid tool call or final response.",
                    "history": messages,
                }

            if needs_human_approval(tool_call):
                return {
                    "status": "awaiting_approval",
                    "pending_action": tool_call,
                    "history": messages,
                }

            observation = await self.tool_executor.execute(tool_call["tool"], tool_call["payload"])
            observation_str = json.dumps(observation, indent=2) if not isinstance(observation, str) else observation
            messages.append({"role": "system", "content": f"Observation: {observation_str}"})

        return {
            "status": "max_iterations_reached",
            "history": messages,
        }
