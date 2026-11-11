import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { ONFILE_DB: "memory", APP_SECRET: "test-secret-test-secret-test-secret-0123", APP_URL: "http://localhost:3000" },
  },
});
