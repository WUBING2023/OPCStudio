import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.join(HERE, relative), "utf8");

describe("agent details navigation contract", () => {
  const panel = read("AgentDetailsPanel.tsx");
  const memories = read("MemoryLessons.tsx");
  const app = read("../App.tsx");
  const navigation = read("../lib/navigation.ts");
  const memoryPage = read("../pages/MemoryPage.tsx");

  it("opens a recent run by its durable run id", () => {
    expect(panel).toContain("run.id && openRun(run.id)");
    expect(navigation).toContain('navigateApp({ page: "results", runId, companyId })');
    expect(app).toContain('window.addEventListener("open-task-run"');
  });

  it("opens memory pack and lesson cards by stable memory id", () => {
    expect(memories).toContain("memoryId: item.memoryId");
    expect(memories).toContain("memoryId: l.id");
    expect(navigation).toContain('navigateApp({ page: "memory", memoryId: target.memoryId, companyId: target.companyId })');
    expect(app).toContain('sessionStorage.setItem("opc-open-memory"');
    expect(memoryPage).toContain("data-memory-id={focusedMemory.memoryId}");
    expect(memoryPage).toContain("scrollIntoView");
  });
});
