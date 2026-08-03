import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.test.ts", "apps/web/src/**/*.test.ts", "apps/cli/src/**/*.test.ts"],
    exclude: ["apps/server/src/runtime/orchestrator.test.ts"],
    env: { OPC_STORAGE_BACKEND: "json" },
    maxWorkers: 4,
    minWorkers: 1
  }
});
