package com.example.ariscompanion.ui.main

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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

@Composable
fun MainScreen(
    onItemClick: (NavKey) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val isListening by AudioState.isListening.collectAsState()
    val amplitude by AudioState.currentAmplitude.collectAsState()
    val isVisionActive by VisionState.isCapturing.collectAsState()

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
            animation = tween(1500, easing = SineEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulseScale"
    )

    val bgColor = Color(0xFF07070B)
    val accentNeon = Color(0xFF00F0FF)
    val accentPurple = Color(0xFF8A2BE2)
    val accentGreen = Color(0xFF00FF88)

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(bgColor),
        verticalArrangement = Arrangement.SpaceBetween,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(top = 64.dp)
        ) {
            Text(
                text = "ARIS",
                color = Color.White,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 8.sp
            )
            Text(
                text = "AMBIENT SENSOR",
                color = accentNeon.copy(alpha = 0.7f),
                fontSize = 12.sp,
                letterSpacing = 4.sp,
                modifier = Modifier.padding(top = 8.dp)
            )
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(300.dp)
                .padding(32.dp)
        ) {
            if (isListening || isVisionActive) {
                val currentAccent = if (isVisionActive) accentGreen else accentNeon
                Canvas(
                    modifier = Modifier
                        .fillMaxSize()
                        .scale(pulseScale + (animatedAmplitude * 1.5f))
                        .alpha(0.3f + (animatedAmplitude * 0.5f))
                        .blur(24.dp)
                ) {
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(currentAccent, accentPurple, Color.Transparent),
                            center = Offset(size.width / 2, size.height / 2),
                            radius = size.width / 2
                        )
                    )
                }
                
                Canvas(
                    modifier = Modifier
                        .size(120.dp)
                        .scale(pulseScale + (animatedAmplitude * 0.3f))
                ) {
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(Color.White, currentAccent, accentPurple),
                            center = Offset(size.width / 2, size.height / 2),
                            radius = size.width / 2
                        )
                    )
                }
            } else {
                Canvas(modifier = Modifier.size(80.dp).alpha(0.3f)) {
                    drawCircle(color = Color.DarkGray)
                }
            }
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(bottom = 64.dp)
        ) {
            Text(
                text = if (isVisionActive) "VISION ENABLED" else if (isListening) "ANALYZING AUDIO" else "SYSTEM DORMANT",
                color = if (isVisionActive) accentGreen else if (isListening) accentNeon else Color.Gray,
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                modifier = Modifier.padding(bottom = 24.dp)
            )

            // Audio Toggle
            Button(
                onClick = {
                    val serviceIntent = Intent(context, SensorStreamService::class.java)
                    if (isListening) context.stopService(serviceIntent)
                    else ContextCompat.startForegroundService(context, serviceIntent)
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isListening) Color(0xFF1E1E2A) else accentPurple,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.height(56.dp).width(240.dp)
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
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.height(56.dp).width(240.dp)
            ) {
                Text(if (isVisionActive) "DISABLE VISION" else "ENABLE VISION", fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
            }
        }
    }
}
