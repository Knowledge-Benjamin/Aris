import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\src\main\java\com\example\ariscompanion\ui\chat\ChatViewModel.kt'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

# Replace the default URL
text = text.replace('"http://10.0.2.2:4000"', '"https://impose-persuaded-unjustly.ngrok-free.dev"')

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print("Updated server URL in ChatViewModel.kt")
