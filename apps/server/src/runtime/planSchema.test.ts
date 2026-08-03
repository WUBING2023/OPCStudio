import { describe, it, expect } from "vitest";
import { parseTaskGraphProposal } from "./planSchema.js";

const VALID = {
  proposal_type: "task_graph",
  mission_summary: "Prepare launch package.",
  tasks: [
    { title: "Research comparable products", assigned_role: "dev", expected_artifacts: ["competitor_summary.md"] },
    { title: "Write positioning brief", assigned_role: "dev", depends_on: ["competitor_summary.md"], expected_artifacts: ["positioning_brief.md"] },
  ],
};

describe("parseTaskGraphProposal 容错解析", () => {
  it("合法 ```json 块 → 解析成功", () => {
    const text = "```json\n" + JSON.stringify(VALID, null, 2) + "\n```";
    const r = parseTaskGraphProposal(text);
    expect(r.proposal).not.toBeNull();
    expect(r.proposal!.tasks.length).toBe(2);
    expect(r.proposal!.mission_summary).toBe("Prepare launch package.");
    expect(r.proposal!.tasks[1].depends_on).toEqual(["competitor_summary.md"]);
  });

  it("JSON 块外包裹解释性文本 → 仍解析成功", () => {
    const text = `好的,以下是我的任务拆解提案:\n\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n\n请审阅。`;
    const r = parseTaskGraphProposal(text);
    expect(r.proposal).not.toBeNull();
    expect(r.proposal!.tasks[0].title).toBe("Research comparable products");
  });

  it("无代码围栏、裸 {...} → 解析成功(兜底路径)", () => {
    const r = parseTaskGraphProposal("Sure! " + JSON.stringify(VALID));
    expect(r.proposal).not.toBeNull();
  });

  it("坏 JSON → null + 原因", () => {
    const r = parseTaskGraphProposal("```json\n{ tasks: [oops }\n```");
    expect(r.proposal).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("缺 tasks 字段 → null + 原因点名字段", () => {
    const r = parseTaskGraphProposal(JSON.stringify({ mission_summary: "x" }));
    expect(r.proposal).toBeNull();
    expect(r.reason).toContain("tasks");
  });

  it("tasks 为空数组 → null(zod min(1))", () => {
    const r = parseTaskGraphProposal(JSON.stringify({ mission_summary: "x", tasks: [] }));
    expect(r.proposal).toBeNull();
  });

  it("task 缺 title → null + 原因", () => {
    const r = parseTaskGraphProposal(JSON.stringify({ mission_summary: "x", tasks: [{ goal: "没标题" }] }));
    expect(r.proposal).toBeNull();
    expect(r.reason).toContain("title");
  });

  it("空文本 / 无 JSON 的纯文本 → null", () => {
    expect(parseTaskGraphProposal("").proposal).toBeNull();
    expect(parseTaskGraphProposal("我做不到这个任务。").proposal).toBeNull();
  });
});
