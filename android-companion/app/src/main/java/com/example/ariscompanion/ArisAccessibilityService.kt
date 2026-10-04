package com.example.ariscompanion

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.Locale

object AccessibilityState {
    var activeService: ArisAccessibilityService? = null
    val currentPackage = MutableStateFlow<String>("")
}

class ArisAccessibilityService : AccessibilityService(), TextToSpeech.OnInitListener {

    private var tts: TextToSpeech? = null
    private var windowManager: WindowManager? = null
    private var overlayView: TextView? = null
    private var floatingArisEnabled = false
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d("ArisAccessibility", "Service Connected!")
        AccessibilityState.activeService = this
        floatingArisEnabled = getSharedPreferences("aris_chat_prefs", MODE_PRIVATE)
            .getBoolean("floating_aris_enabled", false)
        
        tts = TextToSpeech(this, this)
        setupOverlay()
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.US
        }
    }

    private fun setupOverlay() {
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        
        overlayView = TextView(this).apply {
            text = "Aris Autonomy Active"
            setTextColor(Color.parseColor("#00FF88")) // Neon Green
            textSize = 14f
            setBackgroundColor(Color.parseColor("#CC07070B")) // Semi-transparent dark
            setPadding(32, 16, 32, 16)
            gravity = Gravity.CENTER
            alpha = if (floatingArisEnabled) 1f else 0f
            text = if (floatingArisEnabled) "Aris is ready" else "Aris Autonomy Active"
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = 100 // Offset from top
        }

        try {
            windowManager?.addView(overlayView, params)
        } catch (e: Exception) {
            Log.e("ArisAccessibility", "Failed to add overlay", e)
        }
    }

    /**
     * Shows a text overlay on the screen and speaks the message out loud.
     */
    fun provideFeedback(message: String) {
        Log.d("ArisAccessibility", "Feedback: $message")
        
        // Speak
        tts?.speak(message, TextToSpeech.QUEUE_FLUSH, null, "FeedbackId")
        
        // Show Overlay
        mainHandler.post {
            overlayView?.text = "Aris: $message"
            if (floatingArisEnabled) overlayView?.animate()?.alpha(1f)?.setDuration(300)?.start()
            
            // Auto-hide after 3 seconds
            mainHandler.removeCallbacksAndMessages(null)
            if (floatingArisEnabled) {
                mainHandler.postDelayed({
                    overlayView?.animate()?.alpha(0f)?.setDuration(500)?.start()
                }, 3000)
            }
        }
    }

    fun setFloatingArisEnabled(enabled: Boolean) {
        floatingArisEnabled = enabled
        mainHandler.post {
            overlayView?.text = if (enabled) "Aris is ready" else "Aris Autonomy Active"
            overlayView?.animate()?.alpha(if (enabled) 1f else 0f)?.setDuration(200)?.start()
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.let {
                AccessibilityState.currentPackage.value = it.toString()
            }
        }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        super.onDestroy()
        AccessibilityState.activeService = null
        tts?.stop()
        tts?.shutdown()
        if (overlayView != null) {
            windowManager?.removeView(overlayView)
        }
    }

    fun getActiveViewHierarchy(): List<AccessibilityNodeInfo> {
        val rootNode = rootInActiveWindow ?: return emptyList()
        val interactableNodes = mutableListOf<AccessibilityNodeInfo>()
        traverseNode(rootNode, interactableNodes)
        return interactableNodes
    }

    private fun traverseNode(node: AccessibilityNodeInfo, list: MutableList<AccessibilityNodeInfo>) {
        if (node.isClickable || node.isScrollable || node.isEditable || !node.text.isNullOrBlank() || !node.contentDescription.isNullOrBlank()) {
            list.add(node)
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { traverseNode(it, list) }
        }
    }

    fun clickNode(node: AccessibilityNodeInfo): Boolean {
        if (node.isClickable) return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        var parent = node.parent
        while (parent != null) {
            if (parent.isClickable) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            parent = parent.parent
        }
        return false
    }

    fun scroll(direction: Int): Boolean = performGlobalAction(direction)

    fun typeText(node: AccessibilityNodeInfo, text: String): Boolean {
        if (!node.isEditable) return false
        val arguments = android.os.Bundle()
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    fun goHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
    fun goBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)

    fun wakeUpScreen() {
        try {
            val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
            val wakeLock = pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "Aris:AutonomyWakeLock"
            )
            wakeLock.acquire(3000)
        } catch (e: Exception) {}
    }

    fun unlockScreen() {
        try {
            val km = getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager
            Log.d("ArisAccessibility", "Attempting keyguard dismiss via UI interaction if needed.")
        } catch (e: Exception) {}
    }
}
