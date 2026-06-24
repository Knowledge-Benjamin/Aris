import express from "express";
import { json } from "express";
import arisRouter from "./routes/aris";
import searchRouter from "./routes/search";
import authRouter from "./routes/auth";
import googleRouter from "./routes/google";
import whatsappRouter from "./routes/whatsapp";
import rateLimit from "express-rate-limit";

export const app = express();

app.use(json({ limit: "50mb" }));

// Tighten CORS
const allowedOrigin = process.env.CLI_BASE_URL || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Global Request Timeout
app.use((req, res, next) => {
  req.setTimeout(60000, () => {
    res.status(408).send('Request Timeout');
  });
  next();
});

// Rate limiting for Aris API endpoints
const arisLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per `window` (here, per minute)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "aris" }));
app.use("/api/auth", authRouter);
app.use("/api/aris", arisLimiter, arisRouter);
app.use("/api/search", searchRouter);
app.use("/api/google", googleRouter);
app.use("/api/whatsapp", whatsappRouter);

app.use((_, res) => {
  res.status(404).json({ error: "Route not found" });
});
