import dotenv from "dotenv";
import { pollWhatsappInboxOnce, startWhatsappScheduler, clearWhatsappAuthState } from "./whatsappPoller";
import { info } from "./logger";

dotenv.config();

async function main() {
  const command = process.argv[2] ? process.argv[2].toLowerCase() : "schedule";

  if (command === "once" || command === "poll") {
    info("Running a single WhatsApp polling session on demand.");
    await pollWhatsappInboxOnce();
    return;
  }

  if (command === "schedule") {
    info("Starting WhatsApp polling scheduler.");
    startWhatsappScheduler();
    return;
  }

  if (command === "clear-auth" || command === "reset-auth") {
    info("Clearing saved WhatsApp auth state.");
    await clearWhatsappAuthState();
    return;
  }

  info(`Unsupported command: ${command}. Use 'schedule', 'once', or 'clear-auth'.`);
}

main().catch((error) => {
  console.error("WhatsApp service failed:", error);
  process.exit(1);
});
