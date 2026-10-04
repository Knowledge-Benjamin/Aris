import sys

path = r'c:\Users\TempAdmin\Desktop\Aris\android-companion\app\build.gradle.kts'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

# Comment out jvmToolchain(17) to allow Gradle to use Java 25
text = text.replace('jvmToolchain(17)', '// jvmToolchain(17)')

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print("Commented out jvmToolchain(17)")
