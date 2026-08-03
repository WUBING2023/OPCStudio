import { describe, expect, it } from "vitest";
import { normalizeIncubatorDesign } from "./incubatorDesign.js";

describe("normalizeIncubatorDesign", () => {
  it("builds a concrete reporting tree and keeps duplicate worker roles addressable by member id", () => {
    const design = normalizeIncubatorDesign("team", {
      teamName: "审查团队",
      members: [
        { id: "chief", name: "审查负责人", role: "ceo" },
        { id: "lead", name: "交付主管", role: "lead" },
        { id: "dev-a", name: "逻辑审查员", role: "dev" },
        { id: "dev-b", name: "风格审查员", role: "dev" },
        { id: "tester", name: "验证员", role: "test" },
      ],
      verificationEdges: [{ producerId: "dev-b", verifierId: "tester", method: "code-review" }],
    }) as any;

    expect(design.members.find((member: any) => member.id === "lead").reportsToId).toBe("chief");
    expect(design.members.find((member: any) => member.id === "dev-a").reportsToId).toBe("lead");
    expect(design.verificationEdges).toEqual([{
      producerId: "dev-b", verifierId: "tester", method: "code-review", onReject: "redo",
    }]);
  });

  it("normalizes duplicate ids and converts legacy role edges without producing self-edges", () => {
    const design = normalizeIncubatorDesign("team", {
      members: [
        { id: "ceo", name: "CEO", role: "ceo" },
        { id: "ceo", name: "主管", role: "lead" },
        { name: "开发", role: "dev" },
        { name: "测试", role: "test" },
      ],
      verificationEdges: [
        { producer: "dev", verifier: "test", method: "fact-check" },
        { producer: "dev", verifier: "dev", method: "code-review" },
      ],
    }) as any;

    expect(new Set(design.members.map((member: any) => member.id)).size).toBe(4);
    expect(design.verificationEdges).toHaveLength(1);
    expect(design.verificationEdges[0]).toMatchObject({ method: "fact-check" });
  });
});