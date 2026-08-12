import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests that talk to the Convex deployment read the same .env.local the
    // app reads, so the registry is checked where it actually lives.
    setupFiles: ["tests/setup/load-env.ts"],
  },
});
