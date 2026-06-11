import dotenv from "dotenv";
import axios from "axios";
import { info, error } from "../utils/logger";

dotenv.config();

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL?.trim();
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY?.trim();

if (!EMBEDDING_SERVICE_URL) {
  throw new Error("EMBEDDING_SERVICE_URL is required in environment configuration.");
}

export class EmbeddingClient {
  public async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (EMBEDDING_API_KEY) {
      headers.Authorization = `Bearer ${EMBEDDING_API_KEY}`;
    }

    try {
      info(`[embeddingClient] request embed ${texts.length} texts`);
      const response = await axios.post<{ embeddings: number[][] }>(
        `${EMBEDDING_SERVICE_URL}/embed`,
        { texts },
        { headers, timeout: 30000 }
      );

      if (!response.data || !Array.isArray(response.data.embeddings)) {
        throw new Error("Invalid embedding response format");
      }

      return response.data.embeddings;
    } catch (err: any) {
      error("[embeddingClient] embed request failed", {
        url: `${EMBEDDING_SERVICE_URL}/embed`,
        error: err?.message,
        response: err?.response?.data,
      });
      throw err;
    }
  }
}
