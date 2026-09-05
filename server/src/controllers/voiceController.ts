import { Request, Response } from "express";
import { getDatabasePool } from "../db/db";
import { VaultStore } from "../db/vaultStore";
import { info, error } from "../utils/logger";
import { GemmaService } from "../services/gemmaService";

const pool = getDatabasePool();
const vault = new VaultStore(pool);
const gemma = new GemmaService();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Ask Gemma to derive a rough speaker embedding from an audio clip.
 * Gemma cannot produce a true ML embedding vector, but it can compare two audio clips
 * and decide whether they belong to the same speaker — which is exactly what we need.
 * The "print" stored in the vault is simply the raw Base64 of the clearest enrollment sample.
 */
async function extractVoicePrint(audioBase64: string): Promise<string> {
  // We store the raw audio as the "print". Comparison is done via Gemma's multimodal reasoning.
  return audioBase64;
}

// ─── Enrollment ─────────────────────────────────────────────────────────────

export async function enrollVoice(req: Request, res: Response) {
  try {
    const { userId, audioBase64 } = req.body;
    if (!userId || !audioBase64) {
      return res.status(400).json({ error: "Missing userId or audioBase64" });
    }

    info(`[Voice] Enrolling sample for user ${userId}`);

    // Retrieve any existing samples (up to 5 stored as voice_print_0 … voice_print_4)
    let sampleIndex = 0;
    for (let i = 0; i < 5; i++) {
      const existing = await vault.retrieveSecret(userId, `voice_print_${i}`);
      if (!existing) { sampleIndex = i; break; }
      sampleIndex = i + 1;
    }

    if (sampleIndex >= 5) sampleIndex = 4; // overwrite oldest if full

    await vault.storeSecret(userId, `voice_print_${sampleIndex}`, audioBase64);
    info(`[Voice] Stored enrollment sample ${sampleIndex} for user ${userId}`);

    res.json({ success: true, samplesStored: sampleIndex + 1 });
  } catch (err) {
    error("[Voice] Enroll error", err);
    res.status(500).json({ error: "Voice enrollment failed" });
  }
}

// ─── Verification ────────────────────────────────────────────────────────────

export async function verifyVoice(req: Request, res: Response) {
  try {
    const { userId, audioBase64 } = req.body;
    if (!userId || !audioBase64) {
      return res.status(400).json({ error: "Missing userId or audioBase64" });
    }

    info(`[Voice] Verifying voice for user ${userId}`);

    // Retrieve up to 5 stored prints
    const prints: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await vault.retrieveSecret(userId, `voice_print_${i}`);
      if (p) prints.push(p);
    }

    if (prints.length === 0) {
      return res.status(404).json({ error: "No voice prints enrolled for this user." });
    }

    // Use the first (or most recently stored) print as the reference
    const referencePrint = prints[prints.length - 1];

    const prompt = `
      You are a speaker recognition expert.
      You will be given two audio clips (as Base64-encoded OGG/Opus data):
      REFERENCE AUDIO (the enrolled speaker): [See inlineData_1]
      CANDIDATE AUDIO (the person speaking now): [See inlineData_2]
      
      Listen to both clips carefully and answer ONLY with a raw JSON object:
      {
        "same_speaker": true | false,
        "confidence": 0.0 to 1.0
      }
    `;

    let verified = false;
    let confidence = 0.0;

    try {
      const result = await gemma.compareVoicePrints(prompt, referencePrint, audioBase64);
      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      verified = parsed.same_speaker === true && parsed.confidence > 0.65;
      confidence = parsed.confidence ?? 0.0;
    } catch (parseErr) {
      error("[Voice] Could not parse Gemma response for voice verify", parseErr);
    }

    info(`[Voice] Verification result for user ${userId}: ${verified} (confidence: ${confidence})`);
    res.json({ verified, confidence });
  } catch (err) {
    error("[Voice] Verify error", err);
    res.status(500).json({ error: "Voice verification failed" });
  }
}
