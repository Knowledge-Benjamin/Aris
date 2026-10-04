import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ArisApiClient.kt'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

poll_func = """
    // Polling app-bound outbox messages
    suspend fun pollOutbox(): List<JSONObject> = withContext(Dispatchers.IO) {
        val url = URL("$baseUrl/api/aris/outbox")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "GET"
            conn.setRequestProperty("Authorization", "Bearer $authToken")
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000

            if (conn.responseCode == 200) {
                val responseString = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(responseString)
                val messagesArray = json.optJSONArray("messages") ?: return@withContext emptyList()
                val result = mutableListOf<JSONObject>()
                for (i in 0 until messagesArray.length()) {
                    result.add(messagesArray.getJSONObject(i))
                }
                return@withContext result
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to poll outbox", e)
        } finally {
            conn.disconnect()
        }
        emptyList()
    }
"""

if 'pollOutbox' not in text:
    last_brace = text.rfind('}')
    text = text[:last_brace] + poll_func + text[last_brace:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('Added pollOutbox to ArisApiClient.kt')
else:
    print('pollOutbox already exists')
