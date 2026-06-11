import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import inquirer from "inquirer";
import {
  loginUser,
  registerUser,
  sendChatMessage,
  sendVoiceMessage,
  sendWelcomeSpeech,
  completeOnboarding,
  getGoogleAuthUrl,
  submitGoogleAuthCode,
  getGoogleStatus,
  disconnectGoogle,
} from "./api";

dotenv.config();

const baseUrl = process.env.CLI_BASE_URL || "http://localhost:4000";
const DEFAULT_GOOGLE_FALLBACK_REDIRECT_URI = "http://127.0.0.1:8000/callback";
const localCallbackRedirectUri = process.env.GOOGLE_FALLBACK_REDIRECT_URI?.trim() || DEFAULT_GOOGLE_FALLBACK_REDIRECT_URI;
const sessionId = `aris-terminal-${crypto.randomUUID()}`;

async function promptAuthAction() {
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Welcome to Aris CLI. Choose an action:",
      choices: [
        { name: "Login", value: "login" },
        { name: "Register", value: "register" },
        { name: "Quit", value: "quit" },
      ],
    },
  ]);
  return action as "login" | "register" | "quit";
}

async function promptCredentials() {
  return await inquirer.prompt([
    {
      type: "input",
      name: "email",
      message: "Email:",
    },
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
    },
  ]);
}

async function runOnboarding(authToken: string) {
  console.log("\nAris > Let me get to know you before we begin. Please answer a few quick questions.");
  const onboardingMessage = "Hello Aris, I just joined. Please ask me a few basic personal questions such as my name, pronouns, interests, preferences, and how you should address me.";
  try {
    const result = await sendChatMessage(baseUrl, onboardingMessage, authToken, sessionId);
    console.log(`\nAris > ${result.arisReply}\n`);
    if (result.memoryUpdates.length > 0) {
      console.log("Memory updated:");
      result.memoryUpdates.forEach((entry) => console.log(`- ${entry}`));
      console.log("");
    }

    await completeOnboarding(baseUrl, authToken);
  } catch (error) {
    console.error("Error during onboarding:", error instanceof Error ? error.message : error);
  }
}

async function authenticate(): Promise<{ token: string; onboardingRequired: boolean }> {
  while (true) {
    const action = await promptAuthAction();
    if (action === "quit") {
      console.log("Goodbye from Aris.");
      process.exit(0);
    }

    const { email, password } = await promptCredentials();
    try {
      const authResponse = action === "login"
        ? await loginUser(baseUrl, email, password)
        : await registerUser(baseUrl, email, password);

      console.log(`Logged in as ${authResponse.email}.`);
      return { token: authResponse.token, onboardingRequired: authResponse.onboardingRequired };
    } catch (error: any) {
      console.error("Authentication failed:", error.response?.data?.error || error.message || error);
      console.log("Please try again.\n");
    }
  }
}

function getMimeTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/wav";
  }
}

function getExtensionForMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/flac":
      return "flac";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    default:
      return "mp3";
  }
}

function playWavFile(filePath: string) {
  return new Promise<void>((resolve, reject) => {
    const powershellArgs = [
      "-NoProfile",
      "-Command",
      `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync();`,
    ];

    execFile("powershell.exe", powershellArgs, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

async function playAudioFile(filePath: string) {
  if (process.platform === "win32") {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".wav") {
      return playWavFile(filePath);
    }
    return playAudioFileWindowsNative(filePath);
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise<void>((resolve, reject) => {
    execFile(opener, [filePath], (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

function playAudioFileWindowsNative(filePath: string) {
  return new Promise<void>((resolve, reject) => {
    const safePath = filePath.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName PresentationCore,PresentationFramework; $path = (Resolve-Path -Path '${safePath}').ProviderPath; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]::new($path)); $player.Play(); while (-not $player.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 100 }; while ($player.Position -lt $player.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 100 };`;
    execFile("powershell.exe", ["-NoProfile", "-Command", script], (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

async function resolveOutputPath(rawOutputPath: string, defaultOutput: string) {
  const trimmed = rawOutputPath?.trim() ?? "";
  if (!trimmed) {
    return path.resolve(defaultOutput);
  }

  const resolved = path.resolve(trimmed);
  const endsWithSeparator = trimmed.endsWith(path.sep) || trimmed.endsWith("/") || trimmed.endsWith("\\");

  try {
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) {
      return path.join(resolved, defaultOutput);
    }
  } catch {
    // ignore missing path while still checking separators
  }

  if (endsWithSeparator) {
    return path.join(resolved, defaultOutput);
  }

  return resolved;
}

async function playWelcomePrompt(baseUrl: string, authToken: string, sessionId: string) {
  const result = await sendWelcomeSpeech(baseUrl, authToken, sessionId);
  const welcomePath = path.join(os.tmpdir(), `aris-welcome-${Date.now()}.wav`);
  await fs.writeFile(welcomePath, Buffer.from(result.voiceBase64, "base64"));

  try {
    await playWavFile(welcomePath);
  } catch (playError) {
    console.warn(`Unable to play welcome audio automatically. The file is saved at ${welcomePath}`);
  } finally {
    await fs.unlink(welcomePath).catch(() => undefined);
  }
}

async function promptGoogleMenu(): Promise<"connect" | "status" | "disconnect" | "back"> {
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Google account actions:",
      choices: [
        { name: "Connect Google account", value: "connect" },
        { name: "Show Google connection status", value: "status" },
        { name: "Disconnect Google account", value: "disconnect" },
        { name: "Back to main menu", value: "back" },
      ],
    },
  ]);
  return action as "connect" | "status" | "disconnect" | "back";
}

async function promptGoogleAuthCode(): Promise<string> {
  console.log("Please paste the exact authorization code from the browser redirect URL.");
  const { code } = await inquirer.prompt([
    {
      type: "input",
      name: "code",
      message: "Paste the Google authorization code from the browser if local callback did not complete:",
    },
  ]);

  return code?.trim() ?? "";
}

function openUrlInBrowser(url: string) {
  console.log(`[aris-cli] Opening browser URL (${process.platform}): ${url}`);
  if (process.platform === "win32") {
    const quotedUrl = `"${url.replace(/"/g, '""')}"`;
    execFile(
      "cmd.exe",
      ["/c", "start", "", quotedUrl],
      { windowsVerbatimArguments: true },
      (err) => {
        if (err) {
          console.error("[aris-cli] Failed to open browser automatically on Windows:", err);
          console.log("[aris-cli] Falling back to explorer.exe.");
          execFile("explorer.exe", [url], (explorerErr) => {
            if (explorerErr) {
              console.error("[aris-cli] explorer.exe fallback failed:", explorerErr);
              console.log("Please open the URL manually in your browser.");
            }
          });
        }
      }
    );
  } else if (process.platform === "darwin") {
    execFile("open", [url], (err) => {
      if (err) {
        console.error("[aris-cli] Failed to open browser automatically on macOS:", err);
      }
    });
  } else {
    execFile("xdg-open", [url], (err) => {
      if (err) {
        console.error("[aris-cli] Failed to open browser automatically on Linux:", err);
      }
    });
  }
}

async function startLocalGoogleCallbackServer(
  redirectUriOverride?: string,
  timeoutMs = 120000
): Promise<{ redirectUri: string; codePromise: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolveCodeInner, rejectCodeInner) => {
      resolveCode = resolveCodeInner;
      rejectCode = rejectCodeInner;
    });

    const callbackUrl = redirectUriOverride ? new URL(redirectUriOverride) : new URL("http://127.0.0.1:0/callback");
    const host = callbackUrl.hostname || "127.0.0.1";
    const port = Number(callbackUrl.port) || 0;
    const callbackPath = callbackUrl.pathname || "/callback";
    const normalizedCallbackPath = callbackPath.replace(/\/+$/, "") || "/callback";

    console.log(`[aris-cli] local callback server configured on host=${host} port=${port} path=${callbackPath}`);

    if (!redirectUriOverride && port === 0 && callbackUrl.hostname !== "127.0.0.1") {
      reject(new Error("Invalid local callback redirect URI."));
      return;
    }

    const server = http.createServer((req, res) => {
      console.log(`[aris-cli] callback server received request: ${req.method} ${req.url}`);
      if (!req.url) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing URL.");
        return;
      }

      const url = new URL(req.url, `http://${host}`);
      const requestPath = url.pathname.replace(/\/+$/, "") || "/";
      console.log(`[aris-cli] parsed callback request path=${requestPath} query=${url.searchParams.toString()}`);

      if (requestPath !== normalizedCallbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found.");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        console.log("[aris-cli] callback request had no code parameter.");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>No code received.</p></body></html>");
        return;
      }

      console.log(`[aris-cli] callback server received auth code, resolving promise.`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authorization complete</h1><p>You can close this window and return to the CLI.</p></body></html>");
      resolveCode(code);
      server.close();
    });

    const timeout = setTimeout(() => {
      rejectCode(new Error("Timed out waiting for Google authorization callback."));
      server.close();
    }, timeoutMs);

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err as Error);
    });

    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new Error("Unable to bind local callback server."));
        return;
      }

      const actualPort = typeof address === "object" ? address.port : port;
      const redirectUri = redirectUriOverride
        ? redirectUriOverride
        : `http://${host}:${actualPort}${callbackPath}`;
      resolve({ redirectUri, codePromise, close: () => server.close() });
    });
  });
}

async function handleGoogleFlow(authToken: string) {
  while (true) {
    const action = await promptGoogleMenu();
    if (action === "back") {
      return;
    }

    if (action === "status") {
      try {
        const status = await getGoogleStatus(baseUrl, authToken);
        if (status.connected) {
          console.log(`\nGoogle is connected as ${status.googleEmail}.`);
          console.log(`Scopes: ${Array.isArray(status.scopes) ? status.scopes.join(", ") : status.scopes}`);
          console.log(`Token expiry: ${status.tokenExpiry || "unknown"}\n`);
        } else {
          console.log("\nGoogle is not connected yet. Use Connect Google account to authorize.\n");
        }
      } catch (error: any) {
        console.error("Failed to fetch Google status:", error.response?.data?.error || error.message || error);
      }
      continue;
    }

    if (action === "disconnect") {
      const { confirmDisconnect } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmDisconnect",
          message: "Are you sure you want to disconnect your Google account?",
          default: false,
        },
      ]);
      if (!confirmDisconnect) {
        continue;
      }

      try {
        await disconnectGoogle(baseUrl, authToken);
        console.log("\nGoogle account disconnected successfully.\n");
      } catch (error: any) {
        console.error("Failed to disconnect Google account:", error.response?.data?.error || error.message || error);
      }
      continue;
    }

    if (action === "connect") {
      let localServer;
      let authUrl;
      const redirectUriToUse = localCallbackRedirectUri;
      try {
        localServer = await startLocalGoogleCallbackServer(redirectUriToUse);
        authUrl = (await getGoogleAuthUrl(baseUrl, authToken, localServer.redirectUri)).authUrl;
        console.log("\nA local callback server is listening for Google OAuth responses.");
        console.log(`Using redirect URI: ${localServer.redirectUri}`);
        console.log("If the browser does not open automatically, paste this URL into your browser:");
        console.log(authUrl);
        try {
          openUrlInBrowser(authUrl);
        } catch (openError) {
          console.error("Failed to open browser automatically:", openError);
          console.log("Please open the URL manually.");
        }

        const code = await localServer.codePromise;
        console.log("Received authorization code from local callback.");
        await submitGoogleAuthCode(baseUrl, authToken, code, localServer.redirectUri);
        console.log("\nGoogle connected successfully. You can now use Gmail and Calendar tools.\n");
      } catch (error: any) {
        if (localServer) {
          localServer.close();
        }
        console.error("Google authorization failed:", error.response?.data?.error || error.message || error);
        console.log("Falling back to manual code entry.");

        try {
          authUrl = authUrl || (await getGoogleAuthUrl(baseUrl, authToken, redirectUriToUse)).authUrl;
          console.log("\nOpen this URL in your browser to authorize Aris with Google:");
          console.log(authUrl);
          try {
            openUrlInBrowser(authUrl);
          } catch (openError) {
            console.error("Failed to open browser automatically:", openError);
            console.log("Please open the URL manually.");
          }
          const code = await promptGoogleAuthCode();
          if (!code) {
            console.log("No authorization code provided. Returning to Google menu.\n");
            continue;
          }
          await submitGoogleAuthCode(baseUrl, authToken, code, redirectUriToUse);
          console.log("\nGoogle connected successfully. You can now use Gmail and Calendar tools.\n");
        } catch (manualError: any) {
          console.error("Manual Google authorization failed:", manualError.response?.data?.error || manualError.message || manualError);
        }
      }
      continue;
    }
  }
}

async function promptVoiceSource() {
  const { voiceSource } = await inquirer.prompt([
    {
      type: "list",
      name: "voiceSource",
      message: "Choose voice input source:",
      choices: [
        { name: "Microphone", value: "mic" },
        { name: "Audio file", value: "voice" },
        { name: "Back to main menu", value: "back" },
      ],
    },
  ]);

  return voiceSource as "mic" | "voice" | "back";
}

async function promptVoiceSessionAction() {
  const { nextAction } = await inquirer.prompt([
    {
      type: "list",
      name: "nextAction",
      message: "What would you like to do next?",
      choices: [
        { name: "Do another voice interaction with the same input source", value: "repeat" },
        { name: "Choose a different voice input source", value: "back" },
        { name: "Exit Aris", value: "exit" },
      ],
    },
  ]);

  return nextAction as "repeat" | "back" | "exit";
}

async function promptMicContinueAction() {
  const { command } = await inquirer.prompt([
    {
      type: "input",
      name: "command",
      message: "Press ENTER to start recording again, or type 'menu' to return to the main menu, 'exit' to quit.",
    },
  ]);

  const normalized = (command ?? "").trim().toLowerCase();
  if (normalized === "exit") {
    return "exit" as const;
  }
  if (normalized === "menu" || normalized === "back") {
    return "back" as const;
  }
  return "repeat" as const;
}

async function processVoiceInput(
  source: "mic" | "voice",
  authToken: string,
  sessionId: string,
  options: { deviceName?: string | null; playWelcome?: boolean } = {}
) {
  if (source === "mic") {
    if (options.playWelcome) {
      console.log("\nAris is preparing a welcome message...");
      await playWelcomePrompt(baseUrl, authToken, sessionId);
    }
    console.log("\nPress ENTER to start recording.");
    const recorded = await recordMicrophoneAudio(options.deviceName);
    const recordingFileName = buildUniqueRecordingFileName("aris-recording", "wav");
    const recordingPath = await saveAudioFile(recorded.audioBase64, recordingFileName);
    console.log(`Recorded audio saved to ${recordingPath}`);

    try {
      console.log("Playing recorded audio for validation...");
      await playAudioFile(recordingPath);
    } catch (playError: any) {
      console.warn(`Unable to play recorded audio automatically: ${playError?.message || playError}`);
    }

    return await uploadVoiceFile(recordingPath, authToken, sessionId);
  }

  const { audioPath } = await inquirer.prompt([
    {
      type: "input",
      name: "audioPath",
      message: "Path to input audio file:",
    },
  ]);

  const fileBuffer = await fs.readFile(audioPath);
  const audioBase64 = fileBuffer.toString("base64");
  const mimeType = getMimeTypeFromPath(audioPath);
  return await sendVoiceMessage(baseUrl, audioBase64, mimeType, authToken, sessionId);
}

function commandExists(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function selectRecorder(): string {
  if (process.platform === "win32") {
    if (commandExists("sox")) return "sox";
    if (commandExists("rec")) return "rec";
  } else {
    if (commandExists("arecord")) return "arecord";
    if (commandExists("sox")) return "sox";
    if (commandExists("rec")) return "rec";
  }

  throw new Error(
    `Microphone recording requires an external recorder binary. Install sox or rec on your system, then retry. On Windows, install SoX and add it to PATH. On Linux, install arecord or sox.`
  );
}

function getRecorderErrorHint(err: any, recorder: string) {
  const message = (err && (err.message || err.toString()) || "").toString().toLowerCase();
  if (message.includes("no default audio device configured") || message.includes("no default audio device")) {
    return `\nHint: No default recording device is configured. Open Windows Sound settings and set a default input device or enable your microphone before retrying. On Windows, SoX may also require AUDIODRIVER=waveaudio if the default driver is not detected.`;
  }

  if (message.includes("could not open audio device") || message.includes("audio device error") || message.includes("device not found")) {
    return `\nHint: ${recorder} could not access your microphone. Ensure the microphone is enabled, connected, and set as the system default input device.`;
  }

  if (message.includes("exit code null")) {
    return `\nHint: The recording process ended unexpectedly. Enable debug output with DEBUG=record and verify your microphone device configuration.`;
  }

  return "";
}

function getRecorderEnvironment(recorder: string) {
  const env = { ...process.env };
  if (process.platform === "win32" && recorder === "sox") {
    env.AUDIODRIVER = env.AUDIODRIVER || "waveaudio";
  }
  return env;
}

async function promptRecordingDevice(recorder: string) {
  if (process.platform !== "win32" || recorder !== "sox") {
    return undefined;
  }

  const { useDefault } = await inquirer.prompt([
    {
      type: "confirm",
      name: "useDefault",
      message: "Use the system default recording device?",
      default: true,
    },
  ]);

  if (useDefault) {
    return undefined;
  }

  const { deviceName } = await inquirer.prompt([
    {
      type: "input",
      name: "deviceName",
      message: "Enter the SoX input device name (exact Windows audio capture device string):",
      suffix: "\nExample: \"Microphone (Realtek Audio)\" or \"Stereo Mix\"\n",
    },
  ]);

  return deviceName?.trim() || undefined;
}

function buildRecorderArgs(
  recorder: string,
  outputType: "raw" | "wav" = "raw",
  outputPath?: string,
  deviceName?: string
) {
  const args: string[] = [];

  if (process.platform === "win32" && recorder === "sox") {
    args.push("-t", "waveaudio");
    if (deviceName) {
      args.push(deviceName);
    } else {
      args.push("-d");
    }
  } else {
    args.push("-d");
  }

  args.push("--no-show-progress", "-c", "1", "-r", "16000", "-e", "signed-integer", "-b", "16", "-L");

  if (outputType === "raw") {
    args.push("-", "-t", "raw");
  } else if (outputPath) {
    args.push(outputPath);
  }

  return args;
}

function getWavMetadata(wavBuffer: Buffer) {
  if (wavBuffer.length < 44) return null;
  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (wavBuffer.toString("ascii", 8, 12) !== "WAVE") return null;

  const audioFormat = wavBuffer.readUInt16LE(20);
  const channels = wavBuffer.readUInt16LE(22);
  const sampleRateHertz = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);

  return {
    audioFormat,
    sampleRateHertz,
    audioChannelCount: channels,
    bitsPerSample,
  };
}

async function getServerRecordingFolder() {
  const folder = path.join(process.cwd(), "server", "recordings");
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

function buildUniqueRecordingFileName(prefix: string, extension: string) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}.${extension}`;
}

async function saveAudioFile(audioBase64: string, fileName: string) {
  const folder = await getServerRecordingFolder();
  const filePath = path.join(folder, fileName);
  await fs.writeFile(filePath, Buffer.from(audioBase64, "base64"));
  return filePath;
}

async function uploadVoiceFile(filePath: string, authToken: string, sessionId?: string) {
  const fileBuffer = await fs.readFile(filePath);
  const audioBase64 = fileBuffer.toString("base64");
  const mimeType = getMimeTypeFromPath(filePath);
  return await sendVoiceMessage(baseUrl, audioBase64, mimeType, authToken, sessionId);
}

async function saveAndPlayResponseFile(voiceBase64: string, voiceMimeType: string) {
  const folder = await getServerRecordingFolder();
  const extension = getExtensionForMimeType(voiceMimeType);
  const fileName = buildUniqueRecordingFileName("aris-response", extension);
  const filePath = path.join(folder, fileName);
  await fs.writeFile(filePath, Buffer.from(voiceBase64, "base64"));
  console.log(`Voice response saved to ${filePath}`);

  try {
    console.log("Playing Aris response...");
    await playAudioFile(filePath);
  } catch (playError: any) {
    console.warn(`Unable to auto-play the response file. Open it manually at ${filePath}`);
    if (playError instanceof Error) {
      console.warn(playError.message);
    }
  }

  return filePath;
}

function rawPcmToWav(rawBuffer: Buffer, sampleRate: number, channels: number, bitDepth: number) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = rawBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4); // file size - 8
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, rawBuffer]);
}

function checkRecorderAvailability(recorder: string) {
  if (!["sox", "rec"].includes(recorder)) return;

  const args = ["-d", "-n", "trim", "0", "0.01", "stat"];
  const result = spawnSync(recorder, args, { encoding: "utf8", timeout: 5000, env: getRecorderEnvironment(recorder) });
  const stderr = result.stderr?.toString() || "";
  const stdout = result.stdout?.toString() || "";
  const message = `${stderr}${stdout}`.toLowerCase();

  if (result.status === 0) {
    return;
  }

  if (message.includes("no default audio device configured") || message.includes("no default audio device")) {
    throw new Error(
      `Recorder check failed: no default audio device configured. Open Windows Sound settings and set a default input device or enable your microphone before retrying.`
    );
  }

  if (message.includes("could not open audio device") || message.includes("audio device error") || message.includes("device not found")) {
    throw new Error(
      `Recorder check failed: ${recorder} could not access your microphone. Ensure the microphone is enabled, connected, and set as the system default input device.`
    );
  }

  const errorInfo = result.error as any;
  if (errorInfo?.code === 'ETIMEDOUT') {
    return;
  }

  if (result.signal && !message) {
    return;
  }

  throw new Error(
    `Recorder check failed: ${recorder} returned exit code ${result.status || 'unknown'}. ${stderr || stdout}`.trim()
  );
}

async function recordMicrophoneAudio(deviceNameOverride?: string | null) {
  console.log("Make sure your microphone is connected and set as the default input device before recording.");
  await inquirer.prompt([
    {
      type: "input",
      name: "startRecording",
      message: "Press ENTER to start recording:",
    },
  ]);

  const recorder = selectRecorder();
  checkRecorderAvailability(recorder);
  if (process.platform === "win32" && recorder === "sox") {
    process.env.AUDIODRIVER = process.env.AUDIODRIVER || "waveaudio";
  }

  const deviceName = deviceNameOverride !== undefined
    ? deviceNameOverride
    : await promptRecordingDevice(recorder);
  const recordingFileName = buildUniqueRecordingFileName("aris-recording", "wav");
  const recordingPath = path.join(await getServerRecordingFolder(), recordingFileName);
  const args = buildRecorderArgs(recorder, "wav", recordingPath, deviceName);
  console.log(`[voice] starting recorder=${recorder} args=${args.join(" ")}`);
  const recording = spawn(recorder, args, {
    env: getRecorderEnvironment(recorder),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stopRequested = false;
  let stderrBuffer = "";

  recording.on("close", (code) => {
    console.log(`[voice] recorder process closed code=${code} stderr=${stderrBuffer.trim()}`);
  });

  recording.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  recording.on("error", (err: any) => {
    const message = (err && (err.message || err.toString()) || "").toString().toLowerCase();
    const baseMessage = `Microphone recording failed: ${err.message || err}`;
    const extraHint = getRecorderErrorHint(err, recorder);
    throw new Error(`${baseMessage}${extraHint}`);
  });

  const recordingFinished = new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      recording.removeListener("close", onClose);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    recording.once("close", onClose);
  });

  console.log(`Recording using ${recorder}... press ENTER again to stop.`);
  await inquirer.prompt([
    {
      type: "input",
      name: "stopRecording",
      message: "Press ENTER to stop recording:",
    },
  ]);

  stopRequested = true;
  console.log("[voice] stopping recorder...");
  try {
    if (process.platform === "win32") {
      recording.kill();
      console.log("[voice] sent default kill to recorder on Windows");
    } else {
      recording.kill("SIGINT");
      console.log("[voice] sent SIGINT to recorder");
    }
  } catch (err: any) {
    console.warn("[voice] failed to stop recorder gracefully", err?.message || err);
    try {
      recording.kill("SIGTERM");
      console.log("[voice] sent SIGTERM to recorder as fallback");
    } catch {
      console.warn("[voice] fallback kill also failed");
    }
  }

  await recordingFinished;

  const wavBuffer = await fs.readFile(recordingPath);
  console.log(`[voice] recording stopped; saved ${wavBuffer.length} bytes to ${recordingPath}`);
  if (stderrBuffer.trim()) {
    console.log(`[voice] recorder stderr: ${stderrBuffer.trim()}`);
  }

  if (!wavBuffer.length) {
    throw new Error("No audio was captured from the microphone.");
  }

  const metadata = getWavMetadata(wavBuffer);
  if (metadata) {
    console.log(`[voice] saved WAV metadata ${JSON.stringify(metadata)}`);
  } else {
    console.warn("[voice] saved WAV buffer did not parse as a valid WAV header.");
  }

  return {
    audioBase64: wavBuffer.toString("base64"),
    mimeType: "audio/wav",
  };
}

async function main() {
  const authResult = await authenticate();
  if (authResult.onboardingRequired) {
    await runOnboarding(authResult.token);
  }
  console.log("Type 'exit' to quit.");

  while (true) {
    const { mode } = await inquirer.prompt([
      {
        type: "list",
        name: "mode",
        message: "Choose input mode:",
        choices: [
          { name: "Text chat", value: "text" },
          { name: "Voice microphone", value: "mic" },
          { name: "Voice audio file", value: "voice" },
          { name: "Google account", value: "google" },
          { name: "Exit", value: "exit" },
        ],
      },
    ]);

    if (mode === "exit") {
      console.log("Goodbye from Aris.");
      process.exit(0);
    }

    if (mode === "google") {
      await handleGoogleFlow(authResult.token);
      continue;
    }

    if (mode === "text") {
      while (true) {
        const { userInput } = await inquirer.prompt([
          {
            type: "input",
            name: "userInput",
            message: "You >",
          },
        ]);

        const normalizedInput = userInput?.trim().toLowerCase();
        if (!userInput || normalizedInput === "exit") {
          console.log("Goodbye from Aris.");
          process.exit(0);
        }
        if (normalizedInput === "menu") {
          break;
        }

        try {
          const result = await sendChatMessage(baseUrl, userInput, authResult.token, sessionId);
          console.log(`\nAris > ${result.arisReply}\n`);
          if (result.memoryUpdates.length > 0) {
            console.log("Memory updated:");
            result.memoryUpdates.forEach((entry) => console.log(`- ${entry}`));
            console.log("");
          }
        } catch (error) {
          console.error("Error sending message to Aris:", error instanceof Error ? error.message : error);
        }
      }
    } else if (mode === "mic" || mode === "voice") {
      let voiceSource = mode;
      let micDeviceName: string | null | undefined;
      let micDeviceSelected = false;
      let shouldPlayWelcome = true;

      while (true) {
        if (voiceSource === "mic" && !micDeviceSelected) {
          const recorder = selectRecorder();
          checkRecorderAvailability(recorder);
          if (process.platform === "win32" && recorder === "sox") {
            process.env.AUDIODRIVER = process.env.AUDIODRIVER || "waveaudio";
          }
          const selectedDevice = await promptRecordingDevice(recorder);
          micDeviceName = selectedDevice === undefined ? null : selectedDevice;
          micDeviceSelected = true;
        }

        try {
          const result = await processVoiceInput(voiceSource, authResult.token, sessionId, {
            deviceName: micDeviceName,
            playWelcome: voiceSource === "mic" ? shouldPlayWelcome : false,
          });

          if (voiceSource === "mic") {
            shouldPlayWelcome = false;
          }

          console.log(`\nTranscribed: ${result.transcript}`);
          console.log(`Aris > ${result.arisReply}\n`);
          if (result.memoryUpdates.length > 0) {
            console.log("Memory updated:");
            result.memoryUpdates.forEach((entry) => console.log(`- ${entry}`));
            console.log("");
          }

          await saveAndPlayResponseFile(result.voiceBase64, result.voiceMimeType);
        } catch (error: any) {
          if (error?.response?.data) {
            console.error("Error sending voice message to Aris:", JSON.stringify(error.response.data, null, 2));
          } else {
            console.error("Error sending voice message to Aris:", error instanceof Error ? error.message : error);
          }
        }

        const action = await (voiceSource === "mic"
          ? promptMicContinueAction()
          : promptVoiceSessionAction());

        if (action === "exit") {
          console.log("Goodbye from Aris.");
          process.exit(0);
        }
        if (action === "back") {
          break;
        }
        voiceSource = mode === "voice" ? "voice" : voiceSource;
      }
    }
  }
}

main().catch((error) => {
  console.error("CLI error:", error);
  process.exit(1);
});
