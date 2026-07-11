import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadEnv(root) {
  const envPath = path.join(root, ".env");

  try {
    const content = await readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function hasDatabaseConfig() {
  return Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER);
}
