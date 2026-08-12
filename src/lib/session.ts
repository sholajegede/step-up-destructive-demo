import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { EncryptJWT, jwtDecrypt } from "jose";
import { sessionSecret } from "./env";

/**
 * Encrypted cookie sessions.
 *
 * Two cookies, with different lifetimes and different jobs:
 *
 * - the session cookie holds the token set for the signed-in person;
 * - the transaction cookie holds the PKCE verifier, state, and nonce for one
 *   in-flight authorize request, and is deleted the moment it is consumed.
 *
 * Both are encrypted (JWE, A256GCM), so the browser cannot read or edit them.
 * Encryption matters here beyond confidentiality: the transaction cookie
 * carries the PKCE verifier, and a readable verifier would defeat PKCE.
 */

const SESSION_COOKIE = "sud_session";
const TRANSACTION_COOKIE = "sud_tx";

/** Browsers cap a cookie near 4096 bytes, so payloads are split. */
const CHUNK_SIZE = 3000;
const MAX_CHUNKS = 8;

export type SessionData = {
  /** Access token, presented on every tool call. */
  accessToken: string;
  /** ID token, the source of the identity claims shown in the UI. */
  idToken?: string;
  /** Refresh token, when the provider issued one. */
  refreshToken?: string;
  /** Access-token expiry, seconds since epoch. */
  expiresAt?: number;
  /** Subject of the signed-in person. */
  subject: string;
  /**
   * `auth_time` observed when this session was established or last refreshed.
   *
   * Kept for display and for comparison against the token presented at the
   * destructive call. It is never the thing the seam trusts — the seam reads
   * `auth_time` out of the verified token every time.
   */
  authTime?: number;
};

export type TransactionData = {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  /** `max_age` sent on the authorize request, recorded for the audit trail. */
  maxAge?: number;
  /** True when this authorize request was a step-up challenge. */
  stepUp: boolean;
};

function encryptionKey(): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(sessionSecret()).digest(),
  );
}

async function seal(payload: object, ttlSeconds: number): Promise<string> {
  return await new EncryptJWT({ data: payload })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(encryptionKey());
}

async function unseal<T>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtDecrypt(token, encryptionKey());
    return (payload as { data?: T }).data ?? null;
  } catch {
    // Tampered, expired, or encrypted under a rotated secret. All three mean
    // "no session", which is the safe reading.
    return null;
  }
}

function chunk(value: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    parts.push(value.slice(i, i + CHUNK_SIZE));
  }
  if (parts.length > MAX_CHUNKS) {
    throw new Error(
      `Session payload needs ${parts.length} cookie chunks, over the ${MAX_CHUNKS} limit.`,
    );
  }
  return parts;
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

async function writeChunked(
  name: string,
  value: string,
  maxAge: number,
): Promise<void> {
  const store = await cookies();
  const parts = chunk(value);
  parts.forEach((part, index) => {
    store.set(`${name}.${index}`, part, { ...cookieOptions, maxAge });
  });
  // Clear any chunks left over from a previously longer value.
  for (let index = parts.length; index < MAX_CHUNKS; index += 1) {
    if (store.get(`${name}.${index}`) !== undefined) {
      store.set(`${name}.${index}`, "", { ...cookieOptions, maxAge: 0 });
    }
  }
}

async function readChunked(name: string): Promise<string | null> {
  const store = await cookies();
  const parts: string[] = [];
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    const part = store.get(`${name}.${index}`);
    if (part === undefined || part.value === "") break;
    parts.push(part.value);
  }
  return parts.length === 0 ? null : parts.join("");
}

async function clearChunked(name: string): Promise<void> {
  const store = await cookies();
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    if (store.get(`${name}.${index}`) !== undefined) {
      store.set(`${name}.${index}`, "", { ...cookieOptions, maxAge: 0 });
    }
  }
}

export async function saveSession(data: SessionData): Promise<void> {
  await writeChunked(SESSION_COOKIE, await seal(data, 60 * 60 * 8), 60 * 60 * 8);
}

export async function readSession(): Promise<SessionData | null> {
  const raw = await readChunked(SESSION_COOKIE);
  return raw === null ? null : await unseal<SessionData>(raw);
}

export async function clearSession(): Promise<void> {
  await clearChunked(SESSION_COOKIE);
}

export async function saveTransaction(data: TransactionData): Promise<void> {
  // Ten minutes is long enough to finish a login, including MFA, and short
  // enough that an abandoned authorize request stops being replayable.
  await writeChunked(TRANSACTION_COOKIE, await seal(data, 600), 600);
}

/**
 * Reads the in-flight authorize transaction and deletes it in the same step.
 *
 * Single-use by construction: a replayed callback finds nothing and fails the
 * state check.
 */
export async function consumeTransaction(): Promise<TransactionData | null> {
  const raw = await readChunked(TRANSACTION_COOKIE);
  await clearChunked(TRANSACTION_COOKIE);
  return raw === null ? null : await unseal<TransactionData>(raw);
}
