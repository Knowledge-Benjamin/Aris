import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required in environment variables.");
}

const normalizedConnectionString = normalizeConnectionString(connectionString);

function normalizeConnectionString(connectionString: string) {
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

let pool: Pool | null = null;

export function getDatabasePool() {
  if (!pool) {
    const isLocalhost = connectionString ? (connectionString.includes('localhost') || connectionString.includes('127.0.0.1')) : false;
    pool = new Pool({ 
      connectionString: normalizedConnectionString,
      // Cloud databases like Neon require SSL. We enforce it unless running a local dev DB.
      ssl: isLocalhost ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}
