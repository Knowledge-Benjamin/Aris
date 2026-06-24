import axios from "axios";
import readline from "readline";

function formatAxiosError(err: any) {
  if (err?.response?.data) {
    return `Axios error: ${JSON.stringify(err.response.data)}`;
  }
  if (err?.message) {
    return err.message;
  }
  return String(err);
}

export interface ArisChatResponse {
  arisReply: string;
  memoryUpdates: string[];
  status?: "finished" | "awaiting_approval" | "max_iterations_reached" | "error";
  pendingAction?: {
    tool: string;
    payload: any;
  };
}

export interface ArisVoiceResponse {
  transcript: string;
  arisReply: string;
  memoryUpdates: string[];
  voiceBase64: string;
  voiceMimeType: string;
}

export interface ArisTtsResponse {
  text: string;
  voiceBase64: string;
  voiceMimeType: string;
}

export interface AuthResponse {
  token: string;
  email: string;
  onboardingRequired: boolean;
}

export async function sendChatMessage(baseUrl: string, message: string, authToken: string, sessionId?: string, onProgress?: (msg: string) => void, approvedAction?: any): Promise<ArisChatResponse> {
  const response = await axios.post(
    `${baseUrl}/api/aris/chat/stream`,
    { message, sessionId, approvedAction },
    { 
      headers: { Authorization: `Bearer ${authToken}` },
      responseType: 'stream'
    }
  );

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: response.data });
    let finalResponse: ArisChatResponse | undefined;

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const data = JSON.parse(line);
        if (data.type === 'progress' && onProgress) {
          onProgress(data.message);
        } else if (data.type === 'complete') {
          finalResponse = data.data;
        } else if (data.type === 'heartbeat') {
          // keepalive — ignore
        } else if (data.error) {
          reject(new Error(data.error));
        }
      } catch (e) {
        // ignore parse errors for partial lines
      }
    });

    rl.on('close', () => {
      if (finalResponse) resolve(finalResponse);
      else reject(new Error("Stream closed without complete response"));
    });
  });
}

export async function sendVoiceMessage(
  baseUrl: string,
  audioBase64: string,
  mimeType: string,
  authToken: string,
  sessionId?: string
) {
  try {
    const response = await axios.post<ArisVoiceResponse>(
      `${baseUrl}/api/aris/voice`,
      { audioBase64, mimeType, sessionId },
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    return response.data;
  } catch (err: any) {
    throw new Error(formatAxiosError(err));
  }
}

export async function sendWelcomeSpeech(
  baseUrl: string,
  authToken: string,
  sessionId?: string
) {
  const response = await axios.post<ArisTtsResponse>(
    `${baseUrl}/api/aris/welcome`,
    { sessionId },
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}

export async function registerUser(baseUrl: string, email: string, password: string) {
  const response = await axios.post<AuthResponse>(`${baseUrl}/api/auth/register`, { email, password });
  return response.data;
}

export async function loginUser(baseUrl: string, email: string, password: string) {
  const response = await axios.post<AuthResponse>(`${baseUrl}/api/auth/login`, { email, password });
  return response.data;
}

export async function completeOnboarding(baseUrl: string, authToken: string) {
  const response = await axios.post(
    `${baseUrl}/api/auth/onboarding/complete`,
    {},
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}

export async function getGoogleAuthUrl(baseUrl: string, authToken: string, redirectUri?: string) {
  const url = new URL(`${baseUrl}/api/google/url`);
  if (redirectUri) {
    url.searchParams.set("redirectUri", redirectUri);
  }

  const response = await axios.get<{ authUrl: string }>(
    url.toString(),
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}

export async function submitGoogleAuthCode(baseUrl: string, authToken: string, code: string, redirectUri?: string) {
  const response = await axios.post(
    `${baseUrl}/api/google/callback`,
    { code, redirectUri },
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}

export async function getGoogleStatus(baseUrl: string, authToken: string) {
  const response = await axios.get(
    `${baseUrl}/api/google/status`,
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}

export async function disconnectGoogle(baseUrl: string, authToken: string) {
  const response = await axios.post(
    `${baseUrl}/api/google/disconnect`,
    {},
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  return response.data;
}
