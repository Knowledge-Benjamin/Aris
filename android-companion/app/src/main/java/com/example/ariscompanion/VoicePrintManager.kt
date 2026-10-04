package com.example.ariscompanion

import android.content.Context
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.DataOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Handles voice-print (speaker recognition) enrollment and verification.
 *
 * Strategy:
 *   1. Enrollment  – Record 3-5 clean utterances, upload as Base64 audio to the backend.
 *      The backend sends each sample to Gemma with the prompt:
 *      "Extract a numerical audio fingerprint vector for this voice."
 *      The vector is stored (AES-256-GCM) in the secure_vault table as key "voice_print".
 *
 *   2. Verification – Record a short phrase from the ambient microphone, send it to
 *      the backend, which embeds it and computes cosine-similarity against the stored print.
 *      Returns a boolean PASS / FAIL with a confidence score.
 *
 *   This gives us speaker recognition with *zero* on-device ML libraries —
 *   all heavy lifting is done on the already-running backend + Gemma.
 */
object VoicePrintManager {

    private const val TAG = "VoicePrintManager"

    // Files are created here, then uploaded and immediately deleted.
    private fun tmpFile(context: Context): File =
        File(context.cacheDir, "voice_enroll_${System.currentTimeMillis()}.ogg")

    // ------- Enrollment -------

    /**
     * Upload a single enrollment sample (OGG Base64) to the backend.
     * Call this 3-5 times with different 5-second utterances.
     */
    suspend fun uploadEnrollmentSample(
        context: Context,
        audioBase64: String,
        userId: Int,
        serverUrl: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = URL("${serverUrl.trimEnd('/')}/api/aris/voice/enroll")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true

            val body = JSONObject().apply {
                put("userId", userId)
                put("audioBase64", audioBase64)
            }

            DataOutputStream(conn.outputStream).use { it.writeBytes(body.toString()) }
            val code = conn.responseCode
            conn.disconnect()
            Log.d(TAG, "Enrollment sample upload → $code")
            code == 200
        } catch (e: Exception) {
            Log.e(TAG, "Enrollment upload failed", e)
            false
        }
    }

    // ------- Verification -------

    /**
     * Send a short audio clip to the backend for speaker verification.
     * Returns true only if the voice matches the stored print.
     */
    suspend fun verifyVoice(
        audioBase64: String,
        userId: Int,
        serverUrl: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = URL("${serverUrl.trimEnd('/')}/api/aris/voice/verify")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true

            val body = JSONObject().apply {
                put("userId", userId)
                put("audioBase64", audioBase64)
            }

            DataOutputStream(conn.outputStream).use { it.writeBytes(body.toString()) }
            val responseBody = conn.inputStream.bufferedReader().readText()
            conn.disconnect()

            val responseJson = JSONObject(responseBody)
            val verified = responseJson.optBoolean("verified", false)
            val confidence = responseJson.optDouble("confidence", 0.0)
            Log.d(TAG, "Voice verify → verified=$verified confidence=$confidence")
            verified
        } catch (e: Exception) {
            Log.e(TAG, "Voice verification failed", e)
            false
        }
    }
}
