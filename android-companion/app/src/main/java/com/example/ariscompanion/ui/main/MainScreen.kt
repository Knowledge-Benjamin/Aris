package com.example.ariscompanion.ui.main

import android.app.Activity
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.*
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.navigation3.runtime.NavKey
import com.example.ariscompanion.AudioState
import com.example.ariscompanion.SensorStreamService
import com.example.ariscompanion.ScreenCaptureService
import com.example.ariscompanion.VisionState
import com.example.ariscompanion.ConnectivityState
import com.example.ariscompanion.NotificationState
import androidx.core.app.NotificationManagerCompat

@Composable
fun MainScreen(
    onItemClick: (NavKey) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val isListening by AudioState.isListening.collectAsState()
    val amplitude by AudioState.currentAmplitude.collectAsState()
    val isVisionActive by VisionState.isCapturing.collectAsState()
    val isOnline by ConnectivityState.isOnline.collectAsState()
    val notificationCount by NotificationState.notificationCount.collectAsState()
    val notificationAccessEnabled = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    val floatingArisEnabled = context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
        .getBoolean("floating_aris_enabled", false)
    val requestAudioPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startAudioService(context)
    }

    // Screen Capture Launcher
    val projectionManager = remember {
        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    }
    
    val screenCaptureLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val intent = Intent(context, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
            }
            ContextCompat.startForegroundService(context, intent)
        }
    }

    // Smooth amplitude for visual fidelity
    val animatedAmplitude by animateFloatAsState(
        targetValue = if (isListening) (amplitude / 32767f).coerceIn(0f, 1f) else 0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
        label = "amplitude"
    )

    // Base pulsing animation
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.95f,
        targetValue = 1.05f,
        animationSpec = infiniteRepeatable(
            animation = tween(1500, easing = LinearOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulseScale"
    )

    val bgColor = Color(0xFF07070B)
    val accentNeon = Color(0xFF00F0FF)
    val accentPurple = Color(0xFF8A2BE2)
    val accentGreen = Color(0xFF00FF88)

    Box(modifier = modifier.fillMaxSize().background(bgColor)) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(
                brush = Brush.linearGradient(
                    listOf(Color(0xFF090A18), Color(0xFF15102B), Color(0xFF061B29)),
                    start = Offset(0f, 0f),
                    end = Offset(size.width, size.height),
                )
            )
            drawCircle(Color(0xFF4E2B9B).copy(alpha = 0.18f), size.minDimension * 0.42f, Offset(size.width * 0.18f, size.height * 0.22f))
            drawCircle(Color(0xFF00D8E8).copy(alpha = 0.11f), size.minDimension * 0.34f, Offset(size.width * 0.86f, size.height * 0.66f))
            drawLine(Color.White.copy(alpha = 0.035f), Offset(0f, size.height * 0.7f), Offset(size.width, size.height * 0.45f), 1f, StrokeCap.Round)
        }
        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 4.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.White.copy(alpha = 0.055f), RoundedCornerShape(28.dp))
                .border(1.dp, Color.White.copy(alpha = 0.09f), RoundedCornerShape(28.dp))
                .padding(top = 20.dp, bottom = 18.dp)
        ) {
            Text(
                text = "ARIS",
                color = Color.White,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 8.sp
            )
            Text(
                text = "YOUR DIGITAL COMPANION",
                color = accentNeon.copy(alpha = 0.7f),
                fontSize = 12.sp,
                letterSpacing = 4.sp,
                modifier = Modifier.padding(top = 8.dp)
            )
        }
            
        ArisCharacter(
            isListening = isListening,
            isVisionActive = isVisionActive,
            amplitude = amplitude,
            isOnline = isOnline,
            notificationCount = notificationCount,
            modifier = Modifier.padding(4.dp),
        )

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xCC0B0D1A), RoundedCornerShape(30.dp))
                .border(1.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(30.dp))
                .padding(horizontal = 18.dp, vertical = 18.dp)
        ) {
            Text(
                text = when {
                    !isOnline -> "OFFLINE MODE"
                    isVisionActive -> "VISION ENABLED"
                    isListening -> "ANALYZING AUDIO"
                    notificationCount > 0 -> "$notificationCount NOTIFICATION${if (notificationCount == 1) "" else "S"} WAITING"
                    else -> "SYSTEM DORMANT"
                },
                color = when {
                    !isOnline -> Color(0xFFFFB86B)
                    isVisionActive -> accentGreen
                    isListening -> accentNeon
                    notificationCount > 0 -> Color(0xFFFF668E)
                    else -> Color.Gray
                },
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                modifier = Modifier.padding(bottom = 24.dp)
            )

            // Audio Toggle
            Button(
                onClick = {
                    if (isListening) {
                        context.stopService(Intent(context, SensorStreamService::class.java))
                    } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        startAudioService(context)
                    } else {
                        requestAudioPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isListening) Color(0xFF1E1E2A) else accentPurple,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                Text(if (isListening) "DISABLE AUDIO" else "ENABLE AUDIO", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
            }
            
            Spacer(modifier = Modifier.height(16.dp))

            // Vision Toggle
            Button(
                onClick = {
                    if (isVisionActive) {
                        context.stopService(Intent(context, ScreenCaptureService::class.java))
                    } else {
                        screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
                    }
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isVisionActive) Color(0xFF1E1E2A) else accentGreen.copy(alpha = 0.7f),
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                Text(if (isVisionActive) "DISABLE VISION" else "ENABLE VISION", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
            }

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = if (notificationAccessEnabled) "NOTIFICATIONS CONNECTED" else "CONNECT NOTIFICATIONS",
                color = if (notificationAccessEnabled) accentGreen.copy(alpha = 0.85f) else Color(0xFFFFB86B),
                fontSize = 11.sp,
                letterSpacing = 1.sp,
                modifier = Modifier.clickable {
                    if (!notificationAccessEnabled) {
                        context.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
                    } else {
                        NotificationState.clearAttention()
                    }
                }.padding(10.dp),
            )

            Text(
                text = if (floatingArisEnabled) "DISABLE FLOATING ARIS" else "ENABLE FLOATING ARIS",
                color = if (floatingArisEnabled) accentNeon else Color(0xFFFFB86B),
                fontSize = 11.sp,
                letterSpacing = 1.sp,
                modifier = Modifier.clickable {
                    if (floatingArisEnabled) {
                        context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
                            .edit().putBoolean("floating_aris_enabled", false).apply()
                        com.example.ariscompanion.AccessibilityState.activeService?.setFloatingArisEnabled(false)
                    } else {
                        context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
                            .edit().putBoolean("floating_aris_enabled", true).apply()
                        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    }
                }.padding(10.dp),
            )

            // Chat — navigate to the dedicated Aris chat screen
            Button(
                onClick = { onItemClick(com.example.ariscompanion.Chat) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF00304A),
                    contentColor = Color(0xFF00F0FF)
                ),
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                Text("CHAT WITH ARIS", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
            }
        }
        }
    }
}

private fun startAudioService(context: Context) {
    val preferences = context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
    val serverUrl = preferences.getString("server_url", null)
    val authToken = preferences.getString("auth_token", null)
    val serviceIntent = Intent(context, SensorStreamService::class.java).apply {
        if (!serverUrl.isNullOrBlank()) putExtra(SensorStreamService.EXTRA_SERVER_URL, serverUrl)
        if (!authToken.isNullOrBlank()) putExtra(SensorStreamService.EXTRA_AUTH_TOKEN, authToken)
    }
    ContextCompat.startForegroundService(context, serviceIntent)
}
