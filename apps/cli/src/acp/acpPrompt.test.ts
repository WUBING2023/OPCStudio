// 相1 · ACP 路径 prompt 组装单测:新简报必须工整(目标/上下文/期望产出)且**绝不**夹带 hermes 内核指令。
import { describe, it, expect } from "vitest";
import { buildAcpTaskBrief } from "./acpPrompt.js";
import { getRolePrompt } from "@opc/server/src/runtime/prompts.js";

describe("buildAcpTaskBrief(ACP 路径任务简报)", () => {
  it("含目标/角色,结构工整(目标·上下文·期望产出)", () => {
    const brief = buildAcpTaskBrief({ goal: "写一个把摄氏转华氏的函数", role: "dev" });
    expect(brief).toContain("写一个把摄氏转华氏的函数");
    expect(brief).toContain("dev");
    expect(brief).toContain("## 目标");
    expect(brief).toContain("## 上下文");
    expect(brief).toContain("## 期望产出");
    expect(brief).toContain("隔离工作目录");
    expect(brief).toContain("必须实际落盘");
    expect(brief).toContain("必须实际运行测试命令");
    expect(brief).not.toContain("text-only");
    expect(brief).not.toContain("本次不提供写文件或执行命令的工具");
  });

  it("绝不夹带 hermes 内核指令(writeFile / DIRECT_ANSWER / ## PLAN / ## LEAD)", () => {
    const brief = buildAcpTaskBrief({ goal: "随便干点啥", role: "dev" });
    for (const forbidden of ["writeFile", "readFile", "DIRECT_ANSWER", "## PLAN", "## LEAD", "machine-parsed"]) {
      expect(brief).not.toContain(forbidden);
    }
  });

  it("与 hermes dev 角色 prompt 明显不同(证明没有复用 getRolePrompt)", () => {
    const brief = buildAcpTaskBrief({ goal: "g", role: "dev" });
    const hermes = getRolePrompt("dev");
    expect(hermes).toContain("writeFile"); // 前提:hermes dev prompt 确实内嵌写文件强制指令
    expect(brief).not.toContain(hermes);
    expect(brief).not.toContain("必须调用 writeFile");
  });

  it("role 为空时回退到 worker,不产生空角色", () => {
    const brief = buildAcpTaskBrief({ goal: "g", role: "  " });
    expect(brief).toContain("worker");
  });
});
