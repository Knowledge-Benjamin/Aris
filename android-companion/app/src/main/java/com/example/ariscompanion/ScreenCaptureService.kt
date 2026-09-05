package com.example.ariscompanion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.flow.MutableStateFlow

object VisionState {
    var isCapturing = MutableStateFlow(false)
    var captureService: ScreenCaptureService? = null
}

class ScreenCaptureService : Service() {
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private lateinit var projectionManager: MediaProjectionManager

    companion object {
        const val CHANNEL_ID = "ArisVisionChannel"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
    }

    override fun onCreate() {
        super.onCreate()
        projectionManager = getSystemService(MediaProjectionManager::class.java)
        createNotificationChannel()
        
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Aris Vision")
            .setContentText("Ambient screen capture active")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .build()
            
        startForeground(2, notification)
        VisionState.captureService = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)

        if (resultCode != 0 && resultData != null && mediaProjection == null) {
            startProjection(resultCode, resultData)
        }
        return START_NOT_STICKY
    }

    private fun startProjection(resultCode: Int, resultData: Intent) {
        mediaProjection = projectionManager.getMediaProjection(resultCode, resultData)
        
        val windowManager = getSystemService(WindowManager::class.java)
        val metrics = DisplayMetrics()
        windowManager.defaultDisplay.getRealMetrics(metrics)
        
        // Scale down for LLM to save tokens and bandwidth (e.g. 720p class)
        val density = metrics.densityDpi
        val width = metrics.widthPixels / 2
        val height = metrics.heightPixels / 2

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "ArisVision",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface, null, null
        )
        
        VisionState.isCapturing.value = true
        Log.d("ScreenCapture", "MediaProjection started.")
    }

    /**
     * Grabs the latest frame on-demand, compresses it to JPEG, and returns Base64.
     */
    fun captureCurrentFrameBase64(): String? {
        val image = imageReader?.acquireLatestImage() ?: return null
        
        return try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val rowPadding = rowStride - pixelStride * image.width

            val bitmap = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride, 
                image.height, 
                Bitmap.Config.ARGB_8888
            )
            bitmap.copyPixelsFromBuffer(buffer)
            
            // Crop the row padding
            val croppedBitmap = Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
            
            val outputStream = ByteArrayOutputStream()
            croppedBitmap.compress(Bitmap.CompressFormat.JPEG, 60, outputStream) // 60% quality is fine for LLM vision
            val bytes = outputStream.toByteArray()
            
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e("ScreenCapture", "Failed to extract image", e)
            null
        } finally {
            image.close()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        VisionState.isCapturing.value = false
        VisionState.captureService = null
        virtualDisplay?.release()
        imageReader?.close()
        mediaProjection?.stop()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Aris Vision Service", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
