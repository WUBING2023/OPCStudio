import { describe, it, expect } from "vitest";
import { resolveBadge, BADGE_COLOR, BADGE_LABEL_KEY } from "./traceTypes.js";
import dict from "../../i18n.dict.json";

// 撤销是用户/治理的主动行为,必须渲染中性"已撤销",不得伪装成红"失败"或琥珀"降级"。
describe("撤销单中性徽章(resolveBadge → cancelled)", () => {
  it("队列撤单路径:failed + degradedReason 含'撤销' → cancelled(不再红'失败')", () => {
    expect(resolveBadge("failed", true, "run failed before completion: 用户撤销了排队中的任务")).toBe("cancelled");
  });

  it("治理驳回路径:status=cancelled(即使 degraded=true)→ cancelled(不再琥珀'降级')", () => {
    expect(resolveBadge("cancelled", true, undefined)).toBe("cancelled");
  });

  it("普通失败与进程重启中断不受影响", () => {
    expect(resolveBadge("failed", true, "run failed before completion: boom")).toBe("failed");
    expect(resolveBadge("failed", true, "进程重启后未恢复")).toBe("interrupted");
  });

  it("徽章配色/文案键齐备,11 语言全覆盖非空", () => {
    expect(BADGE_COLOR.cancelled).toBeTruthy();
    expect(BADGE_LABEL_KEY.cancelled).toBe("trace.status.cancelled");
    const langs = Object.keys(dict as Record<string, Record<string, string>>);
    expect(langs.length).toBeGreaterThanOrEqual(11);
    for (const lang of langs) {
      const v = (dict as Record<string, Record<string, string>>)[lang]["trace.status.cancelled"];
      expect(v, `缺 ${lang} 的 trace.status.cancelled`).toBeTruthy();
    }
  });
});
