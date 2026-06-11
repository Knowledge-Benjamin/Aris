import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";

const envPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../..", ".env"),
];
for (const envPath of envPaths) {
  if (envPath) {
    dotenv.config({ path: envPath });
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for WhatsApp service database access.");
}

const normalizedDataSource = normalizeConnectionString(databaseUrl);
const pool = new Pool({ connectionString: normalizedDataSource });

export function getDatabasePool() {
  return pool;
}

export function normalizeConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    const sslmode = url.searchParams.get("sslmode")?.toLowerCase();
    const useLibpqCompat = url.searchParams.get("uselibpqcompat")?.toLowerCase();

    if (!sslmode) {
      url.searchParams.set("sslmode", "verify-full");
    } else if (["prefer", "require", "verify-ca"].includes(sslmode) && useLibpqCompat !== "true") {
      url.searchParams.set("sslmode", "verify-full");
    }

    return url.toString();
  } catch {
    return connectionString;
  }
}
