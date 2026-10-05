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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation3.runtime.NavKey
import com.example.ariscompanion.AudioState
import com.example.ariscompanion.SensorStreamService
import com.example.ariscompanion.ScreenCaptureService
import com.example.ariscompanion.VisionState
import com.example.ariscompanion.ConnectivityState
import com.example.ariscompanion.NotificationState
import com.example.ariscompanion.AccessibilityState
import com.example.ariscompanion.ui.chat.ChatSession
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
    val lifecycleOwner = LocalLifecycleOwner.current
    var settingsRefresh by remember { mutableIntStateOf(0) }
    var showSystemSettings by remember { mutableStateOf(false) }
    var showLogoutConfirmation by remember { mutableStateOf(false) }
    val notificationAccessEnabled = remember(settingsRefresh) {
        NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
    }
    val floatingArisEnabled = remember(settingsRefresh) {
        context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
            .getBoolean("floating_aris_enabled", false) && AccessibilityState.activeService != null
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) settingsRefresh += 1
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
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
            Box(modifier = Modifier.fillMaxWidth()) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
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
                IconButton(
                    onClick = { showSystemSettings = true },
                    modifier = Modifier.align(Alignment.TopEnd).padding(end = 8.dp).size(40.dp),
                ) {
                    Text("⚙", color = Color.White.copy(alpha = 0.9f), fontSize = 24.sp)
                }
            }
        }
            
        ArisCharacter(
            isListening = isListening,
            isVisionActive = isVisionActive,
            amplitude = amplitude,
            pulseScale = pulseScale,
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

    if (showSystemSettings) {
        AlertDialog(
            onDismissRequest = { showSystemSettings = false },
            title = { Text("System settings") },
            text = {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 440.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "Choose which device capabilities Aris can use.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    SettingsSwitchRow(
                        title = "Enable audio",
                        description = "Allow Aris to listen through the microphone.",
                        checked = isListening,
                        onCheckedChange = { enabled ->
                            if (!enabled) {
                                context.stopService(Intent(context, SensorStreamService::class.java))
                            } else if (
                                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                            ) {
                                startAudioService(context)
                            } else {
                                requestAudioPermission.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        },
                    )
                    SettingsSwitchRow(
                        title = "Enable video",
                        description = "Share the screen with Aris while enabled.",
                        checked = isVisionActive,
                        onCheckedChange = { enabled ->
                            if (enabled) {
                                screenCaptureLauncher.launch(projectionManager.createScreenCaptureIntent())
                            } else {
                                context.stopService(Intent(context, ScreenCaptureService::class.java))
                            }
                        },
                    )
                    SettingsSwitchRow(
                        title = "Connect notifications",
                        description = if (notificationAccessEnabled) {
                            "Notification access is connected. Tap to manage it."
                        } else {
                            "Allow Aris to read notifications in Android settings."
                        },
                        checked = notificationAccessEnabled,
                        onCheckedChange = {
                            context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                        },
                    )
                    SettingsSwitchRow(
                        title = "Enable floating Aris",
                        description = if (floatingArisEnabled) {
                            "Floating Aris is active. Turn off to hide it."
                        } else {
                            "Requires Aris accessibility access in Android settings."
                        },
                        checked = floatingArisEnabled,
                        onCheckedChange = { enabled ->
                            context.getSharedPreferences("aris_chat_prefs", Context.MODE_PRIVATE)
                                .edit().putBoolean("floating_aris_enabled", enabled).apply()
                            if (enabled) {
                                context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                            } else {
                                AccessibilityState.activeService?.setFloatingArisEnabled(false)
                            }
                            settingsRefresh += 1
                        },
                    )
                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
                    TextButton(
                        onClick = {
                            showSystemSettings = false
                            showLogoutConfirmation = true
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) {
                        Text("Log out")
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showSystemSettings = false }) { Text("Done") }
            },
        )
    }

    if (showLogoutConfirmation) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirmation = false },
            title = { Text("Log out of Aris?") },
            text = { Text("Your saved chat on this device will be cleared. You can sign in again at any time.") },
            dismissButton = {
                TextButton(onClick = { showLogoutConfirmation = false }) { Text("Cancel") }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        ChatSession.logout(context)
                        showLogoutConfirmation = false
                        onItemClick(com.example.ariscompanion.Chat)
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Text("Log out")
                }
            },
        )
    }
}

private fun startAudioService(context: Context) {
    val serviceIntent = Intent(context, SensorStreamService::class.java)
    ContextCompat.startForegroundService(context, serviceIntent)
}

@Composable
private fun SettingsSwitchRow(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun ArisCharacter(
    isListening: Boolean,
    isVisionActive: Boolean,
    amplitude: Float,
    pulseScale: Float,
    isOnline: Boolean,
    notificationCount: Int,
    modifier: Modifier = Modifier,
) {
    val pulse = pulseScale * (if (isListening) 1f + (amplitude / 32767f).coerceIn(0f, 1f) * 0.16f else 1f)
    val characterColor = when {
        !isOnline -> Color(0xFFFFB86B)
        isListening -> Color(0xFF00F0FF)
        isVisionActive -> Color(0xFF00FF88)
        notificationCount > 0 -> Color(0xFFFF668E)
        else -> Color(0xFF8A2BE2)
    }

    Box(
        modifier = modifier.size(240.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val radius = size.minDimension * 0.32f
            drawCircle(
                color = characterColor.copy(alpha = 0.10f),
                radius = radius * 1.65f * pulse,
            )
            drawCircle(
                color = characterColor.copy(alpha = 0.20f),
                radius = radius * 1.3f * pulse,
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(characterColor.copy(alpha = 0.95f), characterColor.copy(alpha = 0.3f), Color.Transparent),
                    center = center,
                    radius = radius * 1.2f * pulse,
                ),
                radius = radius * 1.2f * pulse,
            )
            drawCircle(
                color = Color.White.copy(alpha = 0.75f),
                radius = radius * 0.23f,
                center = Offset(center.x - radius * 0.27f, center.y - radius * 0.08f),
            )
            drawCircle(
                color = Color.White.copy(alpha = 0.75f),
                radius = radius * 0.23f,
                center = Offset(center.x + radius * 0.27f, center.y - radius * 0.08f),
            )
        }
    }
}
