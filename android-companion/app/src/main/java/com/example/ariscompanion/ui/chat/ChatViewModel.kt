package com.example.ariscompanion.ui.chat

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.util.Log
import com.example.ariscompanion.PhoneLocationProvider
import com.example.ariscompanion.VisionState
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "ChatViewModel"
private const val PREFS_NAME = "aris_chat_prefs"
private const val PREF_AUTH_TOKEN = "auth_token"
private const val PREF_SERVER_URL = "server_url"
private const val PREF_EMAIL = "email"
private const val PREF_MESSAGES = "chat_messages"
private const val SESSION_ID = "aris-android-chat"
private const val SERVER_HEALTH_CHECK_INTERVAL_MS = 30_000L

// Amplitudes to capture for waveform visualisation
private const val WAVEFORM_SAMPLES = 40

object ChatSession {
    private val logoutEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    fun logout(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(PREF_AUTH_TOKEN)
            .remove(PREF_MESSAGES)
            .apply()
        logoutEvents.tryEmit(Unit)
    }

    suspend fun observeLogout(onLogout: () -> Unit) {
        logoutEvents.collect { onLogout() }
    }
}

class ChatViewModel(private val appContext: Context) : ViewModel() {

    private val prefs: SharedPreferences = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _uiState = MutableStateFlow(
        ChatUiState(
            messages = loadPersistedMessages(),
            serverUrl = prefs.getString(PREF_SERVER_URL, "https://impose-persuaded-unjustly.ngrok-free.dev") ?: "https://impose-persuaded-unjustly.ngrok-free.dev",
            email = prefs.getString(PREF_EMAIL, "") ?: "",
            isAuthenticated = prefs.getString(PREF_AUTH_TOKEN, null) != null,
        )
    )
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    private var outboxPollJob: Job? = null
    private var serverHealthJob: Job? = null
    private var authToken: String? = prefs.getString(PREF_AUTH_TOKEN, null)

    init {
        if (authToken != null) {
            startOutboxPolling()
            startServerHealthChecks()
        }
        viewModelScope.launch {
            ChatSession.observeLogout {
                authToken = null
                outboxPollJob?.cancel()
                serverHealthJob?.cancel()
                cancelVoiceRecording()
                stopPlayback()
                persistMessages(emptyList())
                _uiState.update {
                    it.copy(
                        messages = emptyList(),
                        isAuthenticated = false,
                        isLoggingIn = false,
                        loginError = null,
                        inputText = "",
                        stagedAttachment = null,
                        progressMessage = null,
                        serverHealthStatus = ServerHealthStatus.UNKNOWN,
                        serverHealthMessage = "Tap to check server",
                        replyingTo = null,
                    )
                }
            }
        }
    }

    
    private fun startOutboxPolling() {
        outboxPollJob?.cancel()
        outboxPollJob = viewModelScope.launch {
            while (isActive) {
                try {
                    val msgs = client?.pollOutbox() ?: emptyList()
                    handleOutboxMessages(msgs)
                } catch (e: Exception) {
                    Log.e(TAG, "Outbox poll error", e)
                }
                delay(3000)
            }
        }
    }

    private suspend fun handleOutboxMessages(msgs: List<JSONObject>) {
        for (msg in msgs) {
            val outboxId = msg.optLong("id", -1L)
            if (outboxId <= 0L) {
                Log.e(TAG, "Skipping outbox message with invalid id")
                continue
            }
            if (_uiState.value.messages.any { it.outboxId == outboxId }) {
                client?.acknowledgeOutboxMessage(outboxId)
                continue
            }
            val type = msg.optString("messageType", "")
            val content = msg.optString("body", msg.optString("content", ""))
            val mediaDriveRef = msg.optString("mediaDriveRef", "")
            val mediaMimeType = msg.optString("mediaMimeType").ifBlank {
                if (type == "document") "application/pdf" else "audio/mpeg"
            }
            val mediaFileName = content.ifBlank {
                if (type == "document") "Aris document" else "Aris audio"
            }
            val quoted = msg.optJSONObject("quotedMessage")
            val quotedText = quoted?.optString("text")?.ifEmpty { quoted.optString("body") }

            Log.i(TAG, "Outbox message id=${msg.optLong("id", -1)} type=$type hasMedia=${mediaDriveRef.isNotEmpty()}")

            var attachment: MediaAttachment? = null
            if (mediaDriveRef.startsWith("drive:")) {
                val fileId = mediaDriveRef.removePrefix("drive:")
                try {
                    val bytes = withContext(Dispatchers.IO) {
                        val api = client ?: throw IOException("Sign in again to retrieve this audio.")
                        api.downloadDriveMedia(fileId)
                    }
                    val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.DEFAULT)
                    val isDocument = type == "document" || !mediaMimeType.startsWith("audio/")
                    val tempFile = File(appContext.cacheDir, "$fileId${if (isDocument) ".document" else ".audio"}")
                    tempFile.writeBytes(bytes)
                    attachment = if (isDocument) {
                        MediaAttachment.Document(
                            uri = Uri.fromFile(tempFile),
                            base64 = base64,
                            mimeType = mediaMimeType,
                            fileName = mediaFileName,
                        )
                    } else {
                        MediaAttachment.Audio(
                            uri = Uri.fromFile(tempFile),
                            base64 = base64,
                            mimeType = mediaMimeType,
                            fileName = mediaFileName,
                        )
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to download drive audio", e)
                }
            }

            if (type in setOf("audio", "document") && attachment == null) {
                Log.e(TAG, "Skipping undeliverable media outbox message; type=$type ref=$mediaDriveRef")
                continue
            }

            _uiState.update { state ->
                if (state.messages.any { it.outboxId == outboxId }) {
                    state
                } else {
                    state.copy(messages = state.messages + ChatMessage(
                        id = "outbox-$outboxId",
                        sender = Sender.ARIS,
                        text = content,
                        attachment = attachment,
                        quotedText = quotedText?.ifEmpty { null },
                        quotedSender = Sender.USER,
                        outboxId = outboxId,
                    )).also { persistMessages(it.messages) }
                }
            }
            client?.acknowledgeOutboxMessage(outboxId)
        }
    }

    private val client: ArisApiClient?
        get() = authToken?.let { ArisApiClient(_uiState.value.serverUrl, it) }

    // Voice recording state
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private var recordedBytes: ByteArrayOutputStream? = null
    private var recordingStartMs: Long = 0L
    private val amplitudeBuffer = mutableListOf<Float>()

    // Audio playback
    private var mediaPlayer: MediaPlayer? = null
    private var playingMessageId: String? = null
    private var playbackPrepared = false
    private var playbackJob: Job? = null

    // ── Public event handler ─────────────────────────────────────────────────

    fun onEvent(event: ChatUiEvent) {
        when (event) {
            is ChatUiEvent.Login -> doLogin(event.serverUrl, event.email, event.password)
            is ChatUiEvent.UpdateInput -> _uiState.update { it.copy(inputText = event.text) }
            is ChatUiEvent.SendText -> {
                val text = event.text.trim()
                val staged = _uiState.value.stagedAttachment
                if (staged != null) {
                    sendMediaMessage(staged, text)
                    _uiState.update { it.copy(stagedAttachment = null, inputText = "") }
                } else if (text.isNotEmpty()) {
                    sendTextMessage(text)
                    _uiState.update { it.copy(inputText = "") }
                }
            }
            is ChatUiEvent.StartRecording -> startVoiceRecording()
            is ChatUiEvent.StopRecording -> stopAndSendVoiceNote()
            is ChatUiEvent.CancelRecording -> cancelVoiceRecording()
            is ChatUiEvent.SendVoiceNote -> sendVoiceNoteMessage(event.attachment)
            is ChatUiEvent.SendMedia -> sendMediaMessage(event.attachment, event.caption)
            is ChatUiEvent.StageAttachment -> _uiState.update { it.copy(stagedAttachment = event.attachment) }
            is ChatUiEvent.ClearStagedAttachment -> _uiState.update { it.copy(stagedAttachment = null) }
            is ChatUiEvent.ApproveAction -> approveAction(event.messageId)
            is ChatUiEvent.DenyAction -> denyAction(event.messageId)
            is ChatUiEvent.PlayVoice -> playVoice(event.messageId)
            is ChatUiEvent.PlayAttachment -> playArisAttachment(event.messageId, event.attachmentIndex)
            is ChatUiEvent.SeekAudio -> seekAudio(event.messageId, event.attachmentIndex, event.positionMs)
            is ChatUiEvent.ReplyToMessage -> {
                _uiState.update { state -> state.copy(replyingTo = state.messages.firstOrNull { it.id == event.messageId }) }
            }
            is ChatUiEvent.RetrySend -> retryFailedMessage(event.messageId)
            ChatUiEvent.CheckServerStatus -> startServerHealthChecks()
            is ChatUiEvent.ClearReply -> _uiState.update { it.copy(replyingTo = null) }
        }
    }

    // ── Login ────────────────────────────────────────────────────────────────

    private fun doLogin(serverUrl: String, email: String, password: String) {
        _uiState.update { it.copy(isLoggingIn = true, loginError = null) }
        viewModelScope.launch {
            try {
                val result = ArisApiClient.login(serverUrl, email, password)
                authToken = result.token
                prefs.edit()
                    .putString(PREF_AUTH_TOKEN, result.token)
                    .putString(PREF_SERVER_URL, serverUrl)
                    .putString(PREF_EMAIL, email)
                    .apply()
                _uiState.update {
                    it.copy(
                        isLoggingIn = false,
                        isAuthenticated = true,
                        serverUrl = serverUrl,
                        email = email,
                        loginError = null,
                    )
                }
                startServerHealthChecks()
                addSystemMessage("Connected as ${result.email}. Say hi to Aris! 👋")
            } catch (e: Exception) {
                Log.e(TAG, "Login failed", e)
                _uiState.update { it.copy(isLoggingIn = false, loginError = e.message ?: "Login failed") }
            }
        }
    }

    private fun startServerHealthChecks() {
        serverHealthJob?.cancel()
        serverHealthJob = viewModelScope.launch {
            while (isActive) {
                val api = client
                if (api == null) {
                    _uiState.update {
                        it.copy(
                            serverHealthStatus = ServerHealthStatus.UNKNOWN,
                            serverHealthMessage = "Sign in to check server",
                        )
                    }
                    return@launch
                }

                _uiState.update {
                    it.copy(
                        serverHealthStatus = ServerHealthStatus.CHECKING,
                        serverHealthMessage = "Checking server…",
                    )
                }
                try {
                    val result = api.checkServerHealth()
                    _uiState.update {
                        it.copy(
                            serverHealthStatus = if (result.healthy) {
                                ServerHealthStatus.HEALTHY
                            } else {
                                ServerHealthStatus.RESPONDING
                            },
                            serverHealthMessage = result.message,
                        )
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    Log.w(TAG, "Server health check failed", e)
                    _uiState.update {
                        it.copy(
                            serverHealthStatus = ServerHealthStatus.UNREACHABLE,
                            serverHealthMessage = "Server unreachable · ${e.message ?: "check connection"}",
                        )
                    }
                }
                delay(SERVER_HEALTH_CHECK_INTERVAL_MS)
            }
        }
    }

    // ── Text message ─────────────────────────────────────────────────────────

    private fun sendTextMessage(text: String, retryMessage: ChatMessage? = null) {
        val msgId = retryMessage?.id ?: UUID.randomUUID().toString()
        val replyingTo = if (retryMessage == null) _uiState.value.replyingTo else null
        if (retryMessage == null) {
            appendMessage(
                ChatMessage(
                    id = msgId,
                    sender = Sender.USER,
                    text = text,
                    status = MessageStatus.SENDING,
                    quotedText = replyingTo?.replySummary(),
                    quotedSender = replyingTo?.sender,
                )
            )
            _uiState.update { it.copy(replyingTo = null) }
        } else {
            updateMessage(msgId) { it.copy(status = MessageStatus.SENDING) }
        }

        viewModelScope.launch {
            val arisId = beginAssistantReply(msgId)
            try {
                _uiState.update { it.copy(progressMessage = "Connecting to Aris…") }
                val visionFrame = if (VisionState.isCapturing.value) {
                    withContext(Dispatchers.IO) {
                        VisionState.captureService?.captureCurrentFrameBase64()
                    }?.let { frame -> mapOf("mimeType" to "image/jpeg", "dataBase64" to frame) }
                } else {
                    null
                }

                var finalResult: ArisChatResult? = null
                updatePhoneLocationForRequest(text)
                _uiState.update { it.copy(progressMessage = "Sending your message…") }
                client?.chatStream(
                    text,
                    SESSION_ID,
                    mediaData = visionFrame,
                    replyContext = retryMessage?.retryReplyContext() ?: replyingTo?.replyContext(),
                ) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "heartbeat" -> { /* keep alive */ }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> throw IOException("The chat stream ended with an error.")
                    }
                }

                val result = finalResult ?: throw IOException("The server did not confirm the message.")
                updateMessageStatus(msgId, MessageStatus.SENT)
                run {
                    val pending = result.pendingAction?.let { pa ->
                        PendingAction(
                            tool = pa["tool"].toString(),
                            payload = pa["payload"] as? Map<String, Any?> ?: emptyMap()
                        )
                    }
                    val attachments = resolveArisAttachments(result.mediaAttachments)
                    
                    updateMessage(arisId) {
                        it.copy(
                            text = result.arisReply,
                            status = MessageStatus.SENT,
                            memoryUpdates = result.memoryUpdates,
                            pendingAction = if (result.status == "awaiting_approval") pending else null,
                            arisAttachments = attachments,
                        )
                    }
                }
            } catch (e: Exception) {
                if (e is CancellationException) {
                    showSendFailure(msgId, arisId, e)
                    throw e
                }
                Log.e(TAG, "sendTextMessage failed", e)
                showSendFailure(msgId, arisId, e)
            }
        }
    }

    private suspend fun resolveArisAttachments(
        descriptors: List<Map<String, String>>?,
    ): List<MediaAttachment> {
        val resolved = mutableListOf<MediaAttachment>()
        for (descriptor in descriptors.orEmpty()) {
            val mimeType = descriptor["mimeType"] ?: continue
            val fileName = descriptor["fileName"] ?: "aris-media"
            val base64 = descriptor["base64"] ?: descriptor["libraryId"]?.toIntOrNull()?.let { mediaId ->
                val api = client ?: throw IOException("Sign in again to download Aris's media attachment.")
                Base64.encodeToString(api.downloadMedia(mediaId), Base64.NO_WRAP)
            } ?: continue
            val attachment = when {
                mimeType.startsWith("audio/") ->
                    MediaAttachment.Audio(Uri.EMPTY, base64, mimeType, fileName = fileName)
                mimeType.startsWith("image/") ->
                    MediaAttachment.Image(Uri.EMPTY, base64, mimeType, fileName)
                mimeType.startsWith("video/") ->
                    MediaAttachment.Video(Uri.EMPTY, base64, mimeType, fileName)
                else ->
                    MediaAttachment.Document(Uri.EMPTY, base64, mimeType, fileName)
            }
            resolved.add(attachment)
        }
        return resolved
    }

    // ── Voice note ───────────────────────────────────────────────────────────

    private fun startVoiceRecording() {
        if (_uiState.value.isRecordingVoice) return
        val sampleRate = 16000
        val bufferSize = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            audioRecord?.startRecording()
            recordedBytes = ByteArrayOutputStream()
            recordingStartMs = System.currentTimeMillis()
            amplitudeBuffer.clear()

            _uiState.update { it.copy(isRecordingVoice = true, recordingDurationMs = 0L, recordingAmplitudes = emptyList()) }

            recordingJob = viewModelScope.launch(Dispatchers.IO) {
                val buffer = ShortArray(bufferSize)
                while (isActive && _uiState.value.isRecordingVoice) {
                    val read = audioRecord?.read(buffer, 0, bufferSize) ?: 0
                    if (read > 0) {
                        // Write PCM bytes
                        val bytes = ByteArray(read * 2)
                        for (i in 0 until read) {
                            bytes[i * 2] = (buffer[i].toInt() and 0xFF).toByte()
                            bytes[i * 2 + 1] = (buffer[i].toInt() shr 8 and 0xFF).toByte()
                        }
                        recordedBytes?.write(bytes)
                        // Compute amplitude for waveform
                        val amp = buffer.take(read).maxOrNull()?.toFloat()?.div(32767f) ?: 0f
                        amplitudeBuffer.add(amp.coerceIn(0f, 1f))
                        if (amplitudeBuffer.size > WAVEFORM_SAMPLES) amplitudeBuffer.removeAt(0)
                    }
                    val elapsed = System.currentTimeMillis() - recordingStartMs
                    _uiState.update {
                        it.copy(
                            recordingDurationMs = elapsed,
                            recordingAmplitudes = amplitudeBuffer.toList(),
                        )
                    }
                    delay(50)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            _uiState.update { it.copy(isRecordingVoice = false) }
        }
    }

    private fun stopAndSendVoiceNote() {
        val duration = System.currentTimeMillis() - recordingStartMs
        val waveform = amplitudeBuffer.toList()
        recordingJob?.cancel()
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        _uiState.update { it.copy(isRecordingVoice = false, recordingAmplitudes = emptyList()) }

        val pcmBytes = recordedBytes?.toByteArray() ?: return
        recordedBytes = null
        if (pcmBytes.isEmpty()) return

        // Write WAV file to cache
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val wavBytes = pcmToWav(pcmBytes, 16000, 1, 16)
                val file = File(appContext.cacheDir, "voice_note_${System.currentTimeMillis()}.wav")
                FileOutputStream(file).use { it.write(wavBytes) }
                val base64 = Base64.encodeToString(wavBytes, Base64.NO_WRAP)
                val attachment = MediaAttachment.VoiceNote(
                    uri = Uri.fromFile(file),
                    base64 = base64,
                    mimeType = "audio/wav",
                    durationMs = duration,
                    waveform = waveform,
                )
                sendVoiceNoteMessage(attachment)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to finalize voice note", e)
            }
        }
    }

    private fun cancelVoiceRecording() {
        recordingJob?.cancel()
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        recordedBytes = null
        _uiState.update { it.copy(isRecordingVoice = false, recordingAmplitudes = emptyList()) }
    }

    private fun sendVoiceNoteMessage(
        attachment: MediaAttachment.VoiceNote,
        retryMessage: ChatMessage? = null,
    ) {
        val msgId = retryMessage?.id ?: UUID.randomUUID().toString()
        val replyingTo = if (retryMessage == null) _uiState.value.replyingTo else null
        if (retryMessage == null) {
            appendMessage(
                ChatMessage(
                    id = msgId,
                    sender = Sender.USER,
                    attachment = attachment,
                    status = MessageStatus.SENDING,
                    quotedText = replyingTo?.replySummary(),
                    quotedSender = replyingTo?.sender,
                )
            )
            _uiState.update { it.copy(replyingTo = null) }
        } else {
            updateMessage(msgId) { it.copy(status = MessageStatus.SENDING) }
        }

        viewModelScope.launch {
            val arisId = beginAssistantReply(msgId)
            try {
                _uiState.update { it.copy(progressMessage = "🎧 Listening to your voice note…") }

                updatePhoneLocationForRequest("voice note")
                _uiState.update { it.copy(progressMessage = "Sending your voice note…") }
                val result = client?.sendVoice(
                    attachment.base64,
                    attachment.mimeType,
                    SESSION_ID,
                    retryMessage?.retryReplyContext() ?: replyingTo?.replyContext(),
                )
                    ?: throw Exception("Not connected")

                updateMessageStatus(msgId, MessageStatus.SENT)
                _uiState.update { it.copy(progressMessage = null) }
                updateMessage(arisId) {
                    it.copy(
                        text = listOfNotNull(result.arisReply, result.voiceError).joinToString("\n\n"),
                        voiceBase64 = result.voiceBase64,
                        voiceMimeType = result.voiceMimeType,
                        status = MessageStatus.SENT,
                        memoryUpdates = result.memoryUpdates,
                    )
                }
            } catch (e: Exception) {
                if (e is CancellationException) {
                    showSendFailure(msgId, arisId, e)
                    throw e
                }
                Log.e(TAG, "Voice note send failed", e)
                showSendFailure(msgId, arisId, e)
            }
        }
    }

    // ── Media (image / video / audio file) ───────────────────────────────────

    private fun sendMediaMessage(
        attachment: MediaAttachment,
        caption: String,
        retryMessage: ChatMessage? = null,
    ) {
        val msgId = retryMessage?.id ?: UUID.randomUUID().toString()
        val replyingTo = if (retryMessage == null) _uiState.value.replyingTo else null
        if (retryMessage == null) {
            appendMessage(
                ChatMessage(
                    id = msgId,
                    sender = Sender.USER,
                    text = caption,
                    attachment = attachment,
                    status = MessageStatus.SENDING,
                    quotedText = replyingTo?.replySummary(),
                    quotedSender = replyingTo?.sender,
                )
            )
            _uiState.update { it.copy(replyingTo = null) }
        } else {
            updateMessage(msgId) { it.copy(status = MessageStatus.SENDING) }
        }

        viewModelScope.launch {
            val arisId = beginAssistantReply(msgId)
            try {
                _uiState.update { it.copy(progressMessage = "📎 Processing attachment…") }

                val (base64, mime) = when (attachment) {
                    is MediaAttachment.Image -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.Video -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.Audio -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.VoiceNote -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.Document -> attachment.base64 to attachment.mimeType
                }

                var finalResult: ArisChatResult? = null
                updatePhoneLocationForRequest(caption)
                _uiState.update { it.copy(progressMessage = "Sending your attachment…") }
                client?.sendMediaChat(
                    caption,
                    base64,
                    mime,
                    attachment.fileName,
                    SESSION_ID,
                    retryMessage?.retryReplyContext() ?: replyingTo?.replyContext(),
                ) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> throw IOException("The chat stream ended with an error.")
                    }
                }
                val result = finalResult ?: throw IOException("The server did not confirm the message.")
                updateMessageStatus(msgId, MessageStatus.SENT)
                run {
                    updateMessage(arisId) {
                        it.copy(text = result.arisReply, status = MessageStatus.SENT, memoryUpdates = result.memoryUpdates)
                    }
                }
            } catch (e: Exception) {
                if (e is CancellationException) {
                    showSendFailure(msgId, arisId, e)
                    throw e
                }
                Log.e(TAG, "Media send failed", e)
                showSendFailure(msgId, arisId, e)
            }
        }
    }

    private fun retryFailedMessage(messageId: String) {
        val message = _uiState.value.messages.firstOrNull {
            it.id == messageId && it.sender == Sender.USER && it.status == MessageStatus.ERROR
        } ?: return
        when (val attachment = message.attachment) {
            is MediaAttachment.VoiceNote -> sendVoiceNoteMessage(attachment, message)
            null -> if (message.text.isNotBlank()) sendTextMessage(message.text, message)
            else -> sendMediaMessage(attachment, message.text, message)
        }
    }

    private fun beginAssistantReply(userMessageId: String): String {
        val existingReply = _uiState.value.messages.firstOrNull {
            it.sender == Sender.ARIS && it.inReplyToMessageId == userMessageId
        }
        if (existingReply != null) {
            updateMessage(existingReply.id) {
                it.copy(
                    text = "",
                    status = MessageStatus.SENDING,
                    voiceBase64 = null,
                    voiceMimeType = null,
                    arisAttachments = emptyList(),
                    memoryUpdates = emptyList(),
                    pendingAction = null,
                )
            }
            return existingReply.id
        }
        val assistantMessageId = UUID.randomUUID().toString()
        appendMessage(
            ChatMessage(
                id = assistantMessageId,
                sender = Sender.ARIS,
                status = MessageStatus.SENDING,
                inReplyToMessageId = userMessageId,
            )
        )
        return assistantMessageId
    }

    private fun showSendFailure(userMessageId: String, assistantMessageId: String, cause: Exception) {
        updateMessageStatus(userMessageId, MessageStatus.ERROR)
        _uiState.update { it.copy(progressMessage = null) }
        updateMessage(assistantMessageId) {
            it.copy(text = friendlySendFailure(cause), status = MessageStatus.SENT)
        }
    }

    private fun friendlySendFailure(cause: Exception): String = when (cause) {
        is CancellationException ->
            "Sending was interrupted. Your message is saved—tap Retry to try again."
        is SocketTimeoutException ->
            "I’m taking longer than expected to respond. Your message is saved—tap Retry to try again."
        is UnknownHostException, is ConnectException ->
            "I couldn’t reach the server just now. Your message is saved—tap Retry when you’re ready."
        else ->
            "I couldn’t complete that just now. Your message is saved—tap Retry to try again."
    }

    private fun ChatMessage.retryReplyContext(): String? {
        val quoted = quotedText?.takeIf(String::isNotBlank) ?: return null
        val speaker = if (quotedSender == Sender.USER) "User" else "Aris"
        return "$speaker message: $quoted"
    }

    // ── Approval actions ─────────────────────────────────────────────────────

    private fun approveAction(messageId: String) {
        val msg = _uiState.value.messages.firstOrNull { it.id == messageId } ?: return
        val pending = msg.pendingAction ?: return
        // Send an approval text message which carries the approvedAction payload
        val approvedActionPayload = mapOf("tool" to pending.tool, "payload" to pending.payload)
        val msgId = UUID.randomUUID().toString()
        appendMessage(ChatMessage(id = msgId, sender = Sender.USER, text = "✅ Approved", status = MessageStatus.SENT))
        // Clear the pending action on the Aris message
        updateMessage(messageId) { it.copy(pendingAction = null) }

        viewModelScope.launch {
            val arisId = UUID.randomUUID().toString()
            appendMessage(
                ChatMessage(
                    id = arisId,
                    sender = Sender.ARIS,
                    status = MessageStatus.SENDING,
                    inReplyToMessageId = msgId,
                )
            )
            try {
                var finalResult: ArisChatResult? = null
                updatePhoneLocationForRequest("approved action")
                _uiState.update { it.copy(progressMessage = "Sending your approval…") }
                client?.chatStream("approved", SESSION_ID, approvedActionPayload) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> throw IOException("The approval stream ended with an error.")
                    }
                }
                val result = finalResult ?: throw IOException("The server did not confirm the approved action.")
                updateMessage(arisId) {
                    it.copy(text = result.arisReply, status = MessageStatus.SENT, memoryUpdates = result.memoryUpdates)
                }
            } catch (e: Exception) {
                if (e is CancellationException) {
                    updateMessage(arisId) {
                        it.copy(
                            text = "Sending the approval was interrupted. Check whether the action completed before retrying.",
                            status = MessageStatus.SENT,
                        )
                    }
                    _uiState.update { it.copy(progressMessage = null) }
                    throw e
                }
                Log.e(TAG, "Approval send failed", e)
                updateMessage(arisId) {
                    it.copy(
                        text = "I couldn’t confirm whether that action completed. Please check before trying it again.",
                        status = MessageStatus.SENT,
                    )
                }
                _uiState.update { it.copy(progressMessage = null) }
            }
        }
    }

    private fun denyAction(messageId: String) {
        updateMessage(messageId) { it.copy(pendingAction = null) }
        sendTextMessage("cancel")
    }

    // ── Voice playback ────────────────────────────────────────────────────────

    private fun playVoice(messageId: String) {
        val msg = _uiState.value.messages.firstOrNull { it.id == messageId } ?: return
        val voiceBase64 = msg.voiceBase64 ?: return
        toggleAudioPlayback(
            messageId = messageId,
            playbackKey = messageId,
            base64 = voiceBase64,
            mimeType = msg.voiceMimeType ?: "audio/wav",
        )
    }

    private fun playArisAttachment(messageId: String, attachmentIndex: Int) {
        val msg = _uiState.value.messages.firstOrNull { it.id == messageId } ?: return
        val att = msg.arisAttachments.getOrNull(attachmentIndex)
            ?: msg.attachment?.takeIf { attachmentIndex == 0 }
            ?: return
        val base64 = when (att) {
            is MediaAttachment.Audio -> att.base64
            is MediaAttachment.VoiceNote -> att.base64
            else -> return
        }
        val mime = when (att) {
            is MediaAttachment.Audio -> att.mimeType
            is MediaAttachment.VoiceNote -> att.mimeType
            else -> return
        }

        toggleAudioPlayback(
            messageId = messageId,
            playbackKey = "${messageId}_att_$attachmentIndex",
            base64 = base64,
            mimeType = mime,
        )
    }

    private fun toggleAudioPlayback(
        messageId: String,
        playbackKey: String,
        base64: String,
        mimeType: String,
    ) {
        if (playingMessageId == playbackKey && mediaPlayer != null) {
            if (!playbackPrepared) return
            if (mediaPlayer?.isPlaying == true) {
                mediaPlayer?.pause()
                playbackJob?.cancel()
                _uiState.update { it.copy(isPlaybackActive = false) }
            } else {
                mediaPlayer?.start()
                _uiState.update { it.copy(isPlaybackActive = true) }
                beginPlaybackTracking(playbackKey)
            }
            return
        }

        stopPlayback()
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val extension = when {
                    mimeType.contains("ogg") -> "ogg"
                    mimeType.contains("mp3") || mimeType.contains("mpeg") -> "mp3"
                    mimeType.contains("m4a") || mimeType.contains("mp4") -> "m4a"
                    else -> "wav"
                }
                val safePlaybackKey = playbackKey.replace(Regex("[^A-Za-z0-9_-]"), "_")
                val file = File(appContext.cacheDir, "aris_audio_${safePlaybackKey}_$extension")
                if (!file.exists()) {
                    FileOutputStream(file).use { output ->
                        output.write(Base64.decode(base64, Base64.DEFAULT))
                    }
                }
                withContext(Dispatchers.Main) {
                    playingMessageId = playbackKey
                    playbackPrepared = false
                    mediaPlayer = MediaPlayer().apply {
                        setAudioAttributes(
                            AudioAttributes.Builder()
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .build()
                        )
                        setDataSource(file.absolutePath)
                        setOnPreparedListener { player ->
                            playbackPrepared = true
                            player.start()
                            beginPlaybackTracking(playbackKey)
                        }
                        setOnCompletionListener { stopPlayback() }
                        setOnErrorListener { _, what, extra ->
                            Log.e(TAG, "Audio playback failed what=$what extra=$extra")
                            stopPlayback()
                            true
                        }
                        prepareAsync()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Audio playback failed", e)
                playingMessageId = null
                _uiState.update { it.copy(isPlaybackActive = false, playbackKey = null) }
            }
        }
    }

    private fun beginPlaybackTracking(key: String) {
        val player = mediaPlayer ?: return
        playbackJob?.cancel()
        _uiState.update {
            it.copy(
                playbackKey = key,
                playbackPositionMs = player.currentPosition.toLong().coerceAtLeast(0L),
                playbackDurationMs = player.duration.toLong().coerceAtLeast(0L),
                isPlaybackActive = true,
            )
        }
        playbackJob = viewModelScope.launch {
            while (isActive && playingMessageId == key && mediaPlayer != null) {
                _uiState.update { state ->
                    state.copy(playbackPositionMs = mediaPlayer?.currentPosition?.toLong() ?: state.playbackPositionMs)
                }
                delay(200)
            }
        }
    }

    private fun stopPlayback() {
        playbackJob?.cancel()
        playbackJob = null
        runCatching { mediaPlayer?.stop() }
        mediaPlayer?.release()
        mediaPlayer = null
        playingMessageId = null
        playbackPrepared = false
        _uiState.update { it.copy(playbackKey = null, playbackPositionMs = 0L, playbackDurationMs = 0L, isPlaybackActive = false) }
    }

    private fun seekAudio(messageId: String, attachmentIndex: Int, positionMs: Long) {
        val key = if (attachmentIndex < 0) messageId else "${messageId}_att_$attachmentIndex"
        if (playingMessageId == key) {
            val boundedPosition = positionMs.toInt().coerceIn(0, mediaPlayer?.duration ?: 0)
            mediaPlayer?.seekTo(boundedPosition)
            _uiState.update { it.copy(playbackPositionMs = boundedPosition.toLong()) }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private suspend fun syncPhoneLocation() {
        val token = authToken ?: return
        try {
            PhoneLocationProvider.uploadCurrentLocation(appContext, _uiState.value.serverUrl, token)
        } catch (e: Exception) {
            Log.w(TAG, "Phone location sync failed; server will use its available fallback", e)
        }
    }

    private suspend fun updatePhoneLocationForRequest(message: String) {
        if (requiresCurrentPhoneLocation(message)) {
            syncPhoneLocation()
        } else {
            viewModelScope.launch { syncPhoneLocation() }
        }
    }

    private fun requiresCurrentPhoneLocation(message: String): Boolean =
        Regex("""\b(where am i|my (?:current )?location|current location|near me|nearby)\b""", RegexOption.IGNORE_CASE)
            .containsMatchIn(message)

    private fun appendMessage(msg: ChatMessage) {
        _uiState.update {
            it.copy(messages = it.messages + msg).also { updated -> persistMessages(updated.messages) }
        }
    }

    private fun updateMessage(id: String, transform: (ChatMessage) -> ChatMessage) {
        _uiState.update { state ->
            state.copy(messages = state.messages.map { if (it.id == id) transform(it) else it })
                .also { updated -> persistMessages(updated.messages) }
        }
    }

    private fun persistMessages(messages: List<ChatMessage>) {
        val json = JSONArray()
        messages.takeLast(100).forEach { message ->
            if (message.text.isEmpty() && message.transcript == null &&
                message.attachment == null && message.arisAttachments.isEmpty()
            ) return@forEach
            json.put(JSONObject().apply {
                put("id", message.id)
                put("sender", message.sender.name)
                put("text", message.text)
                put("status", message.status.name)
                put("timestampMs", message.timestampMs)
                message.transcript?.let { put("transcript", it) }
                message.quotedText?.let { put("quotedText", it) }
                message.quotedSender?.let { put("quotedSender", it.name) }
                message.inReplyToMessageId?.let { put("inReplyToMessageId", it) }
                message.outboxId?.let { put("outboxId", it) }
                message.attachment?.let { put("attachment", persistAttachment(message.id, "main", it)) }
                if (!message.voiceBase64.isNullOrEmpty()) {
                    val voiceFileName = "chat_media_${message.id}_voice"
                    File(appContext.filesDir, voiceFileName).writeBytes(Base64.decode(message.voiceBase64, Base64.DEFAULT))
                    put("voiceFileName", voiceFileName)
                    put("voiceMimeType", message.voiceMimeType ?: "audio/wav")
                }
                val generated = JSONArray()
                message.arisAttachments.forEachIndexed { index, attachment ->
                    generated.put(persistAttachment(message.id, "aris_$index", attachment))
                }
                if (generated.length() > 0) put("arisAttachments", generated)
            })
        }
        prefs.edit().putString(PREF_MESSAGES, json.toString()).apply()
    }

    private fun persistAttachment(messageId: String, slot: String, attachment: MediaAttachment): JSONObject {
        val fileName = "chat_media_${messageId}_$slot"
        val base64 = when (attachment) {
            is MediaAttachment.Image -> attachment.base64
            is MediaAttachment.Video -> attachment.base64
            is MediaAttachment.Audio -> attachment.base64
            is MediaAttachment.VoiceNote -> attachment.base64
            is MediaAttachment.Document -> attachment.base64
        }
        val mimeType = when (attachment) {
            is MediaAttachment.Image -> attachment.mimeType
            is MediaAttachment.Video -> attachment.mimeType
            is MediaAttachment.Audio -> attachment.mimeType
            is MediaAttachment.VoiceNote -> attachment.mimeType
            is MediaAttachment.Document -> attachment.mimeType
        }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val mediaDirectory = File(appContext.filesDir, "chat_media").apply { mkdirs() }
        File(mediaDirectory, fileName).writeBytes(bytes)
        return JSONObject().apply {
            put("fileName", fileName)
            put("mimeType", mimeType)
            put("type", when (attachment) {
                is MediaAttachment.Image -> "image"
                is MediaAttachment.Video -> "video"
                is MediaAttachment.Audio -> "audio"
                is MediaAttachment.VoiceNote -> "voice"
                is MediaAttachment.Document -> "document"
            })
            put("displayName", attachment.fileName)
            put("durationMs", when (attachment) {
                is MediaAttachment.Audio -> attachment.durationMs
                is MediaAttachment.Video -> 0L
                is MediaAttachment.Image -> 0L
                is MediaAttachment.VoiceNote -> attachment.durationMs
                is MediaAttachment.Document -> 0L
            })
            if (attachment is MediaAttachment.VoiceNote) {
                put("waveform", JSONArray(attachment.waveform))
            }
        }
    }

    private fun loadAttachment(messageId: String, metadata: JSONObject): MediaAttachment? {
        val fileName = metadata.optString("fileName")
        val file = File(appContext.filesDir, "chat_media/$fileName")
            .takeIf(File::exists) ?: File(appContext.filesDir, fileName)
        if (fileName.isEmpty() || !file.exists()) return null
        val uri = Uri.fromFile(file)
        val base64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        val mimeType = metadata.optString("mimeType", "application/octet-stream")
        val durationMs = metadata.optLong("durationMs", 0L)
        val displayName = metadata.optString("displayName", fileName)
        return when (metadata.optString("type")) {
            "image" -> MediaAttachment.Image(uri, base64, mimeType, displayName)
            "video" -> MediaAttachment.Video(uri, base64, mimeType, displayName)
            "voice" -> {
                val waveformJson = metadata.optJSONArray("waveform")
                val waveform = buildList {
                    if (waveformJson != null) for (index in 0 until waveformJson.length()) {
                        add(waveformJson.optDouble(index, 0.0).toFloat())
                    }
                }
                MediaAttachment.VoiceNote(uri, base64, mimeType, durationMs, waveform, displayName)
            }
            "audio" -> MediaAttachment.Audio(uri, base64, mimeType, durationMs, displayName)
            "document" -> MediaAttachment.Document(uri, base64, mimeType, displayName)
            else -> null
        }
    }

    private fun loadPersistedMessages(): List<ChatMessage> {
        val raw = prefs.getString(PREF_MESSAGES, null) ?: return emptyList()
        return runCatching {
            val json = JSONArray(raw)
            buildList {
                for (index in 0 until json.length()) {
                    val item = json.getJSONObject(index)
                    add(ChatMessage(
                        id = item.getString("id"),
                        sender = Sender.valueOf(item.getString("sender")),
                        text = item.optString("text"),
                        status = runCatching { MessageStatus.valueOf(item.optString("status")) }
                            .getOrDefault(MessageStatus.SENT)
                            .let { if (it == MessageStatus.SENDING) MessageStatus.ERROR else it },
                        timestampMs = item.optLong("timestampMs", System.currentTimeMillis()),
                        transcript = item.optString("transcript").ifEmpty { null },
                        quotedText = item.optString("quotedText").ifEmpty { null },
                        quotedSender = item.optString("quotedSender").takeIf { it.isNotEmpty() }
                            ?.let { runCatching { Sender.valueOf(it) }.getOrNull() },
                        inReplyToMessageId = item.optString("inReplyToMessageId").ifEmpty { null },
                        outboxId = item.optLong("outboxId", -1L).takeIf { it > 0L },
                        voiceBase64 = item.optString("voiceFileName").takeIf { it.isNotEmpty() }?.let { fileName ->
                            File(appContext.filesDir, fileName).takeIf { it.exists() }?.let { file ->
                                Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
                            }
                        },
                        voiceMimeType = item.optString("voiceMimeType").ifEmpty { null },
                        attachment = item.optJSONObject("attachment")?.let { loadAttachment(item.getString("id"), it) },
                        arisAttachments = buildList {
                            val generated = item.optJSONArray("arisAttachments")
                            if (generated != null) for (attachmentIndex in 0 until generated.length()) {
                                loadAttachment(item.getString("id"), generated.getJSONObject(attachmentIndex))?.let { add(it) }
                            }
                        },
                    ))
                }
            }
        }.getOrDefault(emptyList())
    }

    private fun updateMessageStatus(id: String, status: MessageStatus) {
        updateMessage(id) { it.copy(status = status) }
    }

    private fun addSystemMessage(text: String) {
        appendMessage(ChatMessage(id = UUID.randomUUID().toString(), sender = Sender.ARIS, text = text))
    }

    private fun pcmToWav(pcmBytes: ByteArray, sampleRate: Int, channels: Int, bitDepth: Int): ByteArray {
        val dataSize = pcmBytes.size
        val header = ByteArray(44)
        val byteRate = sampleRate * channels * (bitDepth / 8)
        val blockAlign = channels * (bitDepth / 8)
        fun intToBytes(v: Int) = byteArrayOf(
            (v and 0xFF).toByte(), (v shr 8 and 0xFF).toByte(),
            (v shr 16 and 0xFF).toByte(), (v shr 24 and 0xFF).toByte()
        )
        fun shortToBytes(v: Int) = byteArrayOf((v and 0xFF).toByte(), (v shr 8 and 0xFF).toByte())
        "RIFF".toByteArray().copyInto(header, 0)
        intToBytes(36 + dataSize).copyInto(header, 4)
        "WAVE".toByteArray().copyInto(header, 8)
        "fmt ".toByteArray().copyInto(header, 12)
        intToBytes(16).copyInto(header, 16)
        shortToBytes(1).copyInto(header, 20)         // PCM
        shortToBytes(channels).copyInto(header, 22)
        intToBytes(sampleRate).copyInto(header, 24)
        intToBytes(byteRate).copyInto(header, 28)
        shortToBytes(blockAlign).copyInto(header, 32)
        shortToBytes(bitDepth).copyInto(header, 34)
        "data".toByteArray().copyInto(header, 36)
        intToBytes(dataSize).copyInto(header, 40)
        return header + pcmBytes
    }

    override fun onCleared() {
        super.onCleared()
        recordingJob?.cancel()
        audioRecord?.release()
        mediaPlayer?.release()
    }
}
