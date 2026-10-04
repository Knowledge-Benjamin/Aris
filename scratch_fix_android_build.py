import os
import re

# 1. Fix strings.xml (accessibility_service_description)
strings_xml_path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\res\values\strings.xml'
with open(strings_xml_path, 'r', encoding='utf-8') as f:
    strings_content = f.read()

if 'accessibility_service_description' not in strings_content:
    strings_content = strings_content.replace('</resources>', '    <string name="accessibility_service_description">Aris Companion Accessibility Service</string>\n</resources>')
    with open(strings_xml_path, 'w', encoding='utf-8') as f:
        f.write(strings_content)

# 2. Fix ChatScreen.kt (withContext, Dispatchers)
chat_screen_path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ChatScreen.kt'
with open(chat_screen_path, 'r', encoding='utf-8') as f:
    chat_screen_content = f.read()

if 'import kotlinx.coroutines.withContext' not in chat_screen_content:
    chat_screen_content = chat_screen_content.replace('import kotlinx.coroutines.launch', 'import kotlinx.coroutines.launch\nimport kotlinx.coroutines.withContext\nimport kotlinx.coroutines.Dispatchers')
    with open(chat_screen_path, 'w', encoding='utf-8') as f:
        f.write(chat_screen_content)

# 3. Fix MainScreen.kt (SineEasing -> FastOutSlowInEasing)
main_screen_path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\main\MainScreen.kt'
with open(main_screen_path, 'r', encoding='utf-8') as f:
    main_screen_content = f.read()

main_screen_content = main_screen_content.replace('SineEasing', 'LinearOutSlowInEasing')
if 'LinearOutSlowInEasing' in main_screen_content and 'import androidx.compose.animation.core.LinearOutSlowInEasing' not in main_screen_content:
    main_screen_content = main_screen_content.replace('import androidx.compose.animation.core.*', 'import androidx.compose.animation.core.*\nimport androidx.compose.animation.core.LinearOutSlowInEasing')

with open(main_screen_path, 'w', encoding='utf-8') as f:
    f.write(main_screen_content)

# 4. Fix ArisApiClient.kt (return@withContext result -> return@withContext result_list)
api_client_path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ArisApiClient.kt'
with open(api_client_path, 'r', encoding='utf-8') as f:
    api_client_content = f.read()

if 'val json = JSONObject(responseString)' in api_client_content:
    new_parsing = """val json = JSONObject(responseString)
                val messagesArray = json.optJSONArray("messages") ?: org.json.JSONArray()
                val resultList = mutableListOf<JSONObject>()
                for (i in 0 until messagesArray.length()) {
                    resultList.add(messagesArray.getJSONObject(i))
                }
                return@withContext resultList"""
    
    api_client_content = re.sub(
        r'val json = JSONObject\(responseString\)\s*return@withContext result',
        new_parsing,
        api_client_content
    )
    with open(api_client_path, 'w', encoding='utf-8') as f:
        f.write(api_client_content)

# 5. Fix ChatViewModel.kt (add startOutboxPolling & handleOutboxMessages, add missing imports)
chat_vm_path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ChatViewModel.kt'
with open(chat_vm_path, 'r', encoding='utf-8') as f:
    chat_vm_content = f.read()

imports_to_add = """
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import org.json.JSONObject
"""
if 'import kotlinx.coroutines.delay' not in chat_vm_content:
    chat_vm_content = chat_vm_content.replace('import kotlinx.coroutines.launch', 'import kotlinx.coroutines.launch' + imports_to_add)

if 'private fun startOutboxPolling()' not in chat_vm_content:
    polling_methods = """
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
            val type = msg.optString("messageType")
            val content = msg.optString("content")
            val driveUrl = msg.optString("mediaDriveUrl") // if we have logic for drive

            if (type == "audio" && driveUrl.isNotEmpty()) {
                // For now just add a placeholder audio or handle directly
                // (Assuming your UI handles drive URLs or we download it)
                addMessage(
                    ChatMessage(
                        text = content,
                        isFromUser = false,
                        attachment = MediaAttachment.Audio(driveUrl)
                    )
                )
            } else {
                addMessage(
                    ChatMessage(
                        text = content,
                        isFromUser = false
                    )
                )
            }
        }
    }
"""
    chat_vm_content = chat_vm_content.replace('private val client: ArisApiClient?', polling_methods + '\n    private val client: ArisApiClient?')
    with open(chat_vm_path, 'w', encoding='utf-8') as f:
        f.write(chat_vm_content)

print("All Android files patched!")
