"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDatabasePool = getDatabasePool;
const dotenv_1 = __importDefault(require("dotenv"));
const pg_1 = require("pg");
dotenv_1.default.config();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is required in environment variables.");
}
const normalizedConnectionString = normalizeConnectionString(connectionString);
function normalizeConnectionString(connectionString) {
    try {
        const url = new URL(connectionString);
        const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
        const useLibpqCompat = url.searchParams.get("uselibpqcompat")?.toLowerCase();
        if (!sslmode) {
            url.searchParams.set("sslmode", "verify-full");
        }
        else if (["prefer", "require", "verify-ca"].includes(sslmode) && useLibpqCompat !== "true") {
            url.searchParams.set("sslmode", "verify-full");
        }
        return url.toString();
    }
    catch {
        return connectionString;
    }
}
let pool = null;
function getDatabasePool() {
    if (!pool) {
        pool = new pg_1.Pool({ connectionString: normalizedConnectionString });
    }
    return pool;
}
