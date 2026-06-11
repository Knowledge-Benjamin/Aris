import express from "express";
import { json } from "express";
import arisRouter from "./routes/aris";
import searchRouter from "./routes/search";
import authRouter from "./routes/auth";
import googleRouter from "./routes/google";
import whatsappRouter from "./routes/whatsapp";

export const app = express();

app.use(json({ limit: "50mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "aris" }));
app.use("/api/auth", authRouter);
app.use("/api/aris", arisRouter);
app.use("/api/search", searchRouter);
app.use("/api/google", googleRouter);
app.use("/api/whatsapp", whatsappRouter);

app.use((_, res) => {
  res.status(404).json({ error: "Route not found" });
});
