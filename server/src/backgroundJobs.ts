import { PlannerService } from "./services/plannerService";
import { GemmaService } from "./services/gemmaService";
import { getDatabasePool } from "./db/db";
import { GoogleAccountStore } from "./db/googleAccountStore";
import { info } from "./utils/logger";

const pool = getDatabasePool();
const gemmaService = new GemmaService();
const plannerService = new PlannerService(gemmaService);
const googleAccountStore = new GoogleAccountStore(pool);

export function startBackgroundJobs() {
  info("[BackgroundJobs] Starting async random-interval ingestion loop to prevent WhatsApp bot ban.");
  scheduleNextIngestion();
}

function scheduleNextIngestion() {
  // Random interval between 0 and 2 hours (0 to 7200000 ms)
  const nextRunMs = Math.floor(Math.random() * 7200000);
  info(`[BackgroundJobs] Next ingestion scheduled in ${Math.round(nextRunMs / 60000)} minutes.`);
  
  setTimeout(async () => {
    await runIngestionCycle();
    scheduleNextIngestion(); // Reschedule recursively
  }, nextRunMs);
}

async function runIngestionCycle() {
  try {
    info("[BackgroundJobs] Running ingestion cycle for all users.");
    const res = await pool.query(`SELECT id FROM users`);
    
    for (const row of res.rows) {
      const userId = row.id;
      const googleAccount = await googleAccountStore.getGoogleAccount(userId);
      await plannerService.ingestRecentContext(userId, googleAccount);
      
      // We will also occasionally trigger the daily plan here (e.g. if time is between 6 AM and 8 AM)
      const hour = new Date().getHours();
      if (hour >= 6 && hour <= 8) {
        // We could add a check if it already ran today, for now just trigger it
        await plannerService.generateDailyPlan(userId, googleAccount);
      }
    }
  } catch (err) {
    console.error("[BackgroundJobs] Error in ingestion cycle", err);
  }
}
