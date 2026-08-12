import { ConvexHttpClient } from "convex/browser";
import { convexUrl } from "./env";

let client: ConvexHttpClient | null = null;

/** The server-side Convex client. Created once per process. */
export function convex(): ConvexHttpClient {
  if (client === null) {
    client = new ConvexHttpClient(convexUrl());
  }
  return client;
}
