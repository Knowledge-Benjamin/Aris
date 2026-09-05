// eslint-disable-next-line @typescript-eslint/no-var-requires
const { launch, getStream } = require('puppeteer-stream');
import { info, error } from '../utils/logger';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

export class MeetingBotService extends EventEmitter {
  private browser: any = null;
  private activePage: any = null;
  private audioStream: Readable | null = null;

  async joinMeeting(url: string, botName: string): Promise<void> {
    try {
      info(`[MeetingBot] Launching headless browser for ${url}`);
      this.browser = await launch({
        headless: false, // Often required to bypass some bot detection, but can try true later
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-infobars',
          '--window-position=0,0',
          '--ignore-certifcate-errors',
          '--ignore-certifcate-errors-spki-list',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      });

      this.activePage = await this.browser.newPage();
      
      // Spoof user agent
      await this.activePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Setup audio streaming
      info(`[MeetingBot] Setting up audio capture stream`);
      this.audioStream = await getStream(this.activePage, { audio: true, video: false });
      
      if (this.audioStream) {
        this.audioStream.on('data', (chunk: Buffer) => {
          // Emit audio chunks to be processed by plannerService
          this.emit('audioChunk', chunk);
        });
      }

      info(`[MeetingBot] Navigating to ${url}`);
      await this.activePage.goto(url, { waitUntil: 'networkidle2' });

      // Automation logic to join the meeting
      if (url.includes('meet.google.com')) {
        await this.handleGoogleMeet(botName);
      } else if (url.includes('zoom.us')) {
        await this.handleZoom(botName);
      } else {
        throw new Error("Unsupported meeting platform. Only Google Meet and Zoom are supported.");
      }

    } catch (err) {
      error(`[MeetingBot] Error joining meeting:`, err);
      this.leaveMeeting();
      throw err;
    }
  }

  private async handleGoogleMeet(botName: string) {
    if (!this.activePage) return;
    
    // Wait for the name input field (this varies slightly depending on if signed in or not, but usually placeholder is 'Your name')
    try {
      await this.activePage.waitForSelector('input[placeholder="Your name"]', { timeout: 15000 });
      await this.activePage.type('input[placeholder="Your name"]', botName);
      
      // Click "Ask to join" or "Join"
      // Google uses span tags with "Ask to join" text. We can find it by text.
      const elements = await this.activePage.$$('span');
      let joined = false;
      for (const el of elements) {
        const text = await this.activePage.evaluate((e: any) => e.textContent, el);
        if (text && (text.includes('Ask to join') || text.includes('Join now'))) {
          await el.click();
          joined = true;
          break;
        }
      }
      
      if (!joined) {
        info("[MeetingBot] Could not find the join button automatically.");
      } else {
        info("[MeetingBot] Clicked Join. Waiting in lobby to be admitted...");
      }
    } catch (err) {
      error("[MeetingBot] Failed to navigate Google Meet lobby.", err);
    }
  }

  private async handleZoom(botName: string) {
    if (!this.activePage) return;
    // Zoom web SDK requires forcing web client. Usually `?wc=true` or clicking "Join from browser"
    // For simplicity in this brainstorm/implementation, assume the URL already drops us into the web client or we find the input.
    try {
      await this.activePage.waitForSelector('input[name="inputname"]', { timeout: 15000 });
      await this.activePage.type('input[name="inputname"]', botName);
      
      const joinBtn = await this.activePage.$('#joinBtn');
      if (joinBtn) {
        await joinBtn.click();
        info("[MeetingBot] Clicked Zoom Join button.");
      }
    } catch (err) {
      error("[MeetingBot] Failed to navigate Zoom lobby.", err);
    }
  }

  leaveMeeting() {
    info(`[MeetingBot] Leaving meeting and cleaning up`);
    if (this.audioStream) {
      this.audioStream.destroy();
      this.audioStream = null;
    }
    if (this.browser) {
      this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.activePage = null;
    this.emit('left');
  }
}
