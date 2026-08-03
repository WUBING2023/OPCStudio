import { describe, it, expect } from "vitest";
import { stripThinkBlocks, stripDirectAnswerHeader } from "./outputSanitizer.js";

describe("stripThinkBlocks — <think> 剥离统一收口", () => {
  it("无标记 → 零改动(clean 逐字节等于输入,thinking 缺省)", () => {
    const input = "普通回复,包含 <thinking 的近似词与 </think> 残片但没有开标记。\n\n第二段。";
    const r = stripThinkBlocks(input);
    expect(r.clean).toBe(input);
    expect(r.thinking).toBeUndefined();
  });

  it("单个闭合块(跨行)→ 正文干净,思考进 thinking", () => {
    const r = stripThinkBlocks("<think>\n用户想要 X,\n我先分析 Y。\n</think>\n最终答案是 42。");
    expect(r.clean).toBe("最终答案是 42。");
    expect(r.thinking).toBe("用户想要 X,\n我先分析 Y。");
  });

  it("多段思考块 → 全部剥离并按序保留", () => {
    const r = stripThinkBlocks("<think>第一段思考</think>答案A。<think>第二段思考</think>答案B。");
    expect(r.clean).toBe("答案A。答案B。");
    expect(r.thinking).toBe("第一段思考\n\n第二段思考");
    expect(r.clean).not.toContain("<think>");
  });

  it("未闭合尾块 → 尾部思考不进正文", () => {
    const r = stripThinkBlocks("结论:方案可行。\n<think>其实我还想再验证一下边界……");
    expect(r.clean).toBe("结论:方案可行。");
    expect(r.thinking).toBe("其实我还想再验证一下边界……");
  });

  it("整段都是未闭合思考 → 正文诚实为空", () => {
    const r = stripThinkBlocks("<think>只想了没答");
    expect(r.clean).toBe("");
    expect(r.thinking).toBe("只想了没答");
  });

  it("空思考块 → 标记被剥掉,thinking 不置值", () => {
    const r = stripThinkBlocks("<think></think>直接答复");
    expect(r.clean).toBe("直接答复");
    expect(r.thinking).toBeUndefined();
  });

  it("大小写不敏感 + 剥离后不残留多余空行", () => {
    const r = stripThinkBlocks("前文。\n\n<THINK>思考</THINK>\n\n后文。");
    expect(r.clean).toBe("前文。\n\n后文。");
    expect(r.thinking).toBe("思考");
  });
});

describe("stripDirectAnswerHeader — 协议头全文首标记提取", () => {
  it("行首标记 → 提取正文(与旧行为兼容)", () => {
    expect(stripDirectAnswerHeader("DIRECT_ANSWER: 答案正文")).toBe("答案正文");
    expect(stripDirectAnswerHeader("  DIRECT_ANSWER：中文冒号\n第二行")).toBe("中文冒号\n第二行");
  });

  it("带前言的标记 → 不再把 DIRECT_ANSWER: 字样漏进用户可见文本", () => {
    const out = stripDirectAnswerHeader("好的,我来直接回答。DIRECT_ANSWER: 这是给用户的答复。");
    expect(out).toBe("这是给用户的答复。");
    expect(out).not.toContain("DIRECT_ANSWER");
  });

  it("无标记 → 原样返回", () => {
    const input = "普通聊天回复,没有协议头。";
    expect(stripDirectAnswerHeader(input)).toBe(input);
  });

  it("空输入 → 空串", () => {
    expect(stripDirectAnswerHeader("")).toBe("");
  });
});
