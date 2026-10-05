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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
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

    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Chat with Aris", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }

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
                onLogin = {
                    viewModel.onEvent(ChatUiEvent.Login(serverUrl.trim(), email.trim(), password))
                },
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.messages, key = ChatMessage::id) { message ->
                    MessageCard(
                        message = message,
                        state = state,
                        onEvent = viewModel::onEvent,
                    )
                }
                if (!state.progressMessage.isNullOrBlank()) {
                    item(key = "progress") {
                        Text(
                            text = state.progressMessage.orEmpty(),
                            color = MaterialTheme.colorScheme.secondary,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }

            state.replyingTo?.let { reply ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Replying to: ${reply.text.take(100)}",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(onClick = { viewModel.onEvent(ChatUiEvent.ClearReply) }) { Text("Cancel") }
                }
            }

            state.stagedAttachment?.let { attachment ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Attached: ${attachment.fileName} (${attachment.mimeType})",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(onClick = { viewModel.onEvent(ChatUiEvent.ClearStagedAttachment) }) { Text("Remove") }
                }
            }

            OutlinedTextField(
                value = state.inputText,
                onValueChange = { viewModel.onEvent(ChatUiEvent.UpdateInput(it)) },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Message Aris") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { filePicker.launch(arrayOf("*/*")) }) { Text("Attach") }
                if (state.isRecordingVoice) {
                    TextButton(onClick = { viewModel.onEvent(ChatUiEvent.CancelRecording) }) { Text("Cancel") }
                    Button(onClick = { viewModel.onEvent(ChatUiEvent.StopRecording) }) { Text("Stop voice") }
                } else {
                    TextButton(
                        onClick = {
                            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                                android.content.pm.PackageManager.PERMISSION_GRANTED
                            ) {
                                viewModel.onEvent(ChatUiEvent.StartRecording)
                            } else {
                                audioPermission.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        },
                    ) { Text("Voice") }
                    Button(
                        onClick = { viewModel.onEvent(ChatUiEvent.SendText(state.inputText)) },
                        enabled = state.inputText.isNotBlank() || state.stagedAttachment != null,
                    ) { Text("Send") }
                }
            }
            pickerError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
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
private fun MessageCard(
    message: ChatMessage,
    state: ChatUiState,
    onEvent: (ChatUiEvent) -> Unit,
) {
    val isAris = message.sender == Sender.ARIS
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isAris) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.primaryContainer,
        ),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (isAris) "Aris" else "You", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            message.quotedText?.takeIf(String::isNotBlank)?.let {
                Text("Replying to: $it", style = MaterialTheme.typography.bodySmall)
            }
            message.text.takeIf(String::isNotBlank)?.let { Text(it) }
            message.transcript?.takeIf(String::isNotBlank)?.let { Text("Transcript: $it") }
            message.attachment?.let { AttachmentPreview(it, message.id, 0, state, onEvent) }
            message.arisAttachments.forEachIndexed { index, attachment ->
                AttachmentPreview(attachment, message.id, index, state, onEvent)
            }
            if (message.voiceBase64 != null) {
                TextButton(onClick = { onEvent(ChatUiEvent.PlayVoice(message.id)) }) {
                    Text(if (state.playbackKey == message.id) "Stop audio" else "Play audio")
                }
            }
            if (message.status != MessageStatus.SENT) {
                Text(message.status.name.lowercase(), style = MaterialTheme.typography.labelSmall)
            }
            message.pendingAction?.let {
                Text("Aris is requesting approval for ${it.tool}.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onEvent(ChatUiEvent.ApproveAction(message.id)) }) { Text("Approve") }
                    TextButton(onClick = { onEvent(ChatUiEvent.DenyAction(message.id)) }) {
                        Text("Deny", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
            if (isAris && message.text.isNotBlank()) {
                TextButton(onClick = { onEvent(ChatUiEvent.ReplyToMessage(message.id)) }) { Text("Reply") }
            }
        }
    }
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
