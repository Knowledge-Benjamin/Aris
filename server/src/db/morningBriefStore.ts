import { Pool } from "pg";

export interface MorningBriefAudioAsset {
  storageUri: string;
  mimeType: string;
  title: string;
  mediaLibraryId?: number;
}

export interface MorningBriefPodcastEpisode extends MorningBriefAudioAsset {
  analysis: string;
  publishedAt?: string;
}

export interface MorningBriefRun {
  id: number;
  userId: number;
  briefText: string;
  audioText: string;
  audioAssets: MorningBriefAudioAsset[];
  podcastEpisodes: MorningBriefPodcastEpisode[];
  createdAt: Date;
}

export class MorningBriefStore {
  constructor(private readonly pool: Pool) {}

  async findRecent(userId: number, maxAgeMinutes = 30): Promise<MorningBriefRun | undefined> {
    const result = await this.pool.query(
      `SELECT id, user_id, brief_text, audio_text, audio_assets, podcast_episodes, created_at
       FROM aris_morning_brief_runs
       WHERE user_id = $1
         AND created_at >= NOW() - ($2::double precision * INTERVAL '1 minute')
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, maxAgeMinutes],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async save(input: Omit<MorningBriefRun, "id" | "createdAt">): Promise<MorningBriefRun> {
    const result = await this.pool.query(
      `INSERT INTO aris_morning_brief_runs
       (user_id, brief_text, audio_text, audio_assets, podcast_episodes)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id, user_id, brief_text, audio_text, audio_assets, podcast_episodes, created_at`,
      [
        input.userId,
        input.briefText,
        input.audioText,
        JSON.stringify(input.audioAssets),
        JSON.stringify(input.podcastEpisodes),
      ],
    );
    return mapRow(result.rows[0]);
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as T[];
  }
  return [];
}

function mapRow(row: any): MorningBriefRun {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    briefText: String(row.brief_text),
    audioText: String(row.audio_text),
    audioAssets: parseJsonArray<MorningBriefAudioAsset>(row.audio_assets),
    podcastEpisodes: parseJsonArray<MorningBriefPodcastEpisode>(row.podcast_episodes),
    createdAt: row.created_at,
  };
}
