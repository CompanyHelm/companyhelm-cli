import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
