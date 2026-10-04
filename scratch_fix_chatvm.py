import re

path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ChatViewModel.kt'

with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add org.json.JSONObject
if 'import org.json.JSONObject' not in text:
    text = text.replace('import java.util.UUID', 'import java.util.UUID\nimport org.json.JSONObject')

# 2. Replace the broken handleOutboxMessages
bad_handle = r'private suspend fun handleOutboxMessages\(msgs: List<JSONObject>\) \{[\s\S]*?\}\s*\}'

good_handle = """private suspend fun handleOutboxMessages(msgs: List<JSONObject>) {
        for (msg in msgs) {
            val type = msg.optString("messageType", "")
            val content = msg.optString("content", "")
            val mediaDriveRef = msg.optString("mediaDriveRef", "")

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

            _uiState.update { state ->
                state.copy(
                    messages = state.messages + ChatMessage(
                        id = java.util.UUID.randomUUID().toString(),
                        sender = Sender.ARIS,
                        text = content,
                        attachment = attachment
                    )
                )
            }
        }
    }"""

text = re.sub(bad_handle, good_handle, text)

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print("Fixed ChatViewModel.kt!")
