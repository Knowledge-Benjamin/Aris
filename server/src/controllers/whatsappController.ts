import { Request, Response } from "express";
import { WhatsappService } from "../services/whatsappService";
import { GemmaService } from "../services/gemmaService";

const whatsappService = new WhatsappService(new GemmaService());

export async function summarizeWhatsappMessages(req: Request, res: Response) {
  try {
    const result = await whatsappService.summarizePendingMessages();
    res.json(result);
  } catch (error) {
    console.error("whatsappController error", error);
    res.status(500).json({ error: "WhatsApp summarization failed" });
  }
}
