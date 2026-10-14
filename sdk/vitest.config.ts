import { defineConfig } from "vitest/config";

export default defineConfig({
  // No CSS here; an inline PostCSS config stops Vite from searching parent directories for one.
  css: { postcss: {} },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
