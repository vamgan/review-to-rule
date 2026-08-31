import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real Semgrep integration cases are process-heavy. Bounding workers keeps
    // Vitest's RPC channel responsive and makes the release gate deterministic.
    maxWorkers: 2,
  },
});
