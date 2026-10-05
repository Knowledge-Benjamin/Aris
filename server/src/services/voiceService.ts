import axios from "axios";
import { info, error } from "../utils/logger";

const ttsUrl = process.env.VOICE_TTS_URL || "https://bravadoben-cc-proxy.hf.space/v1/text:synthesize";
const ttsVoiceName = process.env.VOICE_TTS_VOICE || "af_heart";
const ttsAudioEncoding = process.env.VOICE_TTS_AUDIO_ENCODING || "MP3";

function audioEncodingToMimeType(encoding: string): string {
  switch (encoding.toUpperCase()) {
    case "MP3":
      return "audio/mpeg";
    case "OGG_OPUS":
      return "audio/ogg";
    case "WEBM_OPUS":
      return "audio/webm";
    case "LINEAR16":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

export class VoiceService {
  async synthesizeSpeech(text: string, audioEncoding?: string) {
    const encoding = audioEncoding || ttsAudioEncoding;
    const requestBody = {
      input: {
        text,
      },
      voice: {
        name: ttsVoiceName,
      },
      audioConfig: {
        audioEncoding: encoding,
      },
    };

    try {
      info(`[voice] synthesizing speech with voice=${ttsVoiceName} audioEncoding=${encoding}`);
      const response = await axios.post(ttsUrl, requestBody, {
        headers: { "Content-Type": "application/json" },
      });

      const audioContent = response.data?.audioContent;
      if (!audioContent || typeof audioContent !== "string") {
        throw new Error("Invalid TTS response from provider.");
      }

      return {
        audioBase64: audioContent,
        mimeType: audioEncodingToMimeType(encoding),
      };
    } catch (err: any) {
      error("[voice] synthesizeSpeech error", {
        message: err.message,
        status: err.response?.status,
        data: err.response?.data,
      });
      throw new Error("Voice synthesis failed.");
    }
  }
}
