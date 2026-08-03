import { describe, it, expect } from "vitest";
import type { CompanyEditOperation } from "@opc/shared";
import { describeCompanyEditOp } from "./companyEditOps.js";

const tr = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${JSON.stringify(params)})` : key;

describe("describeCompanyEditOp", () => {
  it("核心操作类型都能翻成带插值参数的 i18n key", () => {
    const cases: [CompanyEditOperation, string][] = [
      [{ op: "add_agent", agent: { name: "小明", role: "dev" } }, 'cae.op.addAgent({"name":"小明","role":"dev"})'],
      [{ op: "update_agent", agentId: "dev-1", patch: {} }, 'cae.op.updateAgent({"agentId":"dev-1"})'],
      [{ op: "remove_agent", agentId: "dev-1" }, 'cae.op.removeAgent({"agentId":"dev-1"})'],
      [{ op: "add_edge", from: "ceo", to: "dev-1" }, 'cae.op.addEdge({"from":"ceo","to":"dev-1"})'],
      [{ op: "remove_edge", from: "ceo", to: "dev-1" }, 'cae.op.removeEdge({"from":"ceo","to":"dev-1"})'],
      [{ op: "rename_company", name: "新名字" }, 'cae.op.renameCompany({"name":"新名字"})'],
      [{ op: "update_description", description: "x" }, "cae.op.updateDescription"],
    ];
    for (const [op, expected] of cases) expect(describeCompanyEditOp(op, tr)).toBe(expected);
  });

  it("update_a2a_policy 按 action 区分 add/remove 文案", () => {
    expect(describeCompanyEditOp({ op: "update_a2a_policy", from: "a", to: "b", action: "add" }, tr))
      .toBe('cae.op.addA2a({"from":"a","to":"b"})');
    expect(describeCompanyEditOp({ op: "update_a2a_policy", from: "a", to: "b", action: "remove" }, tr))
      .toBe('cae.op.removeA2a({"from":"a","to":"b"})');
  });

  it("C11 收敛后新落地的三种 canonical op 都有专属文案", () => {
    expect(describeCompanyEditOp({ op: "add_memory_seed", seed: { owner_type: "company", content: "x", level: "noted" } }, tr))
      .toBe('cae.op.addMemorySeed({"level":"noted","owner":"company"})');
    expect(describeCompanyEditOp({ op: "add_default_mission", mission: { title: "示例", goal: "g" } }, tr))
      .toBe('cae.op.addDefaultMission({"title":"示例"})');
    expect(describeCompanyEditOp({ op: "update_capability_requirement", requirement: { name: "mcp-x", action: "add" } }, tr))
      .toBe('cae.op.addCapability({"name":"mcp-x"})');
    expect(describeCompanyEditOp({ op: "update_capability_requirement", requirement: { name: "mcp-x", action: "remove" } }, tr))
      .toBe('cae.op.removeCapability({"name":"mcp-x"})');
  });
});
