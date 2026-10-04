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
import com.example.ariscompanion.ServerConfig
import com.example.ariscompanion.PhoneLocationProvider
import com.example.ariscompanion.VisionState
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "ChatViewModel"
private const val PREF_AUTH_TOKEN = "auth_token"
private const val PREF_SERVER_URL = ServerConfig.SERVER_URL_PREFERENCE
private const val PREF_EMAIL = "email"
private const val PREF_MESSAGES = "chat_messages"
private const val SESSION_ID = "aris-android-chat"

// Amplitudes to capture for waveform visualisation
private const val WAVEFORM_SAMPLES = 40

class ChatViewModel(private val appContext: Context) : ViewModel() {

    private val prefs: SharedPreferences = appContext.getSharedPreferences(ServerConfig.PREFERENCES_NAME, Context.MODE_PRIVATE)

    private val _uiState = MutableStateFlow(
        ChatUiState(
            messages = loadPersistedMessages(),
            serverUrl = ServerConfig.savedBaseUrl(appContext),
            email = prefs.getString(PREF_EMAIL, "") ?: "",
            isAuthenticated = prefs.getString(PREF_AUTH_TOKEN, null) != null,
        )
    )
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    private var outboxPollJob: Job? = null
    private var authToken: String? = prefs.getString(PREF_AUTH_TOKEN, null)

    init {
        if (authToken != null) {
            startOutboxPolling()
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
            val type = msg.optString("messageType", "")
            val content = msg.optString("body", msg.optString("content", ""))
            val mediaDriveRef = msg.optString("mediaDriveRef", "")
            val quoted = msg.optJSONObject("quotedMessage")
            val quotedText = quoted?.optString("text")?.ifEmpty { quoted.optString("body") }

            Log.i(TAG, "Outbox message id=${msg.optLong("id", -1)} type=$type hasMedia=${mediaDriveRef.isNotEmpty()}")

            var attachment: MediaAttachment? = null
            if (mediaDriveRef.startsWith("drive:")) {
                val fileId = mediaDriveRef.removePrefix("drive:")
                val downloadUrl = "https://drive.google.com/uc?export=download&id=$fileId"
                try {
                    val bytes = withContext(Dispatchers.IO) {
                        java.net.URL(downloadUrl).readBytes()
                    }
                    val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.DEFAULT)
                    val tempFile = File(appContext.cacheDir, "$fileId.mp3")
                    tempFile.writeBytes(bytes)
                    attachment = MediaAttachment.Audio(
                        uri = Uri.fromFile(tempFile),
                        base64 = base64,
                        mimeType = "audio/mpeg"
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to download drive audio", e)
                }
            }

            if (type == "audio" && attachment == null) {
                Log.e(TAG, "Skipping undeliverable audio outbox message; ref=$mediaDriveRef")
                continue
            }

            _uiState.update { state ->
                state.copy(messages = state.messages + ChatMessage(
                    id = java.util.UUID.randomUUID().toString(),
                    sender = Sender.ARIS,
                    text = content,
                    attachment = attachment,
                    quotedText = quotedText?.ifEmpty { null },
                    quotedSender = Sender.USER,
                )).also { persistMessages(it.messages) }
            }
        }
    }

    private val client: ArisApiClient?
        get() = authToken?.let { ArisApiClient(_uiState.value.serverUrl, it) }

    private suspend fun syncPhoneLocation() {
        val token = authToken ?: return
        try {
            PhoneLocationProvider.uploadCurrentLocation(appContext, _uiState.value.serverUrl, token)
        } catch (e: Exception) {
            Log.w(TAG, "Phone location could not be shared; the server will use its network-location fallback", e)
        }
    }

    // Voice recording state
    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null
    private var recordedBytes: ByteArrayOutputStream? = null
    private var recordingStartMs: Long = 0L
    private val amplitudeBuffer = mutableListOf<Float>()

    // Audio playback
    private var mediaPlayer: MediaPlayer? = null
    private var playingMessageId: String? = null
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
            is ChatUiEvent.ClearReply -> _uiState.update { it.copy(replyingTo = null) }
        }
    }

    // ── Login ────────────────────────────────────────────────────────────────

    private fun doLogin(serverUrl: String, email: String, password: String) {
        val normalizedServerUrl = ServerConfig.normalizeBaseUrl(serverUrl)
        _uiState.update { it.copy(isLoggingIn = true, loginError = null) }
        viewModelScope.launch {
            try {
                val result = ArisApiClient.login(normalizedServerUrl, email, password)
                authToken = result.token
                prefs.edit()
                    .putString(PREF_AUTH_TOKEN, result.token)
                    .putString(PREF_SERVER_URL, normalizedServerUrl)
                    .putString(PREF_EMAIL, email)
                    .apply()
                _uiState.update {
                    it.copy(
                        isLoggingIn = false,
                        isAuthenticated = true,
                        serverUrl = normalizedServerUrl,
                        email = email,
                        loginError = null,
                    )
                }
                addSystemMessage("Connected as ${result.email}. Say hi to Aris! 👋")
            } catch (e: Exception) {
                Log.e(TAG, "Login failed", e)
                _uiState.update { it.copy(isLoggingIn = false, loginError = e.message ?: "Login failed") }
            }
        }
    }

    // ── Text message ─────────────────────────────────────────────────────────

    private fun sendTextMessage(text: String) {
        val msgId = UUID.randomUUID().toString()
        val replyingTo = _uiState.value.replyingTo
        val userMsg = ChatMessage(id = msgId, sender = Sender.USER, text = text, status = MessageStatus.SENDING)
        appendMessage(userMsg)
        _uiState.update { it.copy(replyingTo = null) }

        viewModelScope.launch {
            try {
                updateMessageStatus(msgId, MessageStatus.SENT)
                val arisId = UUID.randomUUID().toString()
                val placeholder = ChatMessage(id = arisId, sender = Sender.ARIS, text = "", status = MessageStatus.SENDING)
                appendMessage(placeholder)

                val visionFrame = if (VisionState.isCapturing.value) {
                    withContext(Dispatchers.IO) {
                        VisionState.captureService?.captureCurrentFrameBase64()
                    }?.let { frame -> mapOf("mimeType" to "image/jpeg", "dataBase64" to frame) }
                } else {
                    null
                }

                var finalResult: ArisChatResult? = null
                syncPhoneLocation()
                client?.chatStream(
                    text,
                    SESSION_ID,
                    mediaData = visionFrame,
                    replyContext = replyingTo?.text,
                ) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "heartbeat" -> { /* keep alive */ }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> {
                            _uiState.update { it.copy(progressMessage = null) }
                            updateMessage(arisId) { it.copy(text = "⚠️ ${event.error ?: "Unknown error"}", status = MessageStatus.ERROR) }
                        }
                    }
                }

                finalResult?.let { result ->
                    val pending = result.pendingAction?.let { pa ->
                        PendingAction(
                            tool = pa["tool"].toString(),
                            payload = pa["payload"] as? Map<String, Any?> ?: emptyMap()
                        )
                    }
                    val attachments = result.mediaAttachments?.mapNotNull { att ->
                        val mime = att["mimeType"] ?: return@mapNotNull null
                        val base64 = att["base64"] ?: return@mapNotNull null
                        if (mime.startsWith("audio/")) {
                            MediaAttachment.Audio(Uri.EMPTY, base64, mime)
                        } else if (mime.startsWith("image/")) {
                            MediaAttachment.Image(Uri.EMPTY, base64, mime)
                        } else null
                    } ?: emptyList()
                    
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
                Log.e(TAG, "sendTextMessage failed", e)
                updateMessageStatus(msgId, MessageStatus.ERROR)
                _uiState.update { it.copy(progressMessage = null) }
                appendMessage(ChatMessage(id = UUID.randomUUID().toString(), sender = Sender.ARIS, text = "⚠️ ${e.message}", status = MessageStatus.ERROR))
            }
        }
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

    private fun sendVoiceNoteMessage(attachment: MediaAttachment.VoiceNote) {
        val msgId = UUID.randomUUID().toString()
        val userMsg = ChatMessage(
            id = msgId,
            sender = Sender.USER,
            attachment = attachment,
            status = MessageStatus.SENDING
        )
        appendMessage(userMsg)

        viewModelScope.launch {
            try {
                updateMessageStatus(msgId, MessageStatus.SENT)
                val arisId = UUID.randomUUID().toString()
                appendMessage(ChatMessage(id = arisId, sender = Sender.ARIS, text = "", status = MessageStatus.SENDING))
                _uiState.update { it.copy(progressMessage = "🎧 Transcribing voice note…") }

                val result = client?.sendVoice(attachment.base64, attachment.mimeType, SESSION_ID)
                    ?: throw Exception("Not connected")

                _uiState.update { it.copy(progressMessage = null) }
                updateMessage(arisId) {
                    it.copy(
                        text = result.arisReply,
                        transcript = result.transcript,
                        voiceBase64 = result.voiceBase64,
                        voiceMimeType = result.voiceMimeType,
                        status = MessageStatus.SENT,
                        memoryUpdates = result.memoryUpdates,
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Voice note send failed", e)
                _uiState.update { it.copy(progressMessage = null) }
                updateMessageStatus(msgId, MessageStatus.ERROR)
            }
        }
    }

    // ── Media (image / video / audio file) ───────────────────────────────────

    private fun sendMediaMessage(attachment: MediaAttachment, caption: String) {
        val msgId = UUID.randomUUID().toString()
        val userMsg = ChatMessage(id = msgId, sender = Sender.USER, text = caption, attachment = attachment, status = MessageStatus.SENDING)
        appendMessage(userMsg)

        viewModelScope.launch {
            try {
                updateMessageStatus(msgId, MessageStatus.SENT)
                val arisId = UUID.randomUUID().toString()
                appendMessage(ChatMessage(id = arisId, sender = Sender.ARIS, text = "", status = MessageStatus.SENDING))
                _uiState.update { it.copy(progressMessage = "📎 Processing attachment…") }

                val (base64, mime) = when (attachment) {
                    is MediaAttachment.Image -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.Video -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.Audio -> attachment.base64 to attachment.mimeType
                    is MediaAttachment.VoiceNote -> attachment.base64 to attachment.mimeType
                }

                var finalResult: ArisChatResult? = null
                client?.sendMediaChat(caption, base64, mime, SESSION_ID) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> {
                            _uiState.update { it.copy(progressMessage = null) }
                            updateMessage(arisId) { it.copy(text = "⚠️ ${event.error}", status = MessageStatus.ERROR) }
                        }
                    }
                }
                finalResult?.let { result ->
                    updateMessage(arisId) {
                        it.copy(text = result.arisReply, status = MessageStatus.SENT, memoryUpdates = result.memoryUpdates)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Media send failed", e)
                _uiState.update { it.copy(progressMessage = null) }
                updateMessageStatus(msgId, MessageStatus.ERROR)
            }
        }
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
            try {
                val arisId = UUID.randomUUID().toString()
                appendMessage(ChatMessage(id = arisId, sender = Sender.ARIS, text = "", status = MessageStatus.SENDING))
                var finalResult: ArisChatResult? = null
                syncPhoneLocation()
                client?.chatStream("approved", SESSION_ID, approvedActionPayload) { event ->
                    when (event.type) {
                        "progress" -> _uiState.update { it.copy(progressMessage = event.message) }
                        "complete" -> {
                            finalResult = event.data
                            _uiState.update { it.copy(progressMessage = null) }
                        }
                        "error" -> {
                            _uiState.update { it.copy(progressMessage = null) }
                            updateMessage(arisId) { it.copy(text = "⚠️ ${event.error}", status = MessageStatus.ERROR) }
                        }
                    }
                }
                finalResult?.let { result ->
                    updateMessage(arisId) { it.copy(text = result.arisReply, status = MessageStatus.SENT, memoryUpdates = result.memoryUpdates) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Approval send failed", e)
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

        // Stop any current playback
        if (playingMessageId == messageId) {
            mediaPlayer?.stop()
            mediaPlayer?.release()
            mediaPlayer = null
            playingMessageId = null
            return
        }
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null

        viewModelScope.launch(Dispatchers.IO) {
            try {
                val bytes = Base64.decode(voiceBase64, Base64.DEFAULT)
                val file = File(appContext.cacheDir, "aris_voice_$messageId.wav")
                FileOutputStream(file).use { it.write(bytes) }

                withContext(Dispatchers.Main) {
                    playingMessageId = messageId
                    mediaPlayer = MediaPlayer().apply {
                        setAudioAttributes(
                            AudioAttributes.Builder()
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .build()
                        )
                        setDataSource(file.absolutePath)
                        prepare()
                        start()
                        beginPlaybackTracking(messageId)
                        setOnCompletionListener {
                            stopPlayback()
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Voice playback failed", e)
                playingMessageId = null
            }
        }
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

        val playKey = "${messageId}_att_$attachmentIndex"
        if (playingMessageId == playKey) {
            stopPlayback()
            return
        }
        stopPlayback()

        viewModelScope.launch(Dispatchers.IO) {
            try {
                val ext = when {
                    mime.contains("ogg") -> "ogg"
                    mime.contains("mp3") || mime.contains("mpeg") -> "mp3"
                    else -> "wav"
                }
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val file = File(appContext.cacheDir, "aris_att_${messageId}_$attachmentIndex.$ext")
                FileOutputStream(file).use { it.write(bytes) }
                withContext(Dispatchers.Main) {
                    playingMessageId = playKey
                    mediaPlayer = MediaPlayer().apply {
                        setAudioAttributes(
                            AudioAttributes.Builder()
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .build()
                        )
                        setDataSource(file.absolutePath)
                        prepare()
                        start()
                        beginPlaybackTracking(playKey)
                        setOnCompletionListener {
                            stopPlayback()
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Attachment playback failed", e)
                playingMessageId = null
            }
        }
    }

    private fun beginPlaybackTracking(key: String) {
        val player = mediaPlayer ?: return
        playbackJob?.cancel()
        _uiState.update {
            it.copy(
                playbackKey = key,
                playbackPositionMs = 0L,
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
        _uiState.update { it.copy(playbackKey = null, playbackPositionMs = 0L, playbackDurationMs = 0L, isPlaybackActive = false) }
    }

    private fun seekAudio(messageId: String, attachmentIndex: Int, positionMs: Long) {
        val key = if (attachmentIndex < 0) messageId else "${messageId}_att_$attachmentIndex"
        if (playingMessageId == key) {
            mediaPlayer?.seekTo(positionMs.toInt().coerceIn(0, mediaPlayer?.duration ?: 0))
            _uiState.update { it.copy(playbackPositionMs = positionMs) }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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
        }
        val mimeType = when (attachment) {
            is MediaAttachment.Image -> attachment.mimeType
            is MediaAttachment.Video -> attachment.mimeType
            is MediaAttachment.Audio -> attachment.mimeType
            is MediaAttachment.VoiceNote -> attachment.mimeType
        }
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        File(appContext.filesDir, fileName).writeBytes(bytes)
        return JSONObject().apply {
            put("fileName", fileName)
            put("mimeType", mimeType)
            put("type", when (attachment) {
                is MediaAttachment.Image -> "image"
                is MediaAttachment.Video -> "video"
                is MediaAttachment.Audio -> "audio"
                is MediaAttachment.VoiceNote -> "voice"
            })
            put("durationMs", when (attachment) {
                is MediaAttachment.Audio -> attachment.durationMs
                is MediaAttachment.Video -> 0L
                is MediaAttachment.Image -> 0L
                is MediaAttachment.VoiceNote -> attachment.durationMs
            })
            if (attachment is MediaAttachment.VoiceNote) {
                put("waveform", JSONArray(attachment.waveform))
            }
        }
    }

    private fun loadAttachment(messageId: String, metadata: JSONObject): MediaAttachment? {
        val fileName = metadata.optString("fileName")
        val file = File(appContext.filesDir, fileName)
        if (fileName.isEmpty() || !file.exists()) return null
        val uri = Uri.fromFile(file)
        val base64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
        val mimeType = metadata.optString("mimeType", "application/octet-stream")
        val durationMs = metadata.optLong("durationMs", 0L)
        return when (metadata.optString("type")) {
            "image" -> MediaAttachment.Image(uri, base64, mimeType)
            "video" -> MediaAttachment.Video(uri, base64, mimeType)
            "voice" -> {
                val waveformJson = metadata.optJSONArray("waveform")
                val waveform = buildList {
                    if (waveformJson != null) for (index in 0 until waveformJson.length()) {
                        add(waveformJson.optDouble(index, 0.0).toFloat())
                    }
                }
                MediaAttachment.VoiceNote(uri, base64, mimeType, durationMs, waveform)
            }
            "audio" -> MediaAttachment.Audio(uri, base64, mimeType, durationMs)
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
                            .getOrDefault(MessageStatus.SENT),
                        timestampMs = item.optLong("timestampMs", System.currentTimeMillis()),
                        transcript = item.optString("transcript").ifEmpty { null },
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
