import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\server\src\routes\aris.ts'
with open(path, 'rb') as f:
    raw = f.read()
text = raw.decode('utf-8', errors='replace')

# Add import
if 'pollAppOutbox' not in text:
    text = text.replace(
        'import { arisChat, arisChatStream, arisVoice, arisWelcome, companionAudio } from "../controllers/arisController";',
        'import { arisChat, arisChatStream, arisVoice, arisWelcome, companionAudio } from "../controllers/arisController";\r\nimport { pollAppOutbox } from "../controllers/appOutboxController";'
    )

# Add route
if '/outbox' not in text:
    text = text.replace(
        'router.post("/chat", authenticate, arisChat);',
        'router.get("/outbox", authenticate, pollAppOutbox);\r\nrouter.post("/chat", authenticate, arisChat);'
    )

with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('aris.ts updated with /outbox route')
