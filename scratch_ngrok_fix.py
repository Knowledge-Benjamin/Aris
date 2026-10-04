import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\server\src\server.ts'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

# Add ngrok.kill() before ngrok.connect()
if 'await ngrok.kill()' not in text:
    text = text.replace(
        'const url = await ngrok.connect({',
        'await ngrok.kill();\n      const url = await ngrok.connect({'
    )

    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print("Added ngrok.kill() to server.ts")
else:
    print("ngrok.kill() already exists")
