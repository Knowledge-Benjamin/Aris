import axios from "axios";
import { info, error } from "../utils/logger";

const voiceApiKey = process.env.VOICE_API_KEY || process.env.GEMMA_API_KEY;
const sttUrl = process.env.VOICE_STT_URL || "https://speech.googleapis.com/v1/speech:recognize";
const ttsUrl = process.env.VOICE_TTS_URL || "https://texttospeech.googleapis.com/v1/text:synthesize";
const ttsLanguageCode = process.env.VOICE_LANGUAGE_CODE || "en-US";
const ttsVoiceName = process.env.VOICE_TTS_VOICE || "en-US-Wavenet-D";
const ttsAudioEncoding = process.env.VOICE_TTS_AUDIO_ENCODING || "MP3";

function getWavAudioMetadata(audioBase64: string) {
  try {
    const buffer = Buffer.from(audioBase64, "base64");
    if (buffer.length < 44) return null;
    if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
    if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

    const chunkSize = buffer.readUInt32LE(16);
    const audioFormat = buffer.readUInt16LE(20);
    const channels = buffer.readUInt16LE(22);
    const sampleRateHertz = buffer.readUInt32LE(24);
    const bitsPerSample = buffer.readUInt16LE(34);

    const metadata: any = {
      audioFormat,
      sampleRateHertz: sampleRateHertz || undefined,
      audioChannelCount: channels || undefined,
      bitsPerSample: bitsPerSample || undefined,
    };

    if (audioFormat === 0xfffe && chunkSize >= 40 && buffer.length >= 54) {
      const cbSize = buffer.readUInt16LE(36);
      if (cbSize >= 22) {
        const subFormat = buffer.readUInt16LE(44);
        metadata.isExtensible = true;
        metadata.subFormat = subFormat;
        if (subFormat === 1) {
          metadata.audioFormat = 1;
        }
      }
    }

    return metadata;
  } catch {
    return null;
  }
}

function mimeTypeToSpeechEncoding(mimeType: string): string | undefined {
  const normalized = (mimeType || "").toLowerCase();
  if (normalized.includes("opus") || normalized.includes("webm") || normalized.includes("ogg")) {
    return normalized.includes("webm") ? "WEBM_OPUS" : "OGG_OPUS";
  }
  if (normalized.includes("mp3")) {
    return "MP3";
  }
  if (normalized.includes("wav") || normalized.includes("wave")) {
    return undefined;
  }
  if (normalized.includes("raw") || normalized.includes("pcm")) {
    return "LINEAR16";
  }
  if (normalized.includes("flac")) {
    return "FLAC";
  }
  return "LINEAR16";
}

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
  async transcribeAudio(audioBase64: string, mimeType: string) {
    if (!voiceApiKey) {
      throw new Error("Missing VOICE_API_KEY environment variable.");
    }

    info(`[voice] received transcribe request mimeType=${mimeType} base64Length=${audioBase64.length}`);
    const encoding = mimeTypeToSpeechEncoding(mimeType);
    const config: any = {
      languageCode: ttsLanguageCode,
      enableAutomaticPunctuation: true,
    };

    if (encoding) {
      config.encoding = encoding;
    }

    if (mimeType.toLowerCase().includes("wav")) {
      const wavMetadata = getWavAudioMetadata(audioBase64);
      if (!wavMetadata) {
        error("[voice] invalid WAV header", { mimeType, base64Length: audioBase64.length });
        throw new Error("Unable to parse WAV header from provided audio.");
      }
      info(`[voice] WAV metadata parsed ${JSON.stringify(wavMetadata)}`);

      if (wavMetadata.bitsPerSample && wavMetadata.bitsPerSample !== 16) {
        error("[voice] unsupported WAV bit depth", wavMetadata);
        throw new Error(
          `Unsupported WAV sample size ${wavMetadata.bitsPerSample}-bit. Google Speech-to-Text requires 16-bit PCM for WAV/LINEAR16 audio.`
        );
      }
      const isExtensible = wavMetadata.audioFormat === 0xfffe;
      const isPcmExtensible = isExtensible && wavMetadata.subFormat === 1;
      if (!isExtensible && wavMetadata.audioFormat !== 1) {
        error("[voice] unsupported WAV format", wavMetadata);
        throw new Error(
          `Unsupported WAV audio format ${wavMetadata.audioFormat}. Only PCM WAV audio is supported for LINEAR16 transcription.`
        );
      }
      if (isExtensible && !isPcmExtensible) {
        error("[voice] unsupported WAV extensible subformat", wavMetadata);
        throw new Error(
          `Unsupported WAV extensible subformat ${wavMetadata.subFormat}. Only PCM WAV audio is supported for LINEAR16 transcription.`
        );
      }

      config.encoding = "LINEAR16";
      if (wavMetadata.sampleRateHertz) {
        config.sampleRateHertz = wavMetadata.sampleRateHertz;
      }
      if (wavMetadata.audioChannelCount) {
        config.audioChannelCount = wavMetadata.audioChannelCount;
      }
    } else if (encoding === "LINEAR16") {
      config.sampleRateHertz = 16000;
      config.audioChannelCount = 1;
    }

    const requestBody = {
      config,
      audio: {
        content: audioBase64,
      },
    };

    info(`[voice] final STT config ${JSON.stringify(config)}`);
    try {
      info(`[voice] transcribing audio with mimeType=${mimeType} base64Length=${audioBase64.length}`);
      const response = await axios.post(`${sttUrl}?key=${encodeURIComponent(voiceApiKey)}`, requestBody, {
        headers: {
          "Content-Type": "application/json",
        },
      });

      const results = response.data?.results;
      const status = response.status;
      if (!Array.isArray(results) || !results.length) {
        info(`[voice] transcribeAudio returned no transcript results status=${status} response=${JSON.stringify(response.data)}`);
        return "";
      }

      return results
        .map((result: any) => result.alternatives?.[0]?.transcript)
        .filter((transcript: any) => typeof transcript === "string" && transcript.trim())
        .join(" ")
        .trim();
    } catch (err: any) {
      error("[voice] transcribeAudio error", {
        message: err.message,
        status: err.response?.status,
        data: err.response?.data,
        config,
      });
      throw new Error("Voice transcription failed.");
    }
  }

  async synthesizeSpeech(text: string, audioEncoding?: string) {
    if (!voiceApiKey) {
      throw new Error("Missing VOICE_API_KEY environment variable.");
    }

    const encoding = audioEncoding || ttsAudioEncoding;
    const requestBody = {
      input: {
        text,
      },
      voice: {
        languageCode: ttsLanguageCode,
        name: ttsVoiceName,
      },
      audioConfig: {
        audioEncoding: encoding,
      },
    };

    try {
      info(`[voice] synthesizing speech with voice=${ttsVoiceName} audioEncoding=${encoding}`);
      const response = await axios.post(`${ttsUrl}?key=${encodeURIComponent(voiceApiKey)}`, requestBody, {
        headers: {
          "Content-Type": "application/json",
        },
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
