/**
 * gcsService.ts — Google Cloud Storage wrapper using the service-account key
 * already in process.env.GOOGLE_APPLICATION_CREDENTIALS or inline via
 * GCS_KEY_JSON (a base-64 encoded service-account JSON string).
 *
 * We use the googleapis REST API directly to avoid adding a new npm package.
 * Bucket name is read from GCS_BUCKET_NAME (required).
 */
import axios from "axios";
import { google } from "googleapis";
import { info, error } from "../utils/logger";

const BUCKET = process.env.GCS_BUCKET_NAME;

function getAuth() {
  const keyJson = process.env.GCS_KEY_JSON
    ? JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, "base64").toString("utf8"))
    : undefined;

  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
  });
  return auth;
}

export const gcsService = {
  /**
   * Upload a Buffer to GCS and return the public GCS URI  (gs://bucket/path).
   * The object is NOT publicly accessible; it is downloaded via a signed URL
   * when the WhatsApp poller needs to send it.
   */
  async upload(
    buffer: Buffer,
    destPath: string,
    mimeType: string
  ): Promise<string> {
    if (!BUCKET) throw new Error("GCS_BUCKET_NAME env var is not set.");
    const auth = getAuth();
    const token = await auth.getAccessToken();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(destPath)}`;

    info(`[gcs] uploading ${destPath} (${buffer.length} bytes, ${mimeType})`);
    await axios.post(url, buffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
        "Content-Length": buffer.length,
      },
    });

    const gcsUri = `gs://${BUCKET}/${destPath}`;
    info(`[gcs] upload complete → ${gcsUri}`);
    return gcsUri;
  },

  /**
   * Download a GCS object by its URI and return the raw buffer.
   * Used by the WhatsApp poller to retrieve audio before sending.
   */
  async download(gcsUri: string): Promise<Buffer> {
    if (!BUCKET) throw new Error("GCS_BUCKET_NAME env var is not set.");
    const objectPath = gcsUri.replace(`gs://${BUCKET}/`, "");
    const auth = getAuth();
    const token = await auth.getAccessToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media`;

    info(`[gcs] downloading ${gcsUri}`);
    const response = await axios.get<Buffer>(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
    });
    return Buffer.from(response.data);
  },

  /**
   * Generates a short-lived (15-minute) signed download URL.
   * Useful if you want to send a direct HTTPS link instead of fetching bytes.
   */
  async signedUrl(gcsUri: string, expiresInSeconds = 900): Promise<string> {
    if (!BUCKET) throw new Error("GCS_BUCKET_NAME env var is not set.");
    const objectPath = gcsUri.replace(`gs://${BUCKET}/`, "");
    const auth = getAuth();
    const token = await auth.getAccessToken();

    const expiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const url = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectPath)}?signedHeaders=host&expiry=${expiry}`;

    const res = await axios.post(
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectPath)}:generateSignedUrl`,
      { expiry, access: "READ" },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.data?.signedUrl || url;
  },
};
