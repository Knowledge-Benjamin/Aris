import dotenv from "dotenv";
import * as ngrok from "@ngrok/ngrok";
import { Server } from "http";

dotenv.config();

function readPort(): number {
  const value = process.env.SERVER_PORT?.trim();
  const port = value ? Number(value) : 4000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SERVER_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

async function startServer(): Promise<void> {
  const port = readPort();
  const { app } = await import("./app");
  const { startBackgroundJobs } = await import("./backgroundJobs");
  const server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(port);
    listeningServer.once("error", reject);
    listeningServer.once("listening", () => {
      listeningServer.off("error", reject);
      resolve(listeningServer);
    });
  });
  const localUrl = `http://localhost:${port}`;
  app.locals.publicBaseUrl = localUrl;

  console.log(`Aris server listening on ${localUrl}`);
  startBackgroundJobs();

  const authToken = process.env.NGROK_AUTHTOKEN?.trim();
  const domain = process.env.NGROK_DOMAIN?.trim();
  let tunnelStarted = false;

  if (!authToken || /^(replace[-_ ]|your[-_ ])/i.test(authToken)) {
    console.info("[ngrok] Tunnel disabled; set NGROK_AUTHTOKEN and NGROK_DOMAIN to enable it.");
  } else {
    try {
      const listener = await ngrok.forward({
        addr: `localhost:${port}`,
        authtoken: authToken,
        ...(domain && !isPlaceholder(domain) ? { domain } : {}),
      });
      app.locals.publicBaseUrl = listener.url();
      tunnelStarted = true;
      console.log(`[ngrok] Public server URL: ${listener.url()}`);
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      console.error("[ngrok] Failed to start the configured tunnel.", error);
      throw new Error("Failed to start the configured ngrok tunnel.");
    }
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; closing the server and ngrok tunnel.`);
    void (async () => {
      if (tunnelStarted) {
        try {
          await ngrok.kill();
        } catch (error) {
          console.error("[ngrok] Failed to close tunnel cleanly.", error);
        }
      }
      server.close((error) => {
        if (error) {
          console.error("Failed to close HTTP server cleanly.", error);
          process.exitCode = 1;
        }
      });
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startServer().catch((error) => {
  console.error("Aris server failed to start:", error);
  process.exitCode = 1;
});
