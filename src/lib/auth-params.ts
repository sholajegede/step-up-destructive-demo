/**
 * Parsing for the hints a caller may attach to a login request.
 *
 * Everything here is a hint carried to the provider — never proof. Each value
 * is validated so a caller cannot smuggle something odd onto the authorize
 * URL or turn the callback into an open redirect.
 */

/** Seconds. `0` demands an interactive authentication now. */
export function parseMaxAge(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  // `Number("")` and `Number(" ")` are both 0, which would turn an empty
  // `max_age=` into a demand for a full interactive re-authentication. An
  // absent value must stay absent.
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 86400) return undefined;
  return value;
}

export function parsePrompt(
  raw: string | null,
): "login" | "none" | "consent" | undefined {
  if (raw === "login" || raw === "none" || raw === "consent") return raw;
  return undefined;
}

/**
 * Same-origin paths only.
 *
 * Anything absolute, protocol-relative, or otherwise not a plain path is
 * replaced with "/", so the callback cannot be turned into an open redirect.
 */
export function safeReturnTo(raw: string | null): string {
  if (raw === null) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
