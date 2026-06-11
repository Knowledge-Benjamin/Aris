import { Request, Response } from "express";
import { SearchClient } from "../services/searchClient";
import { MemoryStore, SemanticMemoryResult } from "../db/memoryStore";
import { getDatabasePool } from "../db/db";

const searchClient = new SearchClient();
const memoryStore = new MemoryStore(getDatabasePool());

export async function performSearch(req: Request, res: Response) {
  try {
    const { query, engines, limit } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query is required" });
    }

    const response = await searchClient.search({ query, engines, limit });
    res.json(response);
  } catch (error) {
    console.error("searchController error", error);
    res.status(500).json({ error: "Search service unavailable or returned an error" });
  }
}

export async function performSemanticSearch(req: Request, res: Response) {
  try {
    const { query, limit = 5, userId, sessionId } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query is required" });
    }

    if (!userId && !sessionId) {
      return res.status(400).json({ error: "userId or sessionId is required for semantic search" });
    }

    const results: SemanticMemoryResult[] = await memoryStore.getSemanticMemories(
      typeof userId === "number" ? userId : undefined,
      typeof sessionId === "string" ? sessionId : undefined,
      query,
      Number(limit)
    );

    res.json({ query, results });
  } catch (error) {
    console.error("semanticSearchController error", error);
    res.status(500).json({ error: "Semantic search failed" });
  }
}
