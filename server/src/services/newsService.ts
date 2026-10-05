import Parser from "rss-parser";
import { info, error } from "../utils/logger";
import axios from "axios";

const DEFAULT_PODCAST_FEED = "https://feeds.npr.org/500005/podcast.xml";

export interface PodcastCandidate {
  feedName: string;
  feedUrl: string;
  episodeUrl: string;
  title: string;
  publishedAt: string;
  mimeType: string;
}

export interface DownloadedPodcast extends PodcastCandidate {
  audio: Buffer;
}

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

export class NewsService {
  private parser: Parser;

  constructor() {
    this.parser = new Parser({
      customFields: {
        item: [
          ['source', 'source']
        ]
      }
    });
  }

  async getTopNews(topic?: string, limit: number = 5): Promise<NewsItem[]> {
    try {
      let url = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
      
      if (topic) {
        url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
      }

      info(`[newsService] Fetching news from ${url}`);
      const feed = await this.parser.parseURL(url);
      
      const items = feed.items.slice(0, limit).map((item) => {
        let sourceName = item.source || "Google News";
        if (typeof sourceName === 'object' && sourceName._) {
          sourceName = sourceName._;
        }

        return {
          title: item.title || "No Title",
          link: item.link || "",
          pubDate: item.pubDate || new Date().toISOString(),
          source: sourceName,
        };
      });

      return items;
    } catch (err: any) {
      error(`[newsService] Failed to fetch news: ${err.message}`);
      throw new Error(`Failed to fetch news: ${err.message}`);
    }
  }

  async getBestPodcastCandidates(limit = 4): Promise<PodcastCandidate[]> {
      const configuredFeeds = (process.env.NEWS_PODCAST_RSS_URL || "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);
      const feedUrls = [...new Set([...configuredFeeds, DEFAULT_PODCAST_FEED])];
      const candidates: PodcastCandidate[] = [];

      for (const feedUrl of feedUrls) {
        const feed = await this.parser.parseURL(feedUrl);
        for (const item of feed.items) {
          const rawItem = item as typeof item & { enclosure?: { url?: string; type?: string } };
          const episodeUrl = rawItem.enclosure?.url;
          if (!episodeUrl || !/^https?:\/\//i.test(episodeUrl)) continue;
          candidates.push({
            feedName: feed.title || new URL(feedUrl).hostname,
            feedUrl,
            episodeUrl,
            title: item.title || "Untitled podcast episode",
            publishedAt: item.pubDate || "",
            mimeType: rawItem.enclosure?.type || "audio/mpeg",
          });
        }
      }

      const unique = [...new Map(candidates.map((candidate) => [candidate.episodeUrl, candidate])).values()]
        .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
      return unique.slice(0, Math.max(0, Math.min(20, Math.floor(limit))));
    }

  async downloadPodcastCandidate(candidate: PodcastCandidate): Promise<DownloadedPodcast> {
    return this.downloadPodcast(candidate);
  }

  async downloadLatestPodcast(feedUrl?: string): Promise<DownloadedPodcast> {
    const candidate = await this.getLatestPodcastCandidate(feedUrl);
    return this.downloadPodcast(candidate);
  }

  async getLatestPodcastCandidate(feedUrl?: string): Promise<PodcastCandidate> {
    const url = feedUrl?.trim() || process.env.NEWS_PODCAST_RSS_URL?.split(",")[0]?.trim() || DEFAULT_PODCAST_FEED;
    const feed = await this.parser.parseURL(url);
    const item = feed.items.find((entry) => {
      const enclosure = (entry as typeof entry & { enclosure?: { url?: string } }).enclosure;
      return typeof enclosure?.url === "string" && /^https?:\/\//i.test(enclosure.url);
    });
    const enclosure = item && (item as typeof item & { enclosure?: { url?: string; type?: string } }).enclosure;
    if (!item || !enclosure?.url) {
      throw new Error(`No downloadable podcast episode was found in feed ${url}.`);
    }

    return {
      feedName: feed.title || new URL(url).hostname,
      feedUrl: url,
      episodeUrl: enclosure.url,
      title: item.title || "Untitled podcast episode",
      publishedAt: item.pubDate || "",
      mimeType: enclosure.type || "audio/mpeg",
    };
  }

  private async downloadPodcast(candidate: PodcastCandidate): Promise<DownloadedPodcast> {
    const response = await axios.get<ArrayBuffer>(candidate.episodeUrl, {
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });
    const contentType = response.headers["content-type"];
    const mimeType = typeof contentType === "string"
      ? contentType.split(";")[0].trim()
      : candidate.mimeType.split(";")[0].trim();
    return { ...candidate, mimeType, audio: Buffer.from(response.data) };
  }
}
