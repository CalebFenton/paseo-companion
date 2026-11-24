import { defineConfig } from "vitest/config";

/** Live: deploys to the local daemon, which needs Paseo, gh, and omp signed in. */
export default defineConfig({
  test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 120_000, hookTimeout: 60_000 },
});
