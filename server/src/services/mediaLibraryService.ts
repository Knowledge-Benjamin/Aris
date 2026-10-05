import { MediaLibraryRecord, MediaLibraryStore } from "../db/mediaLibraryStore";
import { GoogleAccountStore, GoogleAccountRecord } from "../db/googleAccountStore";
import { GoogleService } from "./googleService";
import { GemmaService } from "./gemmaService";

export interface StoredMediaInput {
  userId: number;
  sessionId?: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  sourceType: string;
  sourceReference?: string;
  description?: string;
  summary?: string;
  sourceText?: string;
}

export interface MediaDownload {
  record: MediaLibraryRecord;
  content: Buffer;
}

const MAX_MEDIA_LIBRARY_BYTES = 100 * 1024 * 1024;

export class MediaLibraryService {
  private readonly folderIds = new Map<number, string>();

  constructor(
    private readonly googleService: GoogleService,
    private readonly accountStore: GoogleAccountStore,
    private readonly mediaStore: MediaLibraryStore,
    private readonly gemmaService: GemmaService,
  ) {}

  async store(input: StoredMediaInput): Promise<MediaLibraryRecord> {
    if (!input.content.length) throw new Error("Cannot store an empty media file.");
    if (!input.fileName.trim() || !input.mimeType.trim()) {
      throw new Error("Media uploads require a filename and MIME type.");
    }
    if (input.content.length > MAX_MEDIA_LIBRARY_BYTES) {
      throw new Error("Media library files are limited to 100 MiB each.");
    }
    const account = await this.requireAccount(input.userId);
    if (input.sourceReference) {
      const existing = await this.mediaStore.findBySourceReference(
        input.userId,
        input.sourceType,
        input.sourceReference,
      );
      if (existing) return existing;
    }

    const fileName = sanitizeFileName(input.fileName);
    const summary = input.summary?.trim()
      || await this.summarizeUpload(fileName, input.mimeType, input.content, input.description);
    if (!summary) {
      throw new Error("Aris could not create a useful description for this media file, so it was not added to the library.");
    }

    const folderId = await this.getFolderId(input.userId, account);
    const driveFile = await this.googleService.uploadDriveFile(
      account,
      fileName,
      input.mimeType,
      input.content,
      this.tokenUpdater(input.userId),
      false,
      folderId,
    );
    if (!driveFile.id) {
      throw new Error("Google Drive did not return a file ID for the media upload.");
    }

    try {
      return await this.mediaStore.upsert({
        userId: input.userId,
        driveFileId: driveFile.id,
        driveUrl: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
        fileName: driveFile.name || fileName,
        mimeType: driveFile.mimeType || input.mimeType,
        byteSize: Number(driveFile.size) || input.content.length,
        sourceType: input.sourceType,
        sourceReference: input.sourceReference,
        summary,
        sourceText: input.sourceText || input.description || summary,
        sessionId: input.sessionId,
      });
    } catch (indexError) {
      try {
        await this.googleService.deleteDriveFile(account, driveFile.id, this.tokenUpdater(input.userId));
      } catch (cleanupError) {
        throw new Error(
          `The file was uploaded to Drive but its library index failed (${errorMessage(indexError)}); cleanup also failed (${errorMessage(cleanupError)}).`
        );
      }
      const existing = input.sourceReference
        ? await this.mediaStore.findBySourceReference(input.userId, input.sourceType, input.sourceReference)
        : undefined;
      if (existing) return existing;
      throw new Error(`The media library index failed; the unindexed Drive upload was removed. ${errorMessage(indexError)}`);
    }
  }

  async registerExisting(input: {
    userId: number;
    sessionId?: string;
    driveFileId: string;
    fileName: string;
    mimeType: string;
    sourceType: string;
    sourceReference?: string;
    summary: string;
    sourceText?: string;
    byteSize?: number;
    driveUrl?: string;
  }): Promise<MediaLibraryRecord> {
    await this.requireAccount(input.userId);
    return this.mediaStore.upsert({
      userId: input.userId,
      driveFileId: input.driveFileId,
      driveUrl: input.driveUrl || `https://drive.google.com/file/d/${input.driveFileId}/view`,
      fileName: sanitizeFileName(input.fileName),
      mimeType: input.mimeType,
      byteSize: input.byteSize ?? 0,
      sourceType: input.sourceType,
      sourceReference: input.sourceReference,
      summary: input.summary,
      sourceText: input.sourceText || input.summary,
      sessionId: input.sessionId,
    });
  }

  async search(userId: number, query: string, limit = 8): Promise<MediaLibraryRecord[]> {
    return this.mediaStore.search(userId, query, limit);
  }

  async listRecent(userId: number, limit = 20): Promise<MediaLibraryRecord[]> {
    return this.mediaStore.listRecent(userId, limit);
  }

  async findById(userId: number, id: number): Promise<MediaLibraryRecord | undefined> {
    return this.mediaStore.findById(userId, id);
  }

  async findByDriveFileId(userId: number, driveFileId: string): Promise<MediaLibraryRecord | undefined> {
    return this.mediaStore.findByDriveFileId(userId, driveFileId);
  }

  async findBySourceReference(
    userId: number,
    sourceType: string,
    sourceReference: string,
  ): Promise<MediaLibraryRecord | undefined> {
    return this.mediaStore.findBySourceReference(userId, sourceType, sourceReference);
  }

  async download(userId: number, record: MediaLibraryRecord): Promise<Buffer> {
    if (record.userId !== userId) throw new Error("This media file does not belong to the authenticated user.");
    const account = await this.requireAccount(userId);
    return this.googleService.downloadDriveFile(account, record.driveFileId, this.tokenUpdater(userId));
  }

  async analyze(record: MediaLibraryRecord, content: Buffer, question?: string): Promise<string> {
    if (content.length > 20 * 1024 * 1024) {
      throw new Error("This file is too large for inline content analysis. The original is available in the media library.");
    }
    if (!isInlineModelMimeType(record.mimeType)) {
      throw new Error(`Aris cannot analyze ${record.mimeType} inline yet. The original file is available to download.`);
    }
    const response = await this.gemmaService.requestArisAdvice(
      [
        "Analyze the user's stored media file and answer the supplied request using only evidence in the file.",
        "For images, describe visible content and readable text. For audio or video, summarize speech and salient events. For documents, extract their key content.",
        "If the media does not contain enough evidence to answer, state that clearly. Do not invent an interpretation.",
        `Stored filename: ${record.fileName}`,
        `Known library description: ${record.summary}`,
        question ? `User's request: ${question}` : "Provide a concise content summary.",
      ].join("\n"),
      [{ inlineData: { mimeType: record.mimeType, data: content.toString("base64") } }],
    );
    const analysis = response.reply.trim();
    if (!analysis) throw new Error("The media analyzer returned an empty result.");
    return analysis;
  }

  private async summarizeUpload(fileName: string, mimeType: string, content: Buffer, description?: string): Promise<string> {
    if (!isInlineModelMimeType(mimeType)) {
      const caption = description?.trim();
      return [
        `Description: User-uploaded ${mimeType} file "${fileName}".`,
        caption ? `User-provided context: ${caption}` : "",
        "Content: The file is stored in the media library; its contents have not been analyzed.",
        `Search terms: ${fileName} ${mimeType} ${caption || ""}`,
      ].filter(Boolean).join(" ").slice(0, 12000);
    }
    const response = await this.gemmaService.requestArisAdvice(
      [
        "Create a searchable media-library record for the attached user file.",
        "Return a short factual description, important entities/details, and useful searchable terms. Do not guess details that are not visible or audible.",
        "Include the user's caption as context, not as proof of file contents.",
        `Filename: ${fileName}`,
        `MIME type: ${mimeType}`,
        `User caption: ${description?.trim() || "(none)"}`,
        "Use this compact format: Description: ...; Content: ...; Search terms: ...",
      ].join("\n"),
      [{ inlineData: { mimeType, data: content.toString("base64") } }],
    );
    const summary = response.reply.trim();
    if (!summary || summary.startsWith("[Aris advisor unavailable:")) {
      throw new Error("Aris could not analyze the attachment; it has not been uploaded.");
    }
    return summary.slice(0, 12000);
  }

  private async requireAccount(userId: number): Promise<GoogleAccountRecord> {
    if (!userId) throw new Error("Sign in before using the Aris Media Library.");
    const account = await this.accountStore.getGoogleAccount(userId);
    if (!account) throw new Error("Connect your Google account before using the Aris Media Library.");
    return account;
  }

  private async getFolderId(userId: number, account: GoogleAccountRecord): Promise<string> {
    const cached = this.folderIds.get(userId);
    if (cached) return cached;
    const folderId = await this.googleService.ensureArisMediaFolder(account, this.tokenUpdater(userId));
    this.folderIds.set(userId, folderId);
    return folderId;
  }

  private tokenUpdater(userId: number) {
    return (tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string | null;
    }) => this.accountStore.updateGoogleTokens(
      userId,
      tokens.access_token ?? undefined,
      tokens.refresh_token ?? undefined,
      tokens.expiry_date ?? undefined,
      tokens.scope ?? undefined,
    );
  }
}

function sanitizeFileName(fileName: string): string {
  const safeName = fileName.replace(/[<>:"/\\|?*\0-\x1F]/g, "_").trim().slice(0, 180);
  return safeName || `aris-media-${Date.now()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInlineModelMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/")
    || mimeType.startsWith("audio/")
    || mimeType.startsWith("video/")
    || mimeType === "application/pdf"
    || mimeType === "text/plain";
}
