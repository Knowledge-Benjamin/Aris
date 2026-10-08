package com.example.ariscompanion.ui.chat

import android.net.Uri

enum class Sender {
    USER,
    ARIS,
}

enum class MessageStatus {
    SENDING,
    SENT,
    ERROR,
}

enum class ServerHealthStatus {
    UNKNOWN,
    CHECKING,
    HEALTHY,
    RESPONDING,
    UNREACHABLE,
}

sealed class MediaAttachment {
    abstract val uri: Uri
    abstract val base64: String
    abstract val mimeType: String
    abstract val fileName: String

    data class Image(
        override val uri: Uri,
        override val base64: String,
        override val mimeType: String,
        override val fileName: String = "image",
    ) : MediaAttachment()

    data class Video(
        override val uri: Uri,
        override val base64: String,
        override val mimeType: String,
        override val fileName: String = "video",
    ) : MediaAttachment()

    data class Audio(
        override val uri: Uri,
        override val base64: String,
        override val mimeType: String,
        val durationMs: Long = 0L,
        override val fileName: String = "audio",
    ) : MediaAttachment()

    data class VoiceNote(
        override val uri: Uri,
        override val base64: String,
        override val mimeType: String,
        val durationMs: Long,
        val waveform: List<Float>,
        override val fileName: String = "voice-note",
    ) : MediaAttachment()

    data class Document(
        override val uri: Uri,
        override val base64: String,
        override val mimeType: String,
        override val fileName: String,
    ) : MediaAttachment()
}

data class PendingAction(
    val tool: String,
    val payload: Map<String, Any?> = emptyMap(),
)

data class ChatMessage(
    val id: String,
    val sender: Sender,
    val text: String = "",
    val status: MessageStatus = MessageStatus.SENT,
    val timestampMs: Long = System.currentTimeMillis(),
    val transcript: String? = null,
    val voiceBase64: String? = null,
    val voiceMimeType: String? = null,
    val attachment: MediaAttachment? = null,
    val arisAttachments: List<MediaAttachment> = emptyList(),
    val memoryUpdates: List<String> = emptyList(),
    val pendingAction: PendingAction? = null,
    val quotedText: String? = null,
    val quotedSender: Sender? = null,
    val inReplyToMessageId: String? = null,
    val outboxId: Long? = null,
)

fun ChatMessage.replySummary(): String {
    val media = listOfNotNull(attachment) + arisAttachments
    val attachmentSummary = media.take(3).joinToString("\n") { it.replyAttachmentSummary() }
        .takeIf(String::isNotBlank)
    return listOfNotNull(
        text.takeIf(String::isNotBlank),
        transcript?.takeIf(String::isNotBlank)?.let { "Transcript: $it" },
        attachmentSummary,
    ).joinToString("\n").ifBlank { "Message" }.take(4000)
}

private fun MediaAttachment.replyAttachmentSummary(): String = when (this) {
    is MediaAttachment.Image -> "Photo: $fileName"
    is MediaAttachment.Video -> "Video: $fileName"
    is MediaAttachment.Audio -> "Audio: $fileName"
    is MediaAttachment.VoiceNote -> "Voice note"
    is MediaAttachment.Document -> "Document: $fileName"
}

fun ChatMessage.replyContext(): String =
    "${if (sender == Sender.USER) "User" else "Aris"} message: ${replySummary()}"

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    val serverUrl: String = "",
    val email: String = "",
    val isAuthenticated: Boolean = false,
    val isLoggingIn: Boolean = false,
    val loginError: String? = null,
    val inputText: String = "",
    val stagedAttachment: MediaAttachment? = null,
    val progressMessage: String? = null,
    val serverHealthStatus: ServerHealthStatus = ServerHealthStatus.UNKNOWN,
    val serverHealthMessage: String = "Tap to check server",
    val isRecordingVoice: Boolean = false,
    val recordingDurationMs: Long = 0L,
    val recordingAmplitudes: List<Float> = emptyList(),
    val replyingTo: ChatMessage? = null,
    val playbackKey: String? = null,
    val playbackPositionMs: Long = 0L,
    val playbackDurationMs: Long = 0L,
    val isPlaybackActive: Boolean = false,
)

sealed interface ChatUiEvent {
    data class Login(val serverUrl: String, val email: String, val password: String) : ChatUiEvent
    data class UpdateInput(val text: String) : ChatUiEvent
    data class SendText(val text: String) : ChatUiEvent
    data object StartRecording : ChatUiEvent
    data object StopRecording : ChatUiEvent
    data object CancelRecording : ChatUiEvent
    data class SendVoiceNote(val attachment: MediaAttachment.VoiceNote) : ChatUiEvent
    data class SendMedia(val attachment: MediaAttachment, val caption: String = "") : ChatUiEvent
    data class StageAttachment(val attachment: MediaAttachment) : ChatUiEvent
    data object ClearStagedAttachment : ChatUiEvent
    data class ApproveAction(val messageId: String) : ChatUiEvent
    data class DenyAction(val messageId: String) : ChatUiEvent
    data class PlayVoice(val messageId: String) : ChatUiEvent
    data class PlayAttachment(val messageId: String, val attachmentIndex: Int) : ChatUiEvent
    data class SeekAudio(val messageId: String, val attachmentIndex: Int, val positionMs: Long) : ChatUiEvent
    data class ReplyToMessage(val messageId: String) : ChatUiEvent
    data class RetrySend(val messageId: String) : ChatUiEvent
    data object CheckServerStatus : ChatUiEvent
    data object ClearReply : ChatUiEvent
}

data class LoginResult(
    val token: String,
    val email: String,
)

data class ServerHealthResult(
    val healthy: Boolean,
    val httpStatus: Int,
    val elapsedMs: Long,
    val message: String,
)

data class ArisChatResult(
    val arisReply: String,
    val memoryUpdates: List<String> = emptyList(),
    val status: String? = null,
    val pendingAction: Map<String, Any?>? = null,
    val mediaAttachments: List<Map<String, String>>? = null,
)

data class VoiceChatResult(
    val arisReply: String,
    val memoryUpdates: List<String> = emptyList(),
    val voiceBase64: String? = null,
    val voiceMimeType: String? = null,
    val voiceError: String? = null,
)

data class ChatStreamEvent(
    val type: String,
    val message: String? = null,
    val data: ArisChatResult? = null,
    val error: String? = null,
)
