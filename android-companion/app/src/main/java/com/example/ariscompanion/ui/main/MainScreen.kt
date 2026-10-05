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
import kotlin.math.ln
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
    val typingProgress by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 4f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 4600
                0f at 0
                4f at 1400
                4f at 3200
                0f at 4600
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
                if (isListening) {
                    val listeningPulse = (0.76f + 0.24f * sin(cycle * 2f * PI * 2f).toFloat())
                    Text(
                        text = "LISTENING",
                        color = accentNeon.copy(alpha = listeningPulse),
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        fontSize = 23.sp,
                        letterSpacing = 4.sp,
                    )
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "ARIS".take(typingProgress.toInt().coerceIn(0, 4)),
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
    cycle: Float,
    modifier: Modifier = Modifier,
) {
    val measuredEnergy = if (isListening) {
        (ln(amplitude.coerceAtLeast(0f) + 1f) / ln(12001f)).coerceIn(0f, 1f)
    } else {
        0f
    }
    val audioEnergy by animateFloatAsState(
        targetValue = measuredEnergy,
        animationSpec = tween(durationMillis = 110, easing = LinearEasing),
        label = "microphoneEnergy",
    )
    val characterColor = when {
        !isOnline -> Color(0xFFFFB86B)
        isListening -> Color(0xFF00F0FF)
        isVisionActive -> Color(0xFF73F7C2)
        notificationCount > 0 -> Color(0xFFFF668E)
        else -> Color(0xFF62DBF5)
    }

    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val radius = size.minDimension * 0.29f
            val beat = (0.5f + 0.5f * sin(cycle * 2f * PI * 2f)).toFloat()
            val listeningGlow = if (isListening) 0.45f + beat * 0.35f + audioEnergy * 0.45f else 0f
            val breathing = 1f + (pulseScale - 1f) * 1.5f + audioEnergy * 0.12f + if (isListening) beat * 0.025f else 0f
            drawCircle(
                brush = Brush.radialGradient(
                    listOf(characterColor.copy(alpha = 0.18f + listeningGlow * 0.18f), Color.Transparent),
                    center,
                    radius * 2.15f,
                ),
                radius = radius * 2.15f,
            )
            drawCircle(
                color = characterColor.copy(alpha = 0.12f + audioEnergy * 0.16f + if (isListening) beat * 0.08f else 0f),
                radius = radius * 1.26f * breathing,
            )

            rotate(degrees = cycle * 360f, pivot = center) {
                drawCircle(
                    color = characterColor.copy(alpha = if (isListening) 0.46f + listeningGlow * 0.32f else 0.34f),
                    radius = radius * 1.52f,
                    style = Stroke(width = 1.2.dp.toPx(), pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 8.dp.toPx()))),
                )
                drawArc(
                    color = characterColor.copy(alpha = if (isListening) 0.72f + listeningGlow * 0.28f else 0.85f),
                    startAngle = -112f,
                    sweepAngle = 72f,
                    useCenter = false,
                    topLeft = Offset(center.x - radius * 1.52f, center.y - radius * 1.52f),
                    size = Size(radius * 3.04f, radius * 3.04f),
                    style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round),
                )
                drawArc(
                    color = Color(0xFFB887FF).copy(alpha = 0.7f),
                    startAngle = 62f,
                    sweepAngle = 42f,
                    useCenter = false,
                    topLeft = Offset(center.x - radius * 1.38f, center.y - radius * 1.38f),
                    size = Size(radius * 2.76f, radius * 2.76f),
                    style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round),
                )
                for (index in 0 until 8) {
                    val angle = (cycle * 2f * PI + index * PI / 4f).toFloat()
                    val orbitRadius = radius * 1.52f
                    val dotCenter = Offset(
                        center.x + cos(angle) * orbitRadius,
                        center.y + sin(angle) * orbitRadius,
                    )
                    drawCircle(characterColor.copy(alpha = if (index % 2 == 0) 0.9f else 0.35f), if (index % 2 == 0) 2.7.dp.toPx() else 1.6.dp.toPx(), dotCenter)
                }
            }

            drawCircle(
                color = Color.White.copy(alpha = 0.08f),
                radius = radius * 1.18f,
                style = Stroke(width = 1.dp.toPx()),
            )

            val face = Path().apply {
                moveTo(center.x, center.y - radius * 1.03f)
                lineTo(center.x + radius * 0.72f, center.y - radius * 0.62f)
                lineTo(center.x + radius * 0.61f, center.y + radius * 0.39f)
                lineTo(center.x, center.y + radius * 0.96f)
                lineTo(center.x - radius * 0.61f, center.y + radius * 0.39f)
                lineTo(center.x - radius * 0.72f, center.y - radius * 0.62f)
                close()
            }
            drawPath(face, characterColor.copy(alpha = 0.07f * breathing))
            drawPath(face, characterColor.copy(alpha = 0.75f), style = Stroke(width = 2.2.dp.toPx()))

            val innerMark = Path().apply {
                moveTo(center.x - radius * 0.34f, center.y + radius * 0.48f)
                lineTo(center.x, center.y - radius * 0.53f)
                lineTo(center.x + radius * 0.34f, center.y + radius * 0.48f)
            }
            drawPath(
                innerMark,
                Color.White.copy(alpha = 0.5f),
                style = Stroke(width = 1.2.dp.toPx(), cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
            )

            for (side in -1..1 step 2) {
                val eye = Path().apply {
                    moveTo(center.x + side * radius * 0.48f, center.y - radius * 0.05f)
                    lineTo(center.x + side * radius * 0.13f, center.y + radius * 0.04f)
                }
                drawPath(eye, characterColor.copy(alpha = 0.95f), style = Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round))
                drawCircle(characterColor.copy(alpha = 0.95f), 2.dp.toPx(), Offset(center.x + side * radius * 0.13f, center.y + radius * 0.04f))
            }

            if (isListening) {
                for (index in 0 until 4) {
                    val phase = (cycle * 3.2f + index * 0.25f) % 1f
                    val startAngle = cycle * 2f * PI + index * PI / 2f - PI / 2f
                    val start = Offset(
                        center.x + cos(startAngle).toFloat() * radius * 1.2f,
                        center.y + sin(startAngle).toFloat() * radius * 1.2f,
                    )
                    val targetX = center.x + (index - 1.5f) * radius * 0.34f
                    val end = Offset(targetX, center.y)
                    val control = Offset((start.x + end.x) / 2f, (start.y + end.y) / 2f - radius * 0.3f)
                    val inverse = 1f - phase
                    val spark = Offset(
                        inverse * inverse * start.x + 2f * inverse * phase * control.x + phase * phase * end.x,
                        inverse * inverse * start.y + 2f * inverse * phase * control.y + phase * phase * end.y,
                    )
                    val trailPhase = (phase - 0.09f).coerceAtLeast(0f)
                    val trailInverse = 1f - trailPhase
                    val trail = Offset(
                        trailInverse * trailInverse * start.x + 2f * trailInverse * trailPhase * control.x + trailPhase * trailPhase * end.x,
                        trailInverse * trailInverse * start.y + 2f * trailInverse * trailPhase * control.y + trailPhase * trailPhase * end.y,
                    )
                    drawLine(
                        characterColor.copy(alpha = 0.22f + audioEnergy * 0.28f),
                        trail,
                        spark,
                        strokeWidth = 2.dp.toPx(),
                        cap = StrokeCap.Round,
                    )
                    drawCircle(
                        characterColor.copy(alpha = 0.22f),
                        radius = (5f + audioEnergy * 4f).dp.toPx(),
                        center = spark,
                    )
                    drawCircle(
                        Color.White.copy(alpha = 0.75f + audioEnergy * 0.25f),
                        radius = 1.8.dp.toPx(),
                        center = spark,
                    )
                }
            }

            val waveform = Path()
            val points = 33
            for (index in 0 until points) {
                val x = center.x - radius * 1.28f + (radius * 2.56f * index / (points - 1))
                val envelope = (1f - kotlin.math.abs(index - (points - 1) / 2f) / ((points - 1) / 2f)).coerceAtLeast(0.12f)
                val oscillation = sin(index * 1.67f + cycle * 2f * PI).toFloat()
                val secondary = cos(index * 0.73f - cycle * 4f * PI).toFloat() * 0.28f
                val idleHeight = 0.13f
                val activeHeight = 0.16f + audioEnergy * 0.72f
                val height = (radius * 0.045f + radius * (if (isListening) activeHeight else idleHeight) * envelope * kotlin.math.abs(oscillation + secondary)).coerceAtMost(radius * 0.47f)
                val y = center.y + if (index % 2 == 0) -height else height
                if (index == 0) waveform.moveTo(x, y) else waveform.lineTo(x, y)
            }
            drawPath(
                waveform,
                characterColor.copy(alpha = if (isListening) 0.22f + audioEnergy * 0.4f else 0.22f),
                style = Stroke(width = (if (isListening) 7f + audioEnergy * 5f else 7f).dp.toPx(), cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
            )
            drawPath(
                waveform,
                Color(0xFFE4FFFF).copy(alpha = if (isListening) 0.82f + audioEnergy * 0.18f else 1f),
                style = Stroke(width = 1.7.dp.toPx(), cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
            )

            val scanY = center.y - radius + (cycle * radius * 2f)
            drawLine(
                characterColor.copy(alpha = 0.22f),
                Offset(center.x - radius * 0.57f, scanY),
                Offset(center.x + radius * 0.57f, scanY),
                strokeWidth = 1.dp.toPx(),
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(characterColor.copy(alpha = 0.12f * breathing), Color.Transparent),
                    center = center,
                    radius = radius * 0.9f,
                ),
                radius = radius * 0.9f,
            )
            drawCircle(
                color = Color.White.copy(alpha = 0.8f),
                radius = 2.dp.toPx(),
                center = Offset(center.x, center.y - radius * 1.03f),
            )
        }
    }
}
