import path from "path";
import puppeteer from "puppeteer";
import { info, error } from "../utils/logger";

export interface BrowserReadResult {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  screenshotBase64?: string;
  warnings: string[];
}

export interface BrowserAction {
  type: "click" | "type" | "press" | "evaluate" | "screenshot";
  selector?: string;
  text?: string;
  key?: string;
  script?: string;
  fullPage?: boolean;
}

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.RESEARCH_BROWSER_TIMEOUT_MS || 30000);
const MAX_CONTENT_CHARS = Number(process.env.RESEARCH_BROWSER_MAX_CONTENT_CHARS || 30000);

export class ResearchBrowserService {
  private browser: any = null;
  private page: any = null;
  private operationQueue: Promise<void> = Promise.resolve();

  private async runIsolated<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.operationQueue;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      await this.close();
      release();
    }
  }

  private async ensurePage() {
    const browserConnected = this.browser && (
      typeof this.browser.isConnected === "function"
        ? this.browser.isConnected()
        : this.browser.connected !== false
    );
    if (!browserConnected) {
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath();
      info(`[researchBrowser] launching Chromium executable=${executablePath}`);
      this.browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: process.env.RESEARCH_BROWSER_USER_DATA_DIR || path.resolve(process.cwd(), ".research-browser-profile"),
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
      await this.page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36");
    }
    return this.page;
  }

  private validateUrl(url: string) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Research browser only supports HTTP and HTTPS URLs.");
    }
    return parsed.toString();
  }

  async search(query: string, limit = 8): Promise<{ query: string; results: BrowserSearchResult[]; url: string }> {
    return this.runIsolated(async () => {
      const page = await this.ensurePage();
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      info(`[researchBrowser] searching query="${query}" limit=${limit}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
      const results = await page.evaluate((maxResults: number) => Array.from(document.querySelectorAll("a"))
        .map((anchor) => ({
          title: (anchor.querySelector("h3")?.textContent || anchor.textContent || "").trim(),
          url: (anchor as HTMLAnchorElement).href,
          snippet: (anchor.parentElement?.parentElement?.textContent || "").replace(/\s+/g, " ").trim(),
        }))
        .filter((result) => result.title && /^https?:\/\//i.test(result.url) && !result.url.includes("google.com"))
        .filter((result, index, all) => all.findIndex((candidate) => candidate.url === result.url) === index)
        .slice(0, maxResults), limit);
      if (results.length === 0) {
        const fallbackUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        info(`[researchBrowser] Google returned no results; trying DuckDuckGo fallback url=${fallbackUrl}`);
        await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
        const fallbackResults = await page.evaluate((maxResults: number) => Array.from(document.querySelectorAll("a.result__a"))
          .map((anchor) => ({
            title: (anchor.textContent || "").trim(),
            url: (anchor as HTMLAnchorElement).href,
            snippet: (anchor.parentElement?.parentElement?.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          .filter((result) => result.title && /^https?:\/\//i.test(result.url))
          .slice(0, maxResults), limit);
        results.push(...fallbackResults);
        info(`[researchBrowser] DuckDuckGo fallback completed resultCount=${fallbackResults.length} pageUrl=${page.url()}`);
      }
      info(`[researchBrowser] search completed resultCount=${results.length} pageUrl=${page.url()}`);
      return { query, results, url: page.url() };
    });
  }

  private validateResearchAction(action: BrowserAction) {
    const serialized = JSON.stringify(action).toLowerCase();
    if (/submit|sign.?in|log.?in|purchase|checkout|send|delete|payment|password|credential/.test(serialized)) {
      throw new Error("Browser research actions cannot submit forms, authenticate, purchase, send, delete, or handle credentials.");
    }
  }

  async readUrls(urls: string[], includeScreenshot = false): Promise<BrowserReadResult[]> {
    return this.runIsolated(() => this.readUrlsInternal(urls, includeScreenshot));
  }

  private async readUrlsInternal(urls: string[], includeScreenshot = false): Promise<BrowserReadResult[]> {
    const results: BrowserReadResult[] = [];
    info(`[researchBrowser] starting read batch size=${Math.min(urls.length, 8)} includeScreenshot=${includeScreenshot}`);
    const page = await this.ensurePage();
    for (const rawUrl of urls.slice(0, 8)) {
      let url = String(rawUrl);
      const warnings: string[] = [];
      try {
        url = this.validateUrl(rawUrl);
        info(`[researchBrowser] navigating url=${url}`);
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => undefined);
        const extracted = await page.evaluate((maxChars: number) => {
          for (const element of Array.from(document.querySelectorAll("script, style, noscript, nav, footer, header, aside"))) element.remove();
          const root = (document.querySelector("article, main") || document.body) as HTMLElement;
          return {
            title: document.title,
            content: (root?.innerText || document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars),
          };
        }, MAX_CONTENT_CHARS);
        if (!extracted.content) warnings.push("The page contained no readable DOM text.");
        if ((response?.status() || 0) >= 400) warnings.push(`HTTP ${response.status()} response.`);
        const screenshotBase64 = includeScreenshot
          ? await page.screenshot({ encoding: "base64", fullPage: false })
          : undefined;
        results.push({
          url,
          finalUrl: page.url(),
          title: extracted.title || url,
          content: extracted.content,
          screenshotBase64,
          warnings,
        });
        info(`[researchBrowser] completed url=${url} status=${response?.status() || "unknown"} contentChars=${extracted.content.length} warnings=${warnings.length}`);
      } catch (browserError: any) {
        const message = browserError?.message || String(browserError);
        const failedUrl = url || String(rawUrl);
        error(`[researchBrowser] failed url=${failedUrl} message=${message}`);
        results.push({ url: failedUrl, finalUrl: page.url(), title: "", content: "", warnings: [`Browser read failed: ${message}`] });
      }
    }
    info(`[researchBrowser] finished read batch requested=${urls.length} processed=${results.length} readable=${results.filter((result) => result.content.trim()).length} failed=${results.filter((result) => !result.content.trim()).length}`);
    return results;
  }

  async act(action: BrowserAction): Promise<Record<string, unknown>> {
    return this.runIsolated(() => this.actInternal(action));
  }

  private async actInternal(action: BrowserAction): Promise<Record<string, unknown>> {
    const page = await this.ensurePage();
    try {
      this.validateResearchAction(action);
      if (action.type === "click") {
        if (!action.selector) throw new Error("browser click requires selector");
        await page.click(action.selector, { timeout: DEFAULT_TIMEOUT_MS });
        return { type: action.type, url: page.url(), title: await page.title() };
      }
      if (action.type === "type") {
        if (!action.selector || action.text === undefined) throw new Error("browser type requires selector and text");
        await page.click(action.selector, { clickCount: 3, timeout: DEFAULT_TIMEOUT_MS });
        await page.type(action.selector, action.text);
        return { type: action.type, url: page.url(), title: await page.title() };
      }
      if (action.type === "press") {
        if (!action.key) throw new Error("browser press requires key");
        await page.keyboard.press(action.key);
        return { type: action.type, url: page.url(), title: await page.title() };
      }
      if (action.type === "evaluate") {
        if (!action.script) throw new Error("browser evaluate requires script");
        const value = await page.evaluate((script: string) => Function(`"use strict"; return (${script})`)(), action.script);
        return { type: action.type, value: typeof value === "string" ? value.slice(0, MAX_CONTENT_CHARS) : value, url: page.url() };
      }
      const screenshotBase64 = await page.screenshot({ encoding: "base64", fullPage: Boolean(action.fullPage) });
      return { type: "screenshot", screenshotBase64, url: page.url(), title: await page.title() };
    } catch (error: any) {
      const diagnostics = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
      })).catch(() => ({ title: "", text: "" }));
      const screenshotBase64 = await page.screenshot({ encoding: "base64", fullPage: false }).catch(() => undefined);
      return {
        type: action.type,
        success: false,
        error: error?.message || String(error),
        url: page.url(),
        title: diagnostics.title,
        domText: diagnostics.text,
        screenshotBase64,
      };
    }
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }
}
