import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesMemoryTime } from "./MemoryPage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, "MemoryPage.tsx"), "utf8");
const DICTS = JSON.parse(fs.readFileSync(path.join(HERE, "../i18n.dict.json"), "utf8")) as Record<string, Record<string, string>>;

describe("MemoryPage compact filters", () => {
  it("filters preset and custom ranges with inclusive custom-day boundaries", () => {
    const now = Date.parse("2026-07-26T12:00:00");
    expect(matchesMemoryTime("2026-07-20T12:00:00", "7d", "", "", now)).toBe(true);
    expect(matchesMemoryTime("2026-07-18T12:00:00", "7d", "", "", now)).toBe(false);
    expect(matchesMemoryTime("2026-06-27T12:00:00", "30d", "", "", now)).toBe(true);
    expect(matchesMemoryTime("2026-06-25T12:00:00", "30d", "", "", now)).toBe(false);
    expect(matchesMemoryTime("2026-07-10T00:00:00", "custom", "2026-07-10", "2026-07-12", now)).toBe(true);
    expect(matchesMemoryTime("2026-07-12T23:59:59.999", "custom", "2026-07-10", "2026-07-12", now)).toBe(true);
    expect(matchesMemoryTime("2026-07-13T00:00:00", "custom", "2026-07-10", "2026-07-12", now)).toBe(false);
    expect(matchesMemoryTime("not-a-date", "all", "", "", now)).toBe(false);
  });

  it("renders one top toolbar with company, time, role and custom-date controls", () => {
    expect(PAGE).toContain('data-testid="memory-filter-bar"');
    expect(PAGE).toContain('data-testid="memory-filter-company"');
    expect(PAGE).toContain('data-testid="memory-filter-time"');
    expect(PAGE).toContain('data-testid="memory-filter-role"');
    expect(PAGE).toContain('data-testid="memory-filter-custom-range"');
    expect(PAGE).not.toContain("chipCls");
    expect(PAGE.indexOf('data-testid="memory-filter-bar"')).toBeLessThan(PAGE.indexOf("keyProposalCount > 0"));
  });

  it("derives role options from enabled company agents, not historical memory labels", () => {
    expect(PAGE).toContain("agents.filter(agent => !companyId || agent.companyId === companyId)");
    expect(PAGE).not.toContain("skillsByTime.forEach(s => set.add(s.role))");
    expect(PAGE).toContain("!loading && roleFilter && !availableRoles.includes(roleFilter)");
  });

  it("keeps filters and scroll only in the current renderer session", () => {
    expect(PAGE).toContain("__opcMemoryPageSession");
    expect(PAGE).toContain("Object.assign(memoryPageSession");
    expect(PAGE).toContain("useLayoutEffect(() =>");
    expect(PAGE).toContain("memoryPageSession.scrollTop");
    expect(PAGE).toContain("memoryPageSession.customStart = value");
    expect(PAGE).toContain("memoryPageSession.customEnd = value");
    expect(PAGE).toContain("onInput={event => updateCompanyFilter(event.currentTarget.value)}");
    expect(PAGE).toContain("useState<TimeFilter>(() => memoryPageSession.timeFilter)");
    expect(PAGE).not.toContain('useState<TimeFilter>("all")');
  });

  it("localizes every new filter label for every shipped locale", () => {
    const keys = ["memory.filter.time.all", "memory.filter.time.custom", "memory.filter.time.from", "memory.filter.time.to", "memory.filter.role.all"];
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const key of keys) expect(dict[key], `${locale} missing ${key}`).toBeTruthy();
    }
  });
});
