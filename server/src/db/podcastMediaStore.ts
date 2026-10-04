import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export interface PodcastMediaRecord {
  episodeUrl: string;
  feedUrl: string;
  feedName: string;
  title: string;
  publishedAt: string;
  mimeType: string;
  storageUri: string;
  analysis: string;
}

export const podcastMediaStore = {
  async findByEpisodeUrl(episodeUrl: string): Promise<PodcastMediaRecord | undefined> {
    const result = await pool.query(
      `SELECT episode_url, feed_url, feed_name, title, published_at, mime_type, storage_uri, analysis
       FROM podcast_media WHERE episode_url = $1 LIMIT 1`,
      [episodeUrl]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  },

  async upsert(record: PodcastMediaRecord): Promise<void> {
    await pool.query(
      `INSERT INTO podcast_media
       (episode_url, feed_url, feed_name, title, published_at, mime_type, storage_uri, analysis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (episode_url) DO UPDATE SET
         feed_url = EXCLUDED.feed_url,
         feed_name = EXCLUDED.feed_name,
         title = EXCLUDED.title,
         published_at = EXCLUDED.published_at,
         mime_type = EXCLUDED.mime_type,
         storage_uri = EXCLUDED.storage_uri,
         analysis = EXCLUDED.analysis,
         updated_at = NOW()`,
      [record.episodeUrl, record.feedUrl, record.feedName, record.title, record.publishedAt, record.mimeType, record.storageUri, record.analysis]
    );
  },
};

function mapRow(row: any): PodcastMediaRecord {
  return {
    episodeUrl: row.episode_url,
    feedUrl: row.feed_url,
    feedName: row.feed_name,
    title: row.title,
    publishedAt: row.published_at,
    mimeType: row.mime_type,
    storageUri: row.storage_uri,
    analysis: row.analysis || "",
  };
}
