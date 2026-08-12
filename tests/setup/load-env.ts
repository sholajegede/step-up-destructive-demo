import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads .env.local into process.env for the test run.
 *
 * Values already present in the environment win, so CI can override without
 * editing a file. Nothing is logged: this reads secrets and must stay silent.
 */
function loadEnvFile(filename: string): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), filename), "utf8");
  } catch {
    return;
  }

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "" || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(".env.local");
