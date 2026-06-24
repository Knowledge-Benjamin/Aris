import { info, error } from "../utils/logger";
import axios from "axios";

export interface TranslateRequest {
  source_language: string;
  target_language: string;
  text: string;
}

export interface TranslateResponse {
  text: string;
}

export class SunbirdService {
  private readonly translateUrl = "https://api.sunbird.ai/tasks/translate";

  constructor() {}

  /**
   * Translates text between supported languages.
   * Typical language codes: 'eng' (English), 'lug' (Luganda), 'xog' (Lusoga).
   */
  async translateText(params: TranslateRequest): Promise<string> {
    const apiKey = process.env.SUNBIRD_API_KEY;

    if (!apiKey) {
      throw new Error("Sunbird API key (SUNBIRD_API_KEY) is not set in environment variables.");
    }

    try {
      const response = await axios.post(
        this.translateUrl,
        {
          source_language: params.source_language,
          target_language: params.target_language,
          text: params.text,
        },
        {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      // Assuming the response returns an object with a 'text' property containing the translation
      if (response.data && response.data.text) {
        return response.data.text;
      } else {
        // Handle unexpected response format
        return JSON.stringify(response.data);
      }
    } catch (err: any) {
      error("Sunbird translation failed:", err?.response?.data || err.message);
      throw new Error(`Translation failed: ${err.message}`);
    }
  }
}
