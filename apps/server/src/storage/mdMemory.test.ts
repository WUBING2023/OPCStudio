import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readCompanyMd, writeCompanyMd, companyMdPath,
  readTeamMd, writeTeamMd,
  readAgentMemory, appendAgentMemory,
  appendTeamTask,
  appendCompanyKnowledge,
} from "./mdMemory.js";

// OPC 共享 md 记忆:框架无关的读写。验证读写往返、append 去重+上限、路径名净化。
let root = "";
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-md-")); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("mdMemory", () => {
  it("文件不存在时读返回空串", () => {
    expect(readCompanyMd(root)).toBe("");
    expect(readTeamMd(root, "engineering-lead")).toBe("");
    expect(readAgentMemory(root, "dev-1")).toBe("");
    expect(readTeamMd(root, undefined)).toBe(""); // 无 leadId 安全返回空
  });

  it("company.md 读写往返", () => {
    writeCompanyMd(root, "我们是 OPC Studio,一家多 agent 公司。");
    expect(readCompanyMd(root)).toContain("OPC Studio");
  });

  it("team.md 按 leadId 隔离", () => {
    writeTeamMd(root, "engineering-lead", "工程团队:前端+后端");
    writeTeamMd(root, "product-lead", "产品团队:研究+成文");
    expect(readTeamMd(root, "engineering-lead")).toContain("工程团队");
    expect(readTeamMd(root, "product-lead")).toContain("产品团队");
    expect(readTeamMd(root, "engineering-lead")).not.toContain("产品团队");
  });

  it("appendAgentMemory:追加 + 去重 + 带日期", () => {
    appendAgentMemory(root, "dev-1", "完成「做马里奥」:用了 write_file/run_tests", "2026-06-23T10:00:00Z");
    appendAgentMemory(root, "dev-1", "完成「做马里奥」:用了 write_file/run_tests", "2026-06-23T11:00:00Z"); // 重复
    appendAgentMemory(root, "dev-1", "完成「写综述」:用了 web_search", "2026-06-23T12:00:00Z");
    const mem = readAgentMemory(root, "dev-1");
    expect(mem).toContain("做马里奥");
    expect(mem).toContain("写综述");
    expect(mem).toContain("[2026-06-23]");
    // 去重:同一条只出现一次
    expect(mem.match(/做马里奥/g)?.length).toBe(1);
  });

  it("appendAgentMemory:超过上限只保留最近 N 条", () => {
    for (let i = 0; i < 80; i++) appendAgentMemory(root, "dev-2", `任务 ${i} 完成`, "2026-06-23T10:00:00Z");
    const lines = readAgentMemory(root, "dev-2").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(60); // MAX_AGENT_MEMORY_LINES
    expect(readAgentMemory(root, "dev-2")).toContain("任务 79 完成"); // 最新的还在
    expect(readAgentMemory(root, "dev-2")).not.toContain("任务 0 完成"); // 最旧的被挤掉
  });

  it("appendTeamTask:维护能力史,保留最近3条,不动静态花名册", () => {
    writeTeamMd(root, "engineering-lead", "# 团队:工程\n\n## 成员\n- 前端\n- 后端");
    for (let i = 1; i <= 5; i++) appendTeamTask(root, "engineering-lead", `任务${i}`, "2026-06-23T10:00:00Z");
    const md = readTeamMd(root, "engineering-lead");
    expect(md).toContain("## 成员");          // 静态花名册保留
    expect(md).toContain("前端");
    expect(md).toContain("## 最近任务(能力史)");
    expect(md).toContain("任务5");             // 最新保留
    expect(md).toContain("任务3");
    expect(md).not.toContain("任务2");         // 只留最近3条(任务3/4/5)
    expect(md).not.toContain("任务1");
  });

  it("appendCompanyKnowledge:company.md 已存在时累积项目历程,不动静态描述;未 init 则不创建", () => {
    expect(readCompanyMd(root)).toBe("");
    appendCompanyKnowledge(root, "项目A", "2026-06-23T10:00:00Z"); // 未 init → 不创建
    expect(readCompanyMd(root)).toBe("");
    writeCompanyMd(root, "# 公司\n\n## 团队\n- eng");
    appendCompanyKnowledge(root, "项目A", "2026-06-23T10:00:00Z");
    appendCompanyKnowledge(root, "项目A", "2026-06-23T11:00:00Z"); // 去重
    appendCompanyKnowledge(root, "项目B", "2026-06-23T12:00:00Z");
    const md = readCompanyMd(root);
    expect(md).toContain("## 团队");           // 静态描述保留
    expect(md).toContain("## 项目历程(自动累积)");
    expect(md).toContain("项目A");
    expect(md).toContain("项目B");
    expect(md.match(/项目A/g)?.length).toBe(1); // 去重
  });

  it("agentId 含特殊字符时路径被净化(不越界写文件)", () => {
    appendAgentMemory(root, "../../evil id!", "x", "2026-06-23T10:00:00Z");
    // 应安全写在 knowledge/agents 下,不抛、不越界
    expect(fs.existsSync(path.join(root, ".opc", "knowledge", "agents"))).toBe(true);
  });

  describe("company.md 按公司隔离", () => {
    it("不传 companyId 时走旧的全局共享路径(向后兼容遗留调用点)", () => {
      writeCompanyMd(root, "共享内容");
      expect(companyMdPath(root)).toBe(path.join(root, ".opc", "knowledge", "company.md"));
      expect(readCompanyMd(root)).toBe("共享内容");
    });

    it("传 companyId 时读写各自隔离,互不可见", () => {
      writeCompanyMd(root, "公司A的知识", "company-a");
      writeCompanyMd(root, "公司B的知识", "company-b");
      expect(companyMdPath(root, "company-a")).toBe(path.join(root, ".opc", "knowledge", "companies", "company-a", "company.md"));
      expect(readCompanyMd(root, "company-a")).toBe("公司A的知识");
      expect(readCompanyMd(root, "company-b")).toBe("公司B的知识");
      expect(readCompanyMd(root, "company-a")).not.toContain("公司B");
    });

    it("迁移:隔离文件不存在但旧全局共享文件存在时,首次按 companyId 读取会拷贝一份旧内容作为起点", () => {
      writeCompanyMd(root, "旧的全项目共享内容"); // 旧全局文件(不传 companyId)
      expect(readCompanyMd(root, "company-c")).toBe("旧的全项目共享内容"); // 首次按公司读 → 触发迁移
      expect(fs.existsSync(companyMdPath(root, "company-c"))).toBe(true);
      // 迁移后各自独立累积,不再共享:改公司 A 不影响旧全局文件,也不影响另一家公司
      writeCompanyMd(root, "公司C自己新增的内容", "company-c");
      expect(readCompanyMd(root, "company-c")).toBe("公司C自己新增的内容");
      expect(readCompanyMd(root)).toBe("旧的全项目共享内容"); // 旧全局文件本身不受影响、不删除
    });

    it("迁移只发生一次:公司自己的隔离文件一旦存在,不会被旧全局文件内容覆盖", () => {
      writeCompanyMd(root, "旧的全局内容");
      writeCompanyMd(root, "公司D自己的起点", "company-d"); // 隔离文件已存在(未经过迁移路径)
      expect(readCompanyMd(root, "company-d")).toBe("公司D自己的起点");
    });

    it("没有旧全局文件时,按 companyId 读取只是正常返回空串(不报错、不创建)", () => {
      expect(readCompanyMd(root, "company-e")).toBe("");
      expect(fs.existsSync(companyMdPath(root, "company-e"))).toBe(false);
    });

    it("appendCompanyKnowledge 支持按 companyId 隔离累积项目历程", () => {
      writeCompanyMd(root, "# 公司F\n\n## 团队\n- eng", "company-f");
      appendCompanyKnowledge(root, "项目X", "2026-06-23T10:00:00Z", "company-f");
      appendCompanyKnowledge(root, "项目Y", "2026-06-23T11:00:00Z", "company-f");
      const md = readCompanyMd(root, "company-f");
      expect(md).toContain("项目X");
      expect(md).toContain("项目Y");
      // 全局共享文件不受影响(该公司的历程没有泄漏进去)
      expect(readCompanyMd(root)).not.toContain("项目X");
    });
  });
});
