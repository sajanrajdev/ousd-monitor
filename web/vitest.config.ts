import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fromHere("."),
      // The real entry throws outside React's server build, and tests aren't one.
      "server-only": fromHere("node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    // Tests never read data/, where a real run may be in progress.
    env: { OUSD_DATASET_DIR: "fixtures/dataset/complete" },
  },
});
