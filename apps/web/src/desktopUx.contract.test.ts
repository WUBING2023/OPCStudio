import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf8");
const DICTS = JSON.parse(read("i18n.dict.json")) as Record<string, Record<string, string>>;

describe("desktop task dispatch status UX", () => {
  it("all dispatch entry points announce only after chatTask returns", () => {
    for (const rel of ["lib/useTaskChat.ts", "components/LaunchPad.tsx", "pages/CockpitPage.tsx"]) {
      const source = read(rel);
      const declaration = source.indexOf("const r = await api.chatTask");
      const announcement = source.indexOf("announceRunUiState(r, t");
      expect(declaration, rel).toBeGreaterThan(-1);
      expect(announcement, rel).toBeGreaterThan(declaration);
    }
  });

  it("CEO cockpit consumes optimistic and durable run lifecycle states", () => {
    const source = read("components/common/CeoCockpit.tsx");
    expect(source).toContain("RUN_UI_STATE_EVENT");
    expect(source).toContain('e.type === "run_started"');
    expect(source).toContain('e.type === "run_finished"');
  });
});

describe("results and archive wording", () => {
  it("failed coding runs select the failed empty-output copy from task metadata", () => {
    const changes = read("components/trace/ChangesSection.tsx");
    const trace = read("pages/TracePage.tsx");
    expect(changes).toContain("emptyChangesMessageKey(taskMeta)");
    expect(changes).toContain('acceptance?.status === "no_delivery"');
    expect(trace).toContain("taskMeta={taskMeta}");
  });

  it("English and Simplified Chinese contain archive and failure/status copy", () => {
    for (const lang of ["en", "zh-CN"]) {
      expect(DICTS[lang]["archive.runs.entry"], lang).toBeTruthy();
      expect(DICTS[lang]["archive.runs.desc"], lang).toBeTruthy();
      expect(DICTS[lang]["trace.changes.emptyFailedCode"], lang).toBeTruthy();
    }
  });
});
