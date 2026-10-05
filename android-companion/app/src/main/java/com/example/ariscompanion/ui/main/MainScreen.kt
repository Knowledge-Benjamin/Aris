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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
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
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

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

    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val cycle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(7000, easing = LinearEasing)),
        label = "avatarCycle",
    )
    val typingProgress by infiniteTransition.animateInt(
        initialValue = 0,
        targetValue = 4,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 4600
                0 at 0
                4 at 1400
                4 at 3200
                0 at 4600
            },
            repeatMode = RepeatMode.Restart,
        ),
        label = "terminalTyping",
    )
    val cursorAlpha by infiniteTransition.animateFloat(
        initialValue = 0.2f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(520), RepeatMode.Reverse),
        label = "terminalCursor",
    )
    val pulseScale by infiniteTransition.animateFloat(
        initialValue = 0.97f,
        targetValue = 1.03f,
        animationSpec = infiniteRepeatable(tween(1900, easing = LinearOutSlowInEasing), RepeatMode.Reverse),
        label = "pulseScale",
    )

    val bgColor = Color(0xFF07070B)
    val accentNeon = Color(0xFF00F0FF)
    val accentGreen = Color(0xFF73F7C2)

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
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text(
                    text = "A R I S   /   D I G I T A L   C O R E",
                    color = Color(0xFF91A7BD).copy(alpha = 0.62f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp,
                    letterSpacing = 1.1.sp,
                    modifier = Modifier.align(Alignment.CenterStart),
                )
                IconButton(
                    onClick = { showSystemSettings = true },
                    modifier = Modifier.align(Alignment.CenterEnd).size(44.dp),
                ) {
                    Text("⚙", color = Color.White.copy(alpha = 0.9f), fontSize = 24.sp)
                }
            }

            Column(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                ArisCharacter(
                    isListening = isListening,
                    isVisionActive = isVisionActive,
                    amplitude = amplitude,
                    pulseScale = pulseScale,
                    isOnline = isOnline,
                    notificationCount = notificationCount,
                    cycle = cycle,
                    modifier = Modifier.size(300.dp),
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "ARIS".take(typingProgress),
                        color = Color(0xFFE5FBFF),
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Black,
                        fontSize = 36.sp,
                        letterSpacing = 12.sp,
                    )
                    Box(
                        Modifier
                            .padding(start = 3.dp, top = 8.dp)
                            .width(3.dp)
                            .height(25.dp)
                            .background(accentNeon.copy(alpha = cursorAlpha), RoundedCornerShape(2.dp)),
                    )
                }
                Text(
                    text = when {
                        !isOnline -> "LINK OFFLINE  //  RECONNECTING"
                        isListening -> "AUDIO INPUT  //  ACTIVE"
                        isVisionActive -> "VISION LINK  //  ACTIVE"
                        notificationCount > 0 -> "SIGNAL QUEUED  //  $notificationCount"
                        else -> "NEURAL COMPANION  //  ONLINE"
                    },
                    color = when {
                        !isOnline -> Color(0xFFFFB86B)
                        isListening -> accentNeon
                        isVisionActive -> accentGreen
                        else -> Color(0xFF8296AA)
                    }.copy(alpha = 0.86f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    letterSpacing = 1.4.sp,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }

            Button(
                onClick = { onItemClick(com.example.ariscompanion.Chat) },
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF00304A),
                    contentColor = Color(0xFF00F0FF)
                ),
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.fillMaxWidth().height(58.dp).padding(bottom = 6.dp)
            ) {
                Text("CHAT WITH ARIS", fontWeight = FontWeight.SemiBold, letterSpacing = 2.sp)
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
