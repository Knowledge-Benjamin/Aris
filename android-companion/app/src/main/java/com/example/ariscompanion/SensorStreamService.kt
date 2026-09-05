package com.example.ariscompanion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.DataOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class SensorStreamService : Service() {
    private var mediaRecorder: MediaRecorder? = null
    private var outputFile: String = ""
    private var isRecording = false
    
    private val serviceScope = CoroutineScope(Dispatchers.IO + Job())
    private var recordingJob: Job? = null
    
    // Basic VAD threshold (amplitude usually goes up to 32767)
    // 1500 is a reasonable noise floor for silence, needs tweaking per device
    private val VAD_AMPLITUDE_THRESHOLD = 1500 

    companion object {
        const val CHANNEL_ID = "ArisCompanionChannel"
        const val SERVER_URL = "http://10.0.2.2:3000/api"
        const val USER_ID = 1 // Replace with dynamic auth later
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aris is Listening")
            .setContentText("Ambient intelligence active")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now) 
            .build()
            
        startForeground(1, notification)
        outputFile = "${externalCacheDir?.absolutePath}/ambient_audio.ogg"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isRecording) {
            startAudioCaptureLoop()
        }
        return START_STICKY
    }

    private fun startAudioCaptureLoop() {
        isRecording = true
        AudioState.isListening.value = true
        
        recordingJob = serviceScope.launch {
            while (isRecording) {
                recordChunkWithVAD()
            }
        }
    }

    private suspend fun recordChunkWithVAD() {
        try {
            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                MediaRecorder()
            }
            
            mediaRecorder?.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.OGG)
                setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
                setOutputFile(outputFile)
                prepare()
                start()
            }
            
            var maxChunkAmplitude = 0
            val chunkDurationMs = 30000L
            val pollIntervalMs = 50L
            val iterations = chunkDurationMs / pollIntervalMs
            
            for (i in 0 until iterations) {
                if (!isRecording) break
                val amp = mediaRecorder?.maxAmplitude ?: 0
                if (amp > maxChunkAmplitude) {
                    maxChunkAmplitude = amp
                }
                AudioState.currentAmplitude.value = amp.toFloat()
                delay(pollIntervalMs)
            }

            stopAndSendChunk(maxChunkAmplitude)

        } catch (e: Exception) {
            Log.e("SensorStreamService", "MediaRecorder failed", e)
            delay(1000) // prevent tight crash loop
        }
    }

    private fun stopAndSendChunk(maxAmplitude: Int) {
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            AudioState.currentAmplitude.value = 0f
            
            val file = File(outputFile)
            if (file.exists() && file.length() > 0) {
                if (maxAmplitude > VAD_AMPLITUDE_THRESHOLD) {
                    Log.d("SensorStreamService", "VAD PASSED. Max amplitude: $maxAmplitude.")
                    val bytes = file.readBytes()
                    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    
                    // Run voice verification in a coroutine before sending
                    serviceScope.launch {
                        val isOwnerVoice = VoicePrintManager.verifyVoice(base64, USER_ID, SERVER_URL)
                        if (isOwnerVoice) {
                            Log.d("SensorStreamService", "Voice verified. Sending chunk.")
                            sendToBackend(base64)
                        } else {
                            Log.d("SensorStreamService", "Voice mismatch. Discarding (not the owner's voice).")
                        }
                    }
                } else {
                    Log.d("SensorStreamService", "VAD FAILED. Silence detected. Discarding chunk.")
                }
                file.delete()
            }
        } catch (e: Exception) {
            Log.e("SensorStreamService", "Failed to stop/send chunk", e)
        }
    }

    private fun sendToBackend(base64Audio: String) {
        try {
            val url = URL("$SERVER_URL/companion/audio-chunk")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer companion-token")
            conn.doOutput = true
            
            val json = JSONObject().apply {
                put("audioBase64", base64Audio)
                put("userId", 1)
            }
            
            DataOutputStream(conn.outputStream).use { it.writeBytes(json.toString()) }
            
            val responseCode = conn.responseCode
            Log.d("SensorStreamService", "Sent chunk, response code: $responseCode")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("SensorStreamService", "Failed to upload audio", e)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        isRecording = false
        AudioState.isListening.value = false
        AudioState.currentAmplitude.value = 0f
        recordingJob?.cancel()
        try {
            mediaRecorder?.release()
        } catch (e: Exception) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Aris Companion Service",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
