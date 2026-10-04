import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ChatViewModel.kt'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add poll job property
if 'private var outboxPollJob' not in text:
    text = text.replace(
        'private var authToken: String?',
        'private var outboxPollJob: Job? = null\n    private var authToken: String?'
    )

# 2. Add init block (if missing) or append to it
if 'init {' not in text:
    text = text.replace(
        'private var authToken: String? = prefs.getString(PREF_AUTH_TOKEN, null)',
        'private var authToken: String? = prefs.getString(PREF_AUTH_TOKEN, null)\n\n    init {\n        if (authToken != null) {\n            startOutboxPolling()\n        }\n    }'
    )
elif 'startOutboxPolling()' not in text:
    # Append to existing init
    pass # I'll assume it doesn't have an init based on previous grep

# 3. Add the polling loop method
poll_methods = """
    private fun startOutboxPolling() {
        outboxPollJob?.cancel()
        outboxPollJob = viewModelScope.launch {
            while (isActive) {
                try {
                    val messages = client?.pollOutbox() ?: emptyList()
                    if (messages.isNotEmpty()) {
                        handleOutboxMessages(messages)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to poll outbox", e)
                }
                delay(10_000) // Poll every 10s
            }
        }
    }

    private suspend fun handleOutboxMessages(msgs: List<org.json.JSONObject>) {
        val newChatMessages = mutableListOf<ChatMessage>()
        for (msg in msgs) {
            val type = msg.optString("messageType")
            val body = msg.optString("body")
            val driveRef = msg.optString("mediaDriveRef")
            val mimeType = msg.optString("mediaMimeType")
            
            var text = ""
            val arisAttachments = mutableListOf<MediaAttachment>()

            if (type == "text") {
                text = body
            } else if (type == "audio" && driveRef.startsWith("drive:")) {
                text = if (body.isNotEmpty()) body else "🎤 Voice Note / Podcast"
                val fileId = driveRef.removePrefix("drive:")
                val downloadUrl = "https://drive.google.com/uc?export=download&id=$fileId"
                
                // Download the file bytes to Base64 to integrate seamlessly with existing Aris player
                try {
                    val base64 = withContext(Dispatchers.IO) {
                        val conn = java.net.URL(downloadUrl).openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = "GET"
                        conn.connectTimeout = 15_000
                        conn.readTimeout = 60_000 // Podcasts can be large
                        if (conn.responseCode in 200..299) {
                            val bytes = conn.inputStream.readBytes()
                            android.util.Base64.encodeToString(bytes, android.util.Base64.DEFAULT)
                        } else null
                    }
                    if (base64 != null) {
                        arisAttachments.add(MediaAttachment.Audio(
                            uri = Uri.EMPTY,
                            base64 = base64,
                            mimeType = mimeType.ifEmpty { "audio/mpeg" }
                        ))
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to download outbox audio $fileId", e)
                }
            }
            
            newChatMessages.add(ChatMessage(
                id = UUID.randomUUID().toString(),
                sender = Sender.ARIS,
                text = text,
                arisAttachments = arisAttachments
            ))
        }

        if (newChatMessages.isNotEmpty()) {
            _uiState.update { it.copy(messages = it.messages + newChatMessages) }
        }
    }
"""

if 'startOutboxPolling' not in text:
    last_brace = text.rfind('}')
    text = text[:last_brace] + poll_methods + text[last_brace:]

# 4. Start polling on successful login
if 'authToken = result.token' in text and 'startOutboxPolling()' not in text:
    text = text.replace(
        'authToken = result.token',
        'authToken = result.token\n                startOutboxPolling()'
    )

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print('Updated ChatViewModel.kt')
