import { Router } from "express";
import { performSearch, performSemanticSearch } from "../controllers/searchController";

const router = Router();
router.post("/", performSearch);
router.post("/semantic", performSemanticSearch);

export default router;
