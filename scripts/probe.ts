import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

for (const l of readFileSync(".env.local", "utf8").split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) process.env[l.slice(0, i).trim()] ??= l.slice(i + 1).trim();
}
const url = process.env.NEXT_PUBLIC_CONVEX_URL!;
console.log("URL:", JSON.stringify(url));
const c = new ConvexHttpClient(url);
try {
  const m = await c.query((anyApi as any).audit.metrics, {});
  console.log("metrics OK:", JSON.stringify(m));
} catch (e: any) {
  console.log("QUERY FAILED:", e?.message);
  console.log("cause:", e?.cause?.message ?? e?.cause ?? "(none)");
}
