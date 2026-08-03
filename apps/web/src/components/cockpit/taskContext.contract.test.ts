import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf8");
const NAV = read("TaskContextNavigator.tsx");
const CHAT = read("ChatThread.tsx");
const BUBBLE = read("../common/MessageBubble.tsx");
const COCKPIT = read("../../pages/CockpitPage.tsx");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;

describe("cockpit task context contract", () => {
  it("renders every real run as a hoverable task tick and smoothly widens the selected tick", () => {
    expect(NAV).toContain("runs.map((run)");
    expect(NAV).toContain("title={title}");
    expect(NAV).toContain("transition-all duration-300");
    expect(NAV).toContain('active ? "w-8 h-[3px]');
  });

  it("uses durable task/event/artifact APIs for company, team and employee history", () => {
    expect(CHAT).toContain('url = "/runs?company="');
    expect(CHAT).toContain('"&agents="');
    expect(CHAT).toContain('"/runs?limit=50"');
    expect(CHAT).toContain('"/events"');
    expect(CHAT).toContain('"/artifacts"');
    expect(CHAT).toContain("artifact.producer === activeAgentId");
  });

  it("shows real registered output files with durable download links and task fallback", () => {
    expect(NAV).toContain("artifact.downloadUrl");
    expect(NAV).toContain("href={artifact.downloadUrl}");
    expect(NAV).toContain("openRun(selectedRunId)");
  });

  it("marks employee messages with the selected task context", () => {
    expect(CHAT).toContain("contextBadge={taskLabel}");
    expect(BUBBLE).toContain("contextBadge?: ReactNode");
    expect(BUBBLE).toContain("{contextBadge}");
  });

  it("sends additions only to a running task through the audited A2A instruction endpoint", () => {
    expect(COCKPIT).toContain('activeRunContext.status === "running"');
    expect(COCKPIT).toContain('"/agents/" + encodeURIComponent(targetId) + "/instruction"');
    expect(COCKPIT).toContain("runId: activeRunContext.runId");
    expect(COCKPIT).toContain("disabled={inputBlocked}");
  });

  it("has complete labels in English, Simplified Chinese and Traditional Chinese", () => {
    const keys = [
      "cockpit.taskContext.files", "cockpit.taskContext.tasks", "cockpit.taskContext.rail",
      "cockpit.taskContext.directChat", "cockpit.taskContext.noFiles",
      "cockpit.taskInstruction.hint", "cockpit.taskInstruction.ended",
    ];
    for (const lang of ["en", "zh-CN", "zh-TW"]) {
      for (const key of keys) expect(DICTS[lang]?.[key], lang + " missing " + key).toBeTruthy();
    }
  });
});
