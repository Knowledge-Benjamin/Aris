package com.example.ariscompanion.ui.chat

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.ariscompanion.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun ChatScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val viewModel: ChatViewModel = viewModel(
        factory = ChatViewModelFactory(context.applicationContext)
    )
    val state by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var serverUrl by remember(state.serverUrl) { mutableStateOf(state.serverUrl.ifBlank { ServerConfig.DEFAULT_BASE_URL }) }
    var email by remember(state.email) { mutableStateOf(state.email) }
    var password by remember { mutableStateOf("") }
    var pickerError by remember { mutableStateOf<String?>(null) }

    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            scope.launch {
                try {
                    val attachment = readAttachment(context, uri)
                    viewModel.onEvent(ChatUiEvent.StageAttachment(attachment))
                    pickerError = null
                } catch (error: Exception) {
                    pickerError = error.message ?: "Could not read this attachment."
                }
            }
        }
    }
    val audioPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) viewModel.onEvent(ChatUiEvent.StartRecording)
        else pickerError = "Microphone permission is required to record a voice note."
    }

    LaunchedEffect(state.messages.size, state.progressMessage) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    val chatBackground = Color(0xFF07131B)
    val arisBubble = Color(0xFF172832)
    val userBubble = Color(0xFF075E54)
    val accent = Color(0xFF65E6D0)
    val inputEnabled = state.inputText.isNotBlank() || state.stagedAttachment != null

    Column(
        modifier = modifier.fillMaxSize().background(chatBackground),
    ) {
        if (!state.isAuthenticated) {
            LoginForm(
                serverUrl = serverUrl,
                onServerUrlChanged = { serverUrl = it },
                email = email,
                onEmailChanged = { email = it },
                password = password,
                onPasswordChanged = { password = it },
                isLoggingIn = state.isLoggingIn,
                error = state.loginError,
                onLogin = { viewModel.onEvent(ChatUiEvent.Login(serverUrl.trim(), email.trim(), password)) },
                modifier = Modifier.fillMaxSize().padding(20.dp),
            )
        } else {
            Row(
                modifier = Modifier.fillMaxWidth().background(Color(0xFF10212A)).padding(horizontal = 8.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onBack, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text("‹", color = accent, fontSize = 30.sp, fontWeight = FontWeight.Light)
                }
                Surface(
                    modifier = Modifier.size(42.dp),
                    shape = CircleShape,
                    color = Color(0xFF0A4850),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text("A", color = accent, fontSize = 21.sp, fontWeight = FontWeight.Bold)
                    }
                }
                Column(modifier = Modifier.weight(1f).padding(start = 11.dp)) {
                    Text("Aris", color = Color(0xFFF3F7F8), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Your private assistant",
                        color = Color(0xFF9EB1B9),
                        fontSize = 12.sp,
                    )
                }
                Text("⋮", color = Color(0xFFB8C9CF), fontSize = 24.sp, modifier = Modifier.padding(horizontal = 8.dp))
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                itemsIndexed(state.messages, key = { _, message -> message.id }) { index, message ->
                    val previous = state.messages.getOrNull(index - 1)
                    if (previous == null || !isSameLocalDay(previous.timestampMs, message.timestampMs)) {
                        DateDivider(message.timestampMs)
                    }
                    MessageBubble(
                        message = message,
                        state = state,
                        onReply = { onEvent(ChatUiEvent.ReplyToMessage(message.id)) },
                        onEvent = viewModel::onEvent,
                    )
                }
                if (!state.progressMessage.isNullOrBlank()) {
                    item(key = "progress") {
                        Row(
                            modifier = Modifier.padding(start = 7.dp, top = 2.dp, bottom = 5.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text("●", color = accent, fontSize = 9.sp)
                            Text(state.progressMessage.orEmpty(), color = Color(0xFFAFBDC2), fontSize = 13.sp)
                        }
                    }
                }
            }

            Column(
                modifier = Modifier.fillMaxWidth().background(Color(0xFF0D1D25)).padding(horizontal = 9.dp, vertical = 7.dp),
            ) {
                state.replyingTo?.let { reply ->
                    ReplyPreview(
                        title = if (reply.sender == Sender.ARIS) "Aris" else "You",
                        content = reply.text.ifBlank { attachmentLabel(reply.attachment) },
                        accent = accent,
                        onDismiss = { onEvent(ChatUiEvent.ClearReply) },
                    )
                }
                state.stagedAttachment?.let { attachment ->
                    ReplyPreview(
                        title = attachment.fileName,
                        content = "${attachment.mimeType} · ready to send",
                        accent = Color(0xFF80D6C5),
                        onDismiss = { onEvent(ChatUiEvent.ClearStagedAttachment) },
                    )
                }
                if (state.isRecordingVoice) {
                    RecordingComposer(
                        durationMs = state.recordingDurationMs,
                        amplitudes = state.recordingAmplitudes,
                        onCancel = { onEvent(ChatUiEvent.CancelRecording) },
                        onSend = { onEvent(ChatUiEvent.StopRecording) },
                    )
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(7.dp),
                    ) {
                        IconButton(onClick = { filePicker.launch(arrayOf("*/*")) }, modifier = Modifier.size(46.dp)) {
                            Text("＋", color = Color(0xFFCBDBDF), fontSize = 30.sp, fontWeight = FontWeight.Light)
                        }
                        Surface(
                            modifier = Modifier.weight(1f),
                            shape = RoundedCornerShape(25.dp),
                            color = Color(0xFF1A2C35),
                        ) {
                            BasicTextField(
                                value = state.inputText,
                                onValueChange = { onEvent(ChatUiEvent.UpdateInput(it)) },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp, max = 130.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                                textStyle = TextStyle(color = Color(0xFFF3F7F8), fontSize = 15.sp),
                                cursorBrush = Brush.verticalGradient(listOf(accent, accent)),
                                decorationBox = { innerTextField ->
                                    Box {
                                        if (state.inputText.isEmpty()) {
                                            Text("Message Aris", color = Color(0xFF91A6AE), fontSize = 15.sp)
                                        }
                                        innerTextField()
                                    }
                                },
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
                            )
                        }
                        if (inputEnabled) {
                            IconButton(
                                onClick = { onEvent(ChatUiEvent.SendText(state.inputText)) },
                                modifier = Modifier.size(48.dp).background(accent, CircleShape),
                            ) {
                                Text("➤", color = Color(0xFF062B2A), fontSize = 21.sp, fontWeight = FontWeight.Bold)
                            }
                        } else {
                            IconButton(
                                onClick = {
                                    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                                        android.content.pm.PackageManager.PERMISSION_GRANTED
                                    ) {
                                        onEvent(ChatUiEvent.StartRecording)
                                    } else {
                                        audioPermission.launch(Manifest.permission.RECORD_AUDIO)
                                    }
                                },
                                modifier = Modifier.size(48.dp).background(accent, CircleShape),
                            ) {
                                Text("●", color = Color(0xFF062B2A), fontSize = 17.sp)
                            }
                        }
                    }
                }
                AnimatedVisibility(visible = pickerError != null) {
                    Text(
                        pickerError.orEmpty(),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(start = 8.dp, top = 5.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun LoginForm(
    serverUrl: String,
    onServerUrlChanged: (String) -> Unit,
    email: String,
    onEmailChanged: (String) -> Unit,
    password: String,
    onPasswordChanged: (String) -> Unit,
    isLoggingIn: Boolean,
    error: String?,
    onLogin: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        OutlinedTextField(
            value = serverUrl,
            onValueChange = onServerUrlChanged,
            label = { Text("Server URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        OutlinedTextField(
            value = email,
            onValueChange = onEmailChanged,
            label = { Text("Email") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        OutlinedTextField(
            value = password,
            onValueChange = onPasswordChanged,
            label = { Text("Password") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(8.dp)) }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = onLogin,
            enabled = !isLoggingIn && email.isNotBlank() && password.isNotBlank() && serverUrl.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (isLoggingIn) "Connecting…" else "Log in")
        }
    }
}

@Composable
private fun MessageBubble(
    message: ChatMessage,
    state: ChatUiState,
    onReply: () -> Unit,
    onEvent: (ChatUiEvent) -> Unit,
) {
    val isAris = message.sender == Sender.ARIS
    val bubbleColor = if (isAris) Color(0xFF172832) else Color(0xFF075E54)
    AnimatedVisibility(
        visible = true,
        enter = fadeIn() + slideInVertically(initialOffsetY = { it / 5 }),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = if (isAris) Arrangement.Start else Arrangement.End,
            verticalAlignment = Alignment.Bottom,
        ) {
            Surface(
                modifier = Modifier.fillMaxWidth(0.88f),
                shape = if (isAris) {
                    RoundedCornerShape(topStart = 5.dp, topEnd = 17.dp, bottomEnd = 17.dp, bottomStart = 17.dp)
                } else {
                    RoundedCornerShape(topStart = 17.dp, topEnd = 5.dp, bottomEnd = 17.dp, bottomStart = 17.dp)
                },
                color = bubbleColor,
                shadowElevation = 1.dp,
            ) {
                Column(
                    modifier = Modifier.padding(start = 11.dp, end = 10.dp, top = 8.dp, bottom = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    if (isAris) {
                        Text("ARIS", color = Color(0xFF65E6D0), fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
                    }
                    message.quotedText?.takeIf(String::isNotBlank)?.let {
                        Surface(
                            shape = RoundedCornerShape(5.dp),
                            color = Color.Black.copy(alpha = 0.18f),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(start = 8.dp, top = 5.dp, bottom = 5.dp, end = 7.dp)) {
                                Text(
                                    if (message.quotedSender == Sender.USER) "You" else "Aris",
                                    color = Color(0xFF76D9C7),
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Text(it, color = Color(0xFFC5D1D5), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    message.text.takeIf(String::isNotBlank)?.let {
                        Text(it, color = Color(0xFFF0F4F5), fontSize = 15.sp, lineHeight = 21.sp)
                    }
                    message.transcript?.takeIf(String::isNotBlank)?.let {
                        Text("Transcript · $it", color = Color(0xFFCAD4D7), fontSize = 13.sp, lineHeight = 18.sp)
                    }
                    message.attachment?.let { AttachmentPreview(it, message.id, 0, state, onEvent) }
                    message.arisAttachments.forEachIndexed { index, attachment ->
                        AttachmentPreview(attachment, message.id, index, state, onEvent)
                    }
                    if (message.voiceBase64 != null) {
                        TextButton(
                            onClick = { onEvent(ChatUiEvent.PlayVoice(message.id)) },
                            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                        ) {
                            Text(if (state.playbackKey == message.id) "Ⅱ  Stop voice" else "▶  Play voice", color = Color(0xFF8CE5D6))
                        }
                    }
                    message.pendingAction?.let {
                        Surface(color = Color.Black.copy(alpha = 0.18f), shape = RoundedCornerShape(10.dp)) {
                            Column(Modifier.padding(10.dp)) {
                                Text("Approval requested · ${it.tool}", color = Color(0xFFE8F0F2), fontSize = 13.sp)
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TextButton(onClick = { onEvent(ChatUiEvent.ApproveAction(message.id)) }) { Text("Approve") }
                                    TextButton(onClick = { onEvent(ChatUiEvent.DenyAction(message.id)) }) {
                                        Text("Decline", color = Color(0xFFFFA3A3))
                                    }
                                }
                            }
                        }
                    }
                    Row(
                        modifier = Modifier.align(Alignment.End),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        if (message.status == MessageStatus.ERROR) {
                            Text("Not sent", color = Color(0xFFFFB1A9), fontSize = 10.sp)
                        } else if (message.status == MessageStatus.SENDING) {
                            Text("Sending…", color = Color(0xFFB5C5CA), fontSize = 10.sp)
                        }
                        Text(formatMessageTime(message.timestampMs), color = Color(0xFFB5C5CA), fontSize = 10.sp)
                        if (!isAris) {
                            Text(
                                if (message.status == MessageStatus.SENT) "✓" else if (message.status == MessageStatus.ERROR) "!" else "◷",
                                color = if (message.status == MessageStatus.ERROR) Color(0xFFFFB1A9) else Color(0xFF9DD9DB),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                    if (message.status == MessageStatus.ERROR) {
                        Text("Tap to review this message", color = Color(0xFFFFC5BD), fontSize = 10.sp)
                    }
                }
            }
            Text(
                text = "↩",
                color = Color(0xFF91A7AE),
                fontSize = 18.sp,
                modifier = Modifier
                    .padding(horizontal = 3.dp, vertical = 5.dp)
                    .clickable(onClick = onReply)
                    .padding(4.dp),
            )
        }
    }
}

@Composable
private fun DateDivider(timestampMs: Long) {
    val today = remember { dayKey(System.currentTimeMillis()) }
    val yesterday = remember { dayKey(System.currentTimeMillis() - 24L * 60L * 60L * 1000L) }
    val messageDay = remember(timestampMs) { dayKey(timestampMs) }
    val formattedDate = remember(timestampMs) {
        SimpleDateFormat("EEE, MMM d, yyyy", Locale.getDefault()).format(Date(timestampMs)).uppercase(Locale.getDefault())
    }
    val label = when (messageDay) {
        today -> "TODAY"
        yesterday -> "YESTERDAY"
        else -> formattedDate
    }
    Box(Modifier.fillMaxWidth().padding(vertical = 9.dp), contentAlignment = Alignment.Center) {
        Surface(shape = RoundedCornerShape(20.dp), color = Color(0xFF1A3038), shadowElevation = 1.dp) {
            Text(label, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp), color = Color(0xFFBDD0D4), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.7.sp)
        }
    }
}

private fun dayKey(timestampMs: Long): String =
    SimpleDateFormat("yyyyMMdd", Locale.ROOT).format(Date(timestampMs))

private fun isSameLocalDay(first: Long, second: Long): Boolean = dayKey(first) == dayKey(second)

private fun formatMessageTime(timestampMs: Long): String =
    SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(timestampMs))

private fun attachmentLabel(attachment: MediaAttachment?): String = when (attachment) {
    is MediaAttachment.Image -> "Photo"
    is MediaAttachment.Video -> "Video"
    is MediaAttachment.Audio -> "Audio"
    is MediaAttachment.VoiceNote -> "Voice note"
    is MediaAttachment.Document -> attachment.fileName
    null -> "Message"
}

@Composable
private fun ReplyPreview(title: String, content: String, accent: Color, onDismiss: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            modifier = Modifier.weight(1f),
            shape = RoundedCornerShape(8.dp),
            color = Color(0xFF1A2C35),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(3.dp).height(42.dp).background(accent))
                Column(Modifier.weight(1f).padding(horizontal = 9.dp, vertical = 5.dp)) {
                    Text(title, color = accent, fontWeight = FontWeight.SemiBold, fontSize = 11.sp)
                    Text(content, color = Color(0xFFC7D4D8), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        TextButton(onClick = onDismiss, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Text("×", color = Color(0xFFB8C7CB), fontSize = 21.sp)
        }
    }
}

@Composable
private fun RecordingComposer(
    durationMs: Long,
    amplitudes: List<Float>,
    onCancel: () -> Unit,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("×", color = Color(0xFFFF8888), fontSize = 26.sp, modifier = Modifier.clickable(onClick = onCancel).padding(horizontal = 7.dp))
        Text("●", color = Color(0xFFFF6868), fontSize = 12.sp)
        Text(formatRecordingDuration(durationMs), color = Color(0xFFE8F0F2), fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Canvas(Modifier.weight(1f).height(30.dp)) {
            val sampleCount = amplitudes.size.coerceAtLeast(1)
            val step = size.width / sampleCount
            amplitudes.forEachIndexed { index, sample ->
                val barHeight = (4.dp.toPx() + sample.coerceIn(0f, 1f) * size.height * 0.8f).coerceAtMost(size.height)
                val x = step * (index + 0.5f)
                drawLine(Color(0xFF65E6D0), Offset(x, (size.height - barHeight) / 2), Offset(x, (size.height + barHeight) / 2), 2.dp.toPx(), cap = androidx.compose.ui.graphics.StrokeCap.Round)
            }
        }
        IconButton(onClick = onSend, modifier = Modifier.size(46.dp).background(Color(0xFF65E6D0), CircleShape)) {
            Text("➤", color = Color(0xFF062B2A), fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
    }
}

private fun formatRecordingDuration(durationMs: Long): String {
    val totalSeconds = (durationMs / 1000).coerceAtLeast(0)
    return "%d:%02d".format(Locale.ROOT, totalSeconds / 60, totalSeconds % 60)
}

@Composable
private fun AttachmentPreview(
    attachment: MediaAttachment,
    messageId: String,
    index: Int,
    state: ChatUiState,
    onEvent: (ChatUiEvent) -> Unit,
) {
    when (attachment) {
        is MediaAttachment.Image -> {
            val bitmap = remember(attachment.base64) {
                runCatching { BitmapFactory.decodeByteArray(Base64.decode(attachment.base64, Base64.DEFAULT), 0, Base64.decode(attachment.base64, Base64.DEFAULT).size)?.asImageBitmap() }
                    .getOrNull()
            }
            if (bitmap != null) Image(bitmap, contentDescription = "Attached image", modifier = Modifier.fillMaxWidth().height(220.dp))
            else Text("Image attachment")
        }
        is MediaAttachment.Video -> Text("Video attachment (${attachment.mimeType})")
        is MediaAttachment.Audio -> AudioAttachmentButton(messageId, index, attachment, state, onEvent)
        is MediaAttachment.VoiceNote -> AudioAttachmentButton(messageId, index, attachment, state, onEvent)
        is MediaAttachment.Document -> {
            val context = LocalContext.current
            TextButton(onClick = { openDocument(context, attachment) }) {
                Text("Open ${attachment.fileName}")
            }
        }
    }
}

@Composable
private fun AudioAttachmentButton(
    messageId: String,
    index: Int,
    attachment: MediaAttachment,
    state: ChatUiState,
    onEvent: (ChatUiEvent) -> Unit,
) {
    val playbackKey = if (index < 0) messageId else "${messageId}_att_$index"
    TextButton(onClick = { onEvent(ChatUiEvent.PlayAttachment(messageId, index)) }) {
        Text(
            if (state.playbackKey == playbackKey) "Stop audio (${attachment.mimeType})"
            else "Play audio (${attachment.mimeType})"
        )
    }
}

private fun openDocument(context: Context, attachment: MediaAttachment.Document) {
    val uri = if (attachment.uri.scheme == "file") {
        val path = attachment.uri.path ?: run {
            Toast.makeText(context, "This file is no longer available.", Toast.LENGTH_SHORT).show()
            return
        }
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", File(path))
    } else {
        attachment.uri
    }
    val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, attachment.mimeType)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
        context.startActivity(Intent.createChooser(intent, "Open ${attachment.fileName}"))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No app can open this file type.", Toast.LENGTH_SHORT).show()
    }
}

private suspend fun readAttachment(context: Context, uri: Uri): MediaAttachment = withContext(Dispatchers.IO) {
    val mimeType = context.contentResolver.getType(uri) ?: "application/octet-stream"
    val fileName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }?.takeIf(String::isNotBlank) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "attachment"
    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var totalBytes = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            totalBytes += count
            if (totalBytes > MAX_ATTACHMENT_BYTES) throw IOException("Choose a file smaller than 20 MB.")
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    } ?: throw IOException("The selected file could not be opened.")
    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
    when {
        mimeType.startsWith("image/") -> MediaAttachment.Image(uri, base64, mimeType, fileName)
        mimeType.startsWith("video/") -> MediaAttachment.Video(uri, base64, mimeType, fileName)
        mimeType.startsWith("audio/") -> MediaAttachment.Audio(uri, base64, mimeType, fileName = fileName)
        else -> MediaAttachment.Document(uri, base64, mimeType, fileName)
    }
}

private class ChatViewModelFactory(private val context: Context) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (!modelClass.isAssignableFrom(ChatViewModel::class.java)) {
            throw IllegalArgumentException("Unsupported ViewModel class: ${modelClass.name}")
        }
        return ChatViewModel(context) as T
    }
}

private const val MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
