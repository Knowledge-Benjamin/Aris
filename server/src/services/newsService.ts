import Parser from "rss-parser";
import { info, error } from "../utils/logger";

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
}
