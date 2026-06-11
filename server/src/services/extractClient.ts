import dotenv from "dotenv";
import axios from "axios";
import { info, error } from "../utils/logger";

dotenv.config();

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL?.trim();
if (!SEARCH_SERVICE_URL) {
  throw new Error("SEARCH_SERVICE_URL is required in environment configuration.");
}

export interface ExtractRequest {
  urls: string[] | string;
  limit?: number;
  timeoutMs?: number;
}

export interface ExtractResult {
  url: string;
  title: string;
  snippet: string;
  content: string;
  error?: string;
  warnings?: string[];
}

export interface ExtractResponse {
  results: ExtractResult[];
  elapsedMs: number;
  warnings?: string[];
}

export class ExtractClient {
  public async extract(request: ExtractRequest): Promise<ExtractResponse> {
    const requestBody = {
      ...request,
      urls: request.urls,
      limit: request.limit,
      timeoutMs: request.timeoutMs,
    };

    const url = `${SEARCH_SERVICE_URL}/api/extract`;
    info(`[extractClient] POST ${url} urls=${Array.isArray(requestBody.urls) ? requestBody.urls.length : 1} limit=${requestBody.limit ?? 0}`);

    try {
      const response = await axios.post<ExtractResponse>(url, requestBody, {
        timeout: requestBody.timeoutMs || 30000,
        headers: { "Content-Type": "application/json" }
      });
      info(`[extractClient] got ${response.status} from extract service, returned ${response.data.results.length} results`);
      return response.data;
    } catch (err: any) {
      error("[extractClient] extract request failed", {
        url,
        urls: requestBody.urls,
        error: err?.message,
        code: err?.code,
        response: err?.response?.data,
      });
      throw err;
    }
  }
}
