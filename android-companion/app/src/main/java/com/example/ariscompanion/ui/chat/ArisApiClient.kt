package com.example.ariscompanion.ui.chat

import com.example.ariscompanion.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ArisApiClient(serverUrl: String, private val token: String) {
    private val baseUrl = ServerConfig.normalizeBaseUrl(serverUrl)

    suspend fun pollOutbox(): List<JSONObject> = withContext(Dispatchers.IO) {
        val response = request("GET", "/api/aris/outbox")
        val messages = response.optJSONArray("messages") ?: JSONArray()
        buildList {
            for (index in 0 until messages.length()) {
                messages.optJSONObject(index)?.let(::add)
            }
        }
    }

    suspend fun chatStream(
        message: String,
        sessionId: String,
        approvedAction: Map<String, Any?>? = null,
        mediaData: Map<String, String>? = null,
        replyContext: String? = null,
        onEvent: (ChatStreamEvent) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("message", message)
            .put("sessionId", sessionId)
        approvedAction?.let { body.put("approvedAction", JSONObject(it)) }
        mediaData?.let { body.put("mediaData", JSONObject(it)) }
        replyContext?.let { body.put("replyContext", it) }

        val connection = openConnection("POST", "/api/aris/chat/stream").apply {
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/x-ndjson")
            doOutput = true
        }
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val statusCode = connection.responseCode
            val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
            if (statusCode !in 200..299) {
                val errorText = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                throw httpError(statusCode, errorText)
            }
            stream?.bufferedReader()?.use { reader ->
                reader.forEachLine { rawLine ->
                    val line = rawLine.trim()
                    if (line.isEmpty()) return@forEachLine
                    val event = JSONObject(line)
                    val type = event.optString("type").ifEmpty {
                        if (event.has("error")) "error" else "unknown"
                    }
                    onEvent(
                        ChatStreamEvent(
                            type = type,
                            message = event.optString("message").ifEmpty { null },
                            data = event.optJSONObject("data")?.toArisChatResult(),
                            error = event.optString("error").ifEmpty { null },
                        )
                    )
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun sendMediaChat(
        caption: String,
        base64: String,
        mimeType: String,
        fileName: String,
        sessionId: String,
        replyContext: String? = null,
        onEvent: (ChatStreamEvent) -> Unit,
    ) {
        chatStream(
            message = caption.ifBlank { "Please analyze this attachment." },
            sessionId = sessionId,
            mediaData = mapOf("mimeType" to mimeType, "dataBase64" to base64, "fileName" to fileName),
            replyContext = replyContext,
            onEvent = onEvent,
        )
    }

    suspend fun downloadMedia(mediaId: Int): ByteArray = withContext(Dispatchers.IO) {
        downloadBinary("/api/aris/media/$mediaId/download")
    }

    suspend fun downloadDriveMedia(driveFileId: String): ByteArray = withContext(Dispatchers.IO) {
        downloadBinary("/api/aris/media/drive/${java.net.URLEncoder.encode(driveFileId, "UTF-8")}/download")
    }

    private fun downloadBinary(path: String): ByteArray {
        val connection = openConnection("GET", path)
        try {
            val statusCode = connection.responseCode
            if (statusCode !in 200..299) {
                val errorText = connection.errorStream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                throw httpError(statusCode, errorText)
            }
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun sendVoice(
        audioBase64: String,
        mimeType: String,
        sessionId: String,
        replyContext: String? = null,
    ): VoiceChatResult =
        withContext(Dispatchers.IO) {
            val result = request(
                method = "POST",
                path = "/api/aris/voice",
                body = JSONObject()
                    .put("audioBase64", audioBase64)
                    .put("mimeType", mimeType)
                    .put("sessionId", sessionId)
                    .apply { replyContext?.let { put("replyContext", it) } },
            )
            VoiceChatResult(
                arisReply = result.optString("arisReply"),
                memoryUpdates = result.optJSONArray("memoryUpdates").toStringList(),
                voiceBase64 = result.optString("voiceBase64").ifEmpty { null },
                voiceMimeType = result.optString("voiceMimeType").ifEmpty { null },
            )
        }

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val connection = openConnection(method, path)
        try {
            if (body != null) {
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val statusCode = connection.responseCode
            val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (statusCode !in 200..299) throw httpError(statusCode, responseText)
            return if (responseText.isBlank()) JSONObject() else JSONObject(responseText)
        } finally {
            connection.disconnect()
        }
    }

    private fun openConnection(method: String, path: String): HttpURLConnection =
        (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = STREAM_READ_TIMEOUT_MS
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
        }

    private fun httpError(statusCode: Int, responseText: String): IOException {
        val message = runCatching { JSONObject(responseText).optString("error") }
            .getOrNull()
            ?.takeIf(String::isNotBlank)
        return IOException(message ?: "Aris server returned HTTP $statusCode.")
    }

    private fun JSONObject.toArisChatResult(): ArisChatResult {
        val media = optJSONArray("mediaAttachments")
        val mediaAttachments = media?.let { array ->
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val attachment = mutableMapOf<String, String>()
                    listOf("mimeType", "base64", "fileName", "driveUrl", "downloadUrl").forEach { key ->
                        item.optString(key).takeIf(String::isNotBlank)?.let { attachment[key] = it }
                    }
                    item.optInt("libraryId").takeIf { it > 0 }?.let { attachment["libraryId"] = it.toString() }
                    if (attachment["mimeType"].isNullOrBlank()) continue
                    if (attachment["base64"].isNullOrBlank() && attachment["libraryId"].isNullOrBlank()) continue
                    add(attachment)
                }
            }
        }
        return ArisChatResult(
            arisReply = optString("arisReply"),
            memoryUpdates = optJSONArray("memoryUpdates").toStringList(),
            status = optString("status").ifEmpty { null },
            pendingAction = optJSONObject("pendingAction")?.toValueMap(),
            mediaAttachments = mediaAttachments,
        )
    }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return buildList {
            for (index in 0 until length()) {
                optString(index).takeIf(String::isNotBlank)?.let(::add)
            }
        }
    }

    private fun JSONObject.toValueMap(): Map<String, Any?> =
        keys().asSequence().associateWith { key ->
            when (val value = opt(key)) {
                JSONObject.NULL -> null
                is JSONObject -> value.toValueMap()
                is JSONArray -> buildList {
                    for (index in 0 until value.length()) add(value.opt(index))
                }
                else -> value
            }
        }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val STREAM_READ_TIMEOUT_MS = 0

        suspend fun login(serverUrl: String, email: String, password: String): LoginResult =
            withContext(Dispatchers.IO) {
                val normalizedBaseUrl = ServerConfig.normalizeBaseUrl(serverUrl)
                val connection = (URL("$normalizedBaseUrl/api/auth/login").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = CONNECT_TIMEOUT_MS
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Accept", "application/json")
                    doOutput = true
                }
                try {
                    val body = JSONObject().put("email", email).put("password", password)
                    connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                    val statusCode = connection.responseCode
                    val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
                    val responseText = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                    if (statusCode !in 200..299) {
                        val message = runCatching { JSONObject(responseText).optString("error") }.getOrNull()
                        throw IOException(message?.takeIf(String::isNotBlank) ?: "Login failed with HTTP $statusCode.")
                    }
                    val result = JSONObject(responseText)
                    val token = result.optString("token")
                    if (token.isBlank()) throw IOException("Login response did not include an authentication token.")
                    LoginResult(token = token, email = result.optString("email", email))
                } finally {
                    connection.disconnect()
                }
            }
    }
}
