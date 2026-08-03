import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #3 回归约束:简报栏的本地消息(用户回声/命令输出/技能反馈/报错)必须以本公司 CEO(chatCeoId)为键。
// 写死 "ceo" 会让非默认公司(ceoId 形如 "ceo-0-a70e01")的这些消息被 L594 的过滤整体吞掉,
// 并在切回默认公司时串进它的简报流。组件无 DOM 测试基建(纯 node vitest),故以源码契约锁住该不变量。
const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "BriefingPanel.tsx"),
  "utf-8",
);

function extractHookCalls(src: string): { body: string; deps: string }[] {
  const out: { body: string; deps: string }[] = [];
  const re = /use(Callback|Memo)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        i++;
        while (i < src.length && src[i] !== ch) {
          if (src[i] === "\\") i++;
          i++;
        }
      } else if (ch === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (ch === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i++;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const call = src.slice(start, i - 1);
    const dm = call.match(/,\s*\[([^\]]*)\]\s*$/);
    if (dm) out.push({ body: call.slice(0, call.length - dm[0].length), deps: dm[1] });
  }
  return out;
}

describe("BriefingPanel · 本地消息按本公司 CEO 隔离(#3)", () => {
  it("不存在写死的 agentId:\"ceo\"", () => {
    expect(SRC).not.toMatch(/agentId:\s*["']ceo["']/);
  });

  it("所有 addLocalMessage 调用都以 chatCeoId 为键", () => {
    const calls = [...SRC.matchAll(/addLocalMessage\(\{\s*agentId:\s*([A-Za-z_$][\w$]*)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(13);
    for (const c of calls) expect(c[1]).toBe("chatCeoId");
  });

  it("引用 chatCeoId 的 useCallback/useMemo 依赖数组都带上 chatCeoId", () => {
    const hooks = extractHookCalls(SRC).filter(h => /\bchatCeoId\b/.test(h.body));
    expect(hooks.length).toBeGreaterThanOrEqual(9);
    for (const h of hooks) expect(h.deps).toMatch(/\bchatCeoId\b/);
  });
});
