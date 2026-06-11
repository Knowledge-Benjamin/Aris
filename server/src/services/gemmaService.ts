import * as dotenv from "dotenv";
import axios from "axios";
import { info, error } from "../utils/logger";

dotenv.config();

const apiKey = process.env.GEMMA_API_KEY;
const apiUrl = process.env.GEMMA_API_URL;
const model = process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it";

function buildGemmaUrl() {
  if (!apiUrl) {
    return "";
  }
  return apiUrl.replace(/\/+$/, "") + `/models/${encodeURIComponent(model)}:generateContent`;
}

function isMessageNode(node: any): boolean {
  return node && typeof node === "object" && typeof node.role === "string" && typeof node.content !== "undefined";
}

function extractTextFromNode(node: any): string {
  if (node == null) {
    return "";
  }

  if (typeof node === "string") {
    return node.trim();
  }

  if (Array.isArray(node)) {
    const parts: string[] = [];
    for (const item of node) {
      const text = extractTextFromNode(item);
      if (text) {
        parts.push(text);
      }
    }
    return parts.filter(Boolean).join("\n");
  }

  if (isMessageNode(node)) {
    return extractTextFromNode(node.content);
  }

  if (typeof node.output_text === "string" && node.output_text.trim()) {
    return node.output_text.trim();
  }

  if (typeof node.text === "string" && node.text.trim()) {
    return node.text.trim();
  }

  if (typeof node.content !== "undefined") {
    return extractTextFromNode(node.content);
  }

  if (typeof node.parts !== "undefined") {
    return extractTextFromNode(node.parts);
  }

  if (typeof node.output !== "undefined") {
    return extractTextFromNode(node.output);
  }

  if (typeof node.candidates !== "undefined") {
    return extractTextFromNode(node.candidates);
  }

  return "";
}

function cleanReplyText(text: string): string {
  const normalized = text.replace(/\r/g, "");
  const preprocessed = normalized
    .replace(/[`"'“”‘’]*RESPONSE_START[`"'“”‘’]*/gi, "RESPONSE_START")
    .replace(/[`"'“”‘’]*RESPONSE_END[`"'“”‘’]*/gi, "RESPONSE_END");
  const markerMatch = preprocessed.match(/RESPONSE_START\s*([\s\S]*?)\s*RESPONSE_END/i);
  if (markerMatch) {
    return markerMatch[1].trim();
  }

  const lines = preprocessed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const markerLineRegex = /^\*+\s*(?:Response:|Aris:)\s*$/i;
  const finalAnswerRegex = /^(?:["'“‘`\s]*)(?:FINAL ANSWER|ANSWER)\s*:\s*(.*)$/i;
  const toolLineRegex = /^(?:TOOL_SEARCH|SEARCH_TOOL|SEARCH_QUERY)\s*[:=]\s*.+$/i;
  const toolJsonRegex = /^\{[^\n]*"tool"\s*:\s*"search"[^\n]*\}$/i;
  const instructionLineRegex = /^(?:\*+\s*)?(?:constraint|constraints|task:|the user:|user asks:|user says:|user:|query:|does the query|if the query|format:|observation:|the instructions|this looks like|the prompt contains|should respond|memory:|memories:|role:|roleplaying:|assistant:|system:|context:|i should|does it require a tool\?|is it a direct answer\?|is it well-organized\?|since i am|maintain the persona|acknowledge the name|sections?\/headings\?|blank lines\?|no tool call\?|no restating question\?|no metadata in visible answer\?|revised plan\*?|sections\*?:|output:|plan:|wait,|yes\.?|no\.?|persona:|constraints:|greeting:|section 1:|section 2:|section 3:|section 4:|section 5:)(?:\s|:|$)/i;

  const extractAnswerBlock = (startIndex: number) => {
    const answerLines: string[] = [];
    for (let i = startIndex; i < strippedLines.length; i++) {
      const line = strippedLines[i];
      if (toolLineRegex.test(line) || toolJsonRegex.test(line) || /^(?:MEMORY_ENTRIES|MEMORIES)\s*:/i.test(line) || markerLineRegex.test(line)) {
        break;
      }
      if (isInstructionLine(line)) {
        continue;
      }
      answerLines.push(line);
    }
    return answerLines.join("\n").trim();
  };

  const isInstructionLine = (line: string) => {
    const normalizedLine = line.trim();
    return instructionLineRegex.test(normalizedLine) ||
      normalizedLine.toLowerCase().includes("should output") ||
      normalizedLine.toLowerCase().includes("must output") ||
      normalizedLine.toLowerCase().includes("external internet search") ||
      normalizedLine.toLowerCase().includes("current state") ||
      normalizedLine.toLowerCase().includes("goal:") ||
      normalizedLine.toLowerCase().includes("i should") ||
      normalizedLine.toLowerCase().includes("does it require") ||
      normalizedLine.toLowerCase().includes("is it a direct answer") ||
      normalizedLine.toLowerCase().includes("is it well-organized") ||
      normalizedLine.toLowerCase().includes("maintain the persona") ||
      normalizedLine.toLowerCase().includes("acknowledge the name");
  };

  const strippedLines = lines.map((line) => line.replace(/^[*?]+\s*/, "").trim()).filter(Boolean);

  const finalAnswerIndex = strippedLines.findIndex((line) => finalAnswerRegex.test(line));
  if (finalAnswerIndex >= 0) {
    const match = strippedLines[finalAnswerIndex].match(finalAnswerRegex);
    const firstLine = (match?.[1] || "").replace(/^['"“‘]+|['"”’]+$/g, "").trim();
    const rest = extractAnswerBlock(finalAnswerIndex + 1);
    if (firstLine && rest) {
      return `${firstLine}\n${rest}`.trim();
    }
    if (rest) {
      return rest;
    }
    if (firstLine) {
      return firstLine;
    }
  }

  for (let i = strippedLines.length - 1; i >= 0; i--) {
    if (markerLineRegex.test(strippedLines[i])) {
      const rest = strippedLines.slice(i + 1).filter((line) => !isInstructionLine(line));
      if (rest.length) {
        const quoteLine = rest.slice().reverse().find((line) => /^['"“‘].+['"”’]$/.test(line));
        if (quoteLine) {
          return quoteLine.replace(/^['"“‘]+|['"”’]+$/g, "").trim();
        }
        return rest.join("\n").replace(/^['"“‘]+|['"”’]+$/g, "").trim();
      }
      return "";
    }
  }

  const toolLines = strippedLines.filter((line) => toolLineRegex.test(line) || toolJsonRegex.test(line));
  if (toolLines.length) {
    return toolLines[0].replace(/^['"“‘]+|['"”’]+$/g, "").trim();
  }

  const candidateLines = strippedLines.filter((line) => !isInstructionLine(line));
  if (candidateLines.length) {
    const quoteLine = candidateLines.slice().reverse().find((line) => /^['"“‘].+['"”’]$/.test(line));
    if (quoteLine) {
      return quoteLine.replace(/^['"“‘]+|['"”’]+$/g, "").trim();
    }
    return candidateLines.join("\n").replace(/^['"“‘]+|['"”’]+$/g, "").trim();
  }

  return "";
}

function isPlaceholderFinalAnswer(text: string): boolean {
  if (!text || !text.trim()) {
    return true;
  }
  const normalized = text.trim().replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim().toLowerCase();
  if (/^\.{1,3}$/.test(normalized)) {
    return true;
  }
  if (normalized.startsWith("final_answer") || normalized.startsWith("memory_entries")) {
    return true;
  }
  if (normalized.includes("single string containing the formatted text") || normalized.includes("single string containing the formatted text.")) {
    return true;
  }
  if (normalized.includes("no new stable personal details") || normalized.includes("no new stable personal details.")) {
    return true;
  }
  if (normalized.includes("valid json") || normalized.includes("valid json with")) {
    return true;
  }
  return false;
}

function extractJsonFromText(text: string): { final_answer: string; memory_entries: string[] } | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\r/g, "");
  const targetKey = '"final_answer"';
  let searchIndex = normalized.indexOf(targetKey);
  const candidates: string[] = [];

  while (searchIndex !== -1) {
    const openBrace = normalized.lastIndexOf("{", searchIndex);
    if (openBrace === -1) {
      break;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = openBrace; i < normalized.length; i++) {
      const ch = normalized[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(normalized.slice(openBrace, i + 1));
          break;
        }
      }
    }

    searchIndex = normalized.indexOf(targetKey, searchIndex + targetKey.length);
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (
        parsed &&
        typeof parsed.final_answer === "string" &&
        Array.isArray(parsed.memory_entries) &&
        !isPlaceholderFinalAnswer(parsed.final_answer)
      ) {
        return {
          final_answer: parsed.final_answer.trim(),
          memory_entries: parsed.memory_entries
            .filter((item: any) => typeof item === "string")
            .map((item: string) => item.trim())
            .filter(Boolean),
        };
      }
    } catch {
      // ignore parse failures and continue with the next candidate
    }
  }

  return null;
}

function extractPseudoJsonFromText(text: string): { final_answer: string; memory_entries: string[] } | null {
  if (!text) {
    return null;
  }

  const normalized = text
    .replace(/\r/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/`/g, "")
    .trim();

  const lines = normalized.split(/\n/);
  const normalizeLine = (line: string) => line.replace(/^[`*\-\s>]+/, "").trim().toLowerCase();
  const finalIndices: number[] = [];
  const memoryIndices: number[] = [];

  lines.forEach((line, index) => {
    const normalizedLine = normalizeLine(line);
    if (normalizedLine.startsWith("final_answer:")) {
      finalIndices.push(index);
    }
    if (normalizedLine.startsWith("memory_entries:")) {
      memoryIndices.push(index);
    }
  });

  if (!finalIndices.length) {
    return null;
  }

  for (let i = finalIndices.length - 1; i >= 0; i--) {
    const finalIndex = finalIndices[i];
    const memoryIndex = memoryIndices.find((idx) => idx > finalIndex) ?? -1;
    const finalEndIndex = memoryIndex >= 0 ? memoryIndex : lines.length;
    const finalLines = lines.slice(finalIndex, finalEndIndex);
    if (!finalLines.length) {
      continue;
    }

    const header = finalLines[0];
    const firstColon = header.indexOf(":");
    const firstLineValue = firstColon >= 0 ? header.slice(firstColon + 1) : "";
    const answerLines = [firstLineValue.trim(), ...finalLines.slice(1)];
    let final_answer = answerLines.join("\n").trim();
    final_answer = final_answer.replace(/^['"]/, "").replace(/['"]$/, "").trim();

    if (isPlaceholderFinalAnswer(final_answer)) {
      continue;
    }

    const memory_entries = memoryIndex >= 0 ? parsePseudoMemoryEntries(lines.slice(memoryIndex)) : [];
    return {
      final_answer,
      memory_entries,
    };
  }

  return null;
}

function parsePseudoMemoryEntries(lines: string[]): string[] {
  if (!lines.length) {
    return [];
  }

  const firstLine = lines[0].trim();
  const colonIndex = firstLine.indexOf(":");
  const firstValue = colonIndex >= 0 ? firstLine.slice(colonIndex + 1).trim() : "";

  if (firstValue === "[]") {
    return [];
  }

  const arrayLines: string[] = [];
  if (firstValue.startsWith("[")) {
    arrayLines.push(firstValue);
    for (let i = 1; i < lines.length; i++) {
      arrayLines.push(lines[i].trim());
      if (lines[i].includes("]")) {
        break;
      }
    }

    const joined = arrayLines.join(" ").replace(/([\"'])\s*,\s*([\"'])/g, "$1,$2");
    try {
      const parsed = JSON.parse(joined);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      // ignore invalid JSON and fall back to line parsing
    }
  }

  const entries: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) {
      continue;
    }
    const normalizedLine = rawLine.replace(/^[`*\-\s>]+/, "").trim();
    if (/^[A-Za-z_]+\s*:\s*/.test(normalizedLine)) {
      break;
    }
    const entry = normalizedLine.replace(/[`"'“”’]+$/, "").trim();
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function extractGeneratedText(data: any): string {
  if (!data) {
    return "";
  }

  let rawText = "";
  if (data?.candidates && Array.isArray(data.candidates) && data.candidates.length) {
    const candidate = data.candidates[0];
    if (typeof candidate.output_text === "string" && candidate.output_text.trim()) {
      rawText = candidate.output_text.trim();
    } else if (typeof candidate.text === "string" && candidate.text.trim()) {
      rawText = candidate.text.trim();
    } else {
      rawText = extractTextFromNode(candidate);
    }
  }

  if (!rawText) {
    if (typeof data.output_text === "string" && data.output_text.trim()) {
      rawText = data.output_text.trim();
    } else if (typeof data.text === "string" && data.text.trim()) {
      rawText = data.text.trim();
    } else if (typeof data === "string") {
      rawText = data;
    } else {
      rawText = extractTextFromNode(data);
    }
  }

  if (!rawText) {
    return "";
  }

  return cleanReplyText(rawText);
}

function extractMemoryEntriesFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const normalized = text.replace(/\r/g, "").trim();
  const jsonMatch = normalized.match(/MEMORY_ENTRIES\s*:\s*(\[[\s\S]*?\])\s*$/im);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      // ignore invalid JSON and fall back to line parsing
    }
  }

  const lines = normalized.split(/\n/);
  const markerIndex = lines.findIndex((line) => /^(?:MEMORY_ENTRIES|MEMORIES)\s*:/i.test(line));
  if (markerIndex >= 0) {
    const entries: string[] = [];
    for (let i = markerIndex + 1; i < lines.length; i++) {
      const rawLine = lines[i].trim();
      if (!rawLine) {
        continue;
      }
      if (/^(?:FINAL ANSWER|ANSWER)\s*:/i.test(rawLine)) {
        break;
      }
      const entry = rawLine.replace(/^[`"'“‘\-\*\s>]+/, "").replace(/[`"'”’]+$/, "").trim();
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length) {
      return entries;
    }
  }

  const inlineMatch = normalized.match(/MEMORY_ENTRIES\s*:\s*(.+)$/im);
  if (inlineMatch && inlineMatch[1]) {
    const inlineValue = inlineMatch[1].trim();
    if (inlineValue.startsWith("[")) {
      try {
        const parsed = JSON.parse(inlineValue);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
        }
      } catch {
        // ignore invalid JSON
      }
    } else {
      return [inlineValue.replace(/^[`"'“‘]+|[`"'”’]+$/g, "").trim()].filter(Boolean);
    }
  }

  return [];
}

export interface ArisAdviceResponse {
  reply: string;
  memoryEntries: string[];
}

export class GemmaService {
  async requestArisAdvice(prompt: string): Promise<ArisAdviceResponse> {
    if (!apiKey || !apiUrl) {
      return {
        reply: "[Aris advisor unavailable: missing Gemma API config.]",
        memoryEntries: [],
      };
    }

    const url = buildGemmaUrl();
    const requestPayload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 1400,
        temperature: 0,
      },
    };

    info(`[gemma] sending request to ${url}`);
    info(`[gemma] request payload prompt length=${prompt.length} chars`);
    info(`[gemma] request payload preview=${JSON.stringify(prompt.slice(0, 300)).replace(/\\n/g, "\\n")}...`);

    let response;
    try {
      response = await axios.post(
        url,
        requestPayload,
        {
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
        }
      );

      info(`[gemma] request succeeded status=${response.status} statusText=${response.statusText}`);
      info(`[gemma] response keys=${Object.keys(response.data || {}).join(",")}`);
    } catch (requestError: any) {
      error("[gemma] request failed", {
        url,
        method: requestError.config?.method,
        status: requestError.response?.status,
        statusText: requestError.response?.statusText,
        headers: requestError.response?.headers,
        body: requestError.response?.data,
        message: requestError.message,
        requestPayloadPreview: JSON.stringify(requestPayload).slice(0, 1000),
      });
      return {
        reply: "[Aris advisor unavailable: failed to contact Gemma API.]",
        memoryEntries: [],
      };
    }

    const rawText = extractTextFromNode(response.data);
    const cleanedText = cleanReplyText(rawText);
    const rawDebug = rawText.length > 1000 ? `${rawText.slice(0, 1000)}...` : rawText;
    info(`[gemma] raw extracted text (${rawText.length} chars): ${rawDebug}`);
    if (rawText !== cleanedText) {
      const cleanDebug = cleanedText.length > 1000 ? `${cleanedText.slice(0, 1000)}...` : cleanedText;
      info(`[gemma] cleaned extracted text (${cleanedText.length} chars): ${cleanDebug}`);
    }

    const jsonResponse = extractJsonFromText(cleanedText) || extractPseudoJsonFromText(cleanedText);
    let generated: string;
    let memoryEntries: string[];

    if (jsonResponse) {
      generated = jsonResponse.final_answer;
      memoryEntries = jsonResponse.memory_entries;
      info("[gemma] parsed JSON response.");
    } else {
      memoryEntries = extractMemoryEntriesFromText(cleanedText);
      generated = extractGeneratedText(cleanedText);
    }

    info(`[gemma] cleaned reply: ${generated}`);
    if (memoryEntries.length) {
      info(`[gemma] parsed memory entries: ${JSON.stringify(memoryEntries)}`);
    }

    return {
      reply: generated || "[Aris advisor returned no response.]",
      memoryEntries,
    };
  }
}
