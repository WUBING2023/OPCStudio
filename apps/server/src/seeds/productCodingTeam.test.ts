import { describe, it, expect } from "vitest";
import { CompanyTemplateSchema } from "@opc/shared";
import { productCodingTeamTemplate as T } from "./productCodingTeam.js";
import { matchEdgesForProducer } from "../runtime/verification.js";

describe("Stage 7 · Product/Coding 团队模板", () => {
  it("通过 CompanyTemplateSchema(可安装的合法 manifest)", () => {
    expect(() => CompanyTemplateSchema.parse(T)).not.toThrow();
  });

  it("树完整:CEO→Lead→5 工作节点,id 自洽无悬挂", () => {
    const ids = new Set(T.agents.map(a => a.id));
    expect(T.agents.find(a => a.role === "ceo")?.childrenIds).toEqual(["lead-1"]);
    for (const a of T.agents) {
      if (a.parentId) expect(ids.has(a.parentId)).toBe(true);
      for (const c of a.childrenIds) expect(ids.has(c)).toBe(true);
    }
    expect(T.agents.filter(a => a.parentId === "lead-1").length).toBe(5);
  });

  it("异构互审:Dev 用 Claude Code,Codex 核查;verification_edge 命中 dev、verifier=code_reviewer 存在", () => {
    const dev = T.agents.find(a => a.role === "dev")!;
    const reviewer = T.agents.find(a => a.role === "code_reviewer")!;
    expect(dev.framework).toBe("claude-code");
    expect(reviewer.framework).toBe("codex");
    const edges = matchEdgesForProducer(T.workflow!.verificationEdges, dev.id, "dev");
    expect(edges.length).toBe(1);
    expect(edges[0].method).toBe("code-review");
    // verifier 按 role 引用(install 重 root 后仍可解析)
    expect(T.agents.some(a => a.role === edges[0].verifier)).toBe(true);
  });

  it("工具需求声明 Codex(能力闸门会据此拦未装 Codex)", () => {
    expect(T.toolRequirements?.requiredEngines).toContain("codex");
  });
});
