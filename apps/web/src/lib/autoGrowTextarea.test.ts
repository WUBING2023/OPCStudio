import { describe, it, expect } from "vitest";
import { computeAutoGrowHeight, type AutoGrowMetrics } from "./autoGrowTextarea.js";

// 自适应 textarea 高度纯逻辑:随内容增高、达 maxRows 行封顶后内部滚动。两种盒模型都要算对。
const base = (over: Partial<AutoGrowMetrics> = {}): AutoGrowMetrics => ({
  scrollHeight: 36,
  lineHeight: 20,
  paddingTop: 8,
  paddingBottom: 8,
  borderTop: 1,
  borderBottom: 1,
  boxSizing: "border-box",
  maxRows: 6,
  ...over,
});

describe("computeAutoGrowHeight · border-box", () => {
  // maxH(border-box)= 6*20 + (8+8) + (1+1) = 138;contentFit = scrollHeight + 2
  it("单行:贴合内容,不滚动", () => {
    const r = computeAutoGrowHeight(base({ scrollHeight: 36 }));
    expect(r.height).toBe(38);
    expect(r.overflowY).toBe("hidden");
  });

  it("恰好 6 行:等于封顶高度,仍不滚动", () => {
    // 6 行内容 = 120,scrollHeight = 120 + padding16 = 136,contentFit = 138 = maxH
    const r = computeAutoGrowHeight(base({ scrollHeight: 136 }));
    expect(r.height).toBe(138);
    expect(r.overflowY).toBe("hidden");
  });

  it("超过 6 行:封顶到 maxH 并内部滚动", () => {
    // 8 行内容 = 160,scrollHeight = 176,contentFit = 178 > 138
    const r = computeAutoGrowHeight(base({ scrollHeight: 176 }));
    expect(r.height).toBe(138);
    expect(r.overflowY).toBe("auto");
  });

  it("自定义 maxRows=3 收窄封顶", () => {
    const r = computeAutoGrowHeight(base({ scrollHeight: 176, maxRows: 3 }));
    // maxH = 3*20 + 16 + 2 = 78
    expect(r.height).toBe(78);
    expect(r.overflowY).toBe("auto");
  });
});

describe("computeAutoGrowHeight · content-box", () => {
  // maxH(content-box)= 6*20 = 120;contentFit = scrollHeight - padding
  it("单行:高度扣掉 padding", () => {
    const r = computeAutoGrowHeight(base({ boxSizing: "content-box", scrollHeight: 36 }));
    expect(r.height).toBe(20);
    expect(r.overflowY).toBe("hidden");
  });

  it("超过 6 行:封顶 120 并滚动", () => {
    const r = computeAutoGrowHeight(base({ boxSizing: "content-box", scrollHeight: 176 }));
    expect(r.height).toBe(120);
    expect(r.overflowY).toBe("auto");
  });
});
