import dotenv from "dotenv";
import axios from "axios";
import { info, error } from "../utils/logger";

dotenv.config();

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL?.trim();
if (!SEARCH_SERVICE_URL) {
  throw new Error("SEARCH_SERVICE_URL is required in environment configuration.");
}

const DEFAULT_SEARCH_ENGINES = process.env.SEARCH_TOOL_ENGINES || "google,bing,duckduckgo,searx";

export interface SearchRequest {
  query: string;
  engines?: string;
  limit?: number;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  engine: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  engines: string[];
  engineUsed: string;
  proxyUsed?: string;
  warnings?: string[];
  elapsedMs: number;
}

export class SearchClient {
  public async search(request: SearchRequest): Promise<SearchResponse> {
    const requestBody = {
      ...request,
      engines: request.engines || DEFAULT_SEARCH_ENGINES,
    };

    const url = `${SEARCH_SERVICE_URL}/api/search`;
    info(`[searchClient] POST ${url} query="${requestBody.query}" engines="${requestBody.engines}" limit=${requestBody.limit ?? 0}`);

    try {
      const response = await axios.post<SearchResponse>(url, requestBody, {
        timeout: 30000,
        headers: { "Content-Type": "application/json" }
      });
      info(`[searchClient] got ${response.status} from search service, returned ${response.data.results.length} results`);
      return response.data;
    } catch (err: any) {
      error("[searchClient] search request failed", {
        url,
        query: requestBody.query,
        engines: requestBody.engines,
        error: err?.message,
        code: err?.code,
        response: err?.response?.data,
      });
      throw err;
    }
  }
}
