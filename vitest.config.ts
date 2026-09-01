import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Packed CLI tests share one built dist/. Run files serially so a clean
    // rebuild cannot remove another file's executable or package exports.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
