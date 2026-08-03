import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 作战室簇质量复检(#2/#10/#28/#29)回归约束。OrgPage 引入 reactflow 等重依赖,无 DOM 测试基建
// (纯 node vitest),故以源码契约锁住这些不变量(同 briefingPanelCeoScope.test.ts 的做法);
// 纯函数部分(isWithinWindow/channelActiveFresh)的行为测试在 lib/collabLines.test.ts。
const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "OrgPage.tsx"),
  "utf-8",
);

describe("OrgPage · 飞线/紫线的 now 时钟(#2)", () => {
  it("存在未过期飞线/紫线时以 1s 快速 tick 驱动 now(否则动画迟到最多一整个 10s tick)", () => {
    expect(SRC).toMatch(/const hasTransientLines = artifactFlights\.length > 0 \|\| memoryPulses\.length > 0;/);
    const m = SRC.match(/if \(!hasTransientLines\) return;[\s\S]{0,200}?setInterval\([\s\S]{0,120}?setNow\(Date\.now\(\)\)[\s\S]{0,60}?,\s*1000\)/);
    expect(m).toBeTruthy();
  });

  it("展示窗口大于快速 tick 间隔(不会出现\"还没画就过期\")", () => {
    const flight = SRC.match(/ARTIFACT_FLIGHT_WINDOW_MS = (\d+)/);
    const pulse = SRC.match(/MEMORY_PULSE_WINDOW_MS = (\d+)/);
    expect(Number(flight![1])).toBeGreaterThan(1000);
    expect(Number(pulse![1])).toBeGreaterThan(1000);
  });
});

describe("OrgPage · 「正在交流」流光按 lastActiveAt 新鲜度衰减(#10)", () => {
  it("activePairs 不再直接信任 status===\"active\",走 channelActiveFresh", () => {
    expect(SRC).toMatch(/channels\.filter\(c => channelActiveFresh\(c, now\)\)/);
    // 旧写法(粘滞 active 直接点亮)不得回归:
    expect(SRC).not.toMatch(/channels\.filter\(c => c\.status === "active"\)/);
  });

  it("collabOverride 把超窗的 active 通道衰减为 open,再喂给边渲染(styleEdgeFor 读 data.status)", () => {
    expect(SRC).toMatch(/c\.status === "active" && !channelActiveFresh\(c, now\)/);
  });
});

describe("OrgPage · 浮动加人按钮死接线修复(#28)", () => {
  it("不存在恒假的 canEditStructure && showCanvas 渲染条件(两态互斥)", () => {
    expect(SRC).not.toMatch(/canEditStructure && showCanvas/);
  });

  it("handleAddAgent 与 importTemplate 建号都带 companyId: currentCompanyId(否则服务端默认落 default 公司)", () => {
    const hits = SRC.match(/companyId:\s*currentCompanyId/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("importTemplate 全量重映射模板内部 id(childrenIds 不留悬空引用)", () => {
    expect(SRC).toMatch(/idMap\.get\(agent\.id\)/);
    expect(SRC).toMatch(/childrenIds:\s*\(agent\.childrenIds \?\? \[\]\)\.map\(c => idMap\.get\(c\)\)/);
  });
});

describe("OrgPage · 换公司清跨公司选中,单一 useEffect 收口(#29)", () => {
  it("initializes the selected company from the URL before the localStorage fallback", () => {
    expect(SRC).toMatch(/if \(routeCompanyId\) return routeCompanyId;[\s\S]{0,160}?localStorage\.getItem\("opc-org-company"\)/);
  });

  it("does not auto-pick another company while a URL company is loading its agents", () => {
    expect(SRC).toMatch(/const autoPickedRef = useRef\(!!routeCompanyId\);/);
  });
  it("存在按 currentCompanyId 变化清理 selected 的效应", () => {
    const m = SRC.match(/if \(cur && \(cur\.companyId \|\| "default"\) !== currentCompanyId\) st\.select\(null\);[\s\S]{0,40}?\[currentCompanyId\]/);
    expect(m).toBeTruthy();
  });

  it("切换器按钮不再散落手动 select(null)(统一走收口效应)", () => {
    expect(SRC).not.toMatch(/setCurrentCompanyId\(c\.id\); setCompanyMenuOpen\(false\); select\(null\)/);
  });
});
