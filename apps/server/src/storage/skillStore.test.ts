import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@opc/shared";
import { createSkill, getSkill, listSkills, deleteSkill } from "./skillStore.js";

// v3 A2：验证来源/License 元数据能写进 frontmatter 并读回（round-trip）。
// 用唯一临时 id，测试后清理用户级 skills 目录。
const TID = "v3-test-skill-roundtrip-xz";

// 技能库重定向到临时区,不污染真实 ~/.opcstudio/skills(userDataStore.getSkillsDir 认 OPC_SKILLS_DIR)。
let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-store-"));
  process.env.OPC_SKILLS_DIR = skillsTmp;
});
afterAll(() => {
  deleteSkill(undefined, TID);
  delete process.env.OPC_SKILLS_DIR;
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

describe("skillStore — 来源/License frontmatter round-trip", () => {
  it("写入带 source/license/author 的 skill 后能完整读回", () => {
    deleteSkill(undefined, TID); // 防上次残留
    const skill: Skill = {
      id: TID,
      title: "张雪峰风格",
      role: "skill-zhang",
      enabled: true,
      lastModified: "2026-06-20T00:00:00Z",
      description: "升学规划风格演绎",
      license: "OPC-Original",
      licenseUrl: "https://example.com/LICENSE",
      author: "OPC Community",
      authorGitHub: "opc-studio",
      checksum: "abc123",
      source: { owner: "opc-studio", repo: "community-skills", branch: "main", path: "skills/zhang.skill", url: "https://raw.githubusercontent.com/opc-studio/community-skills/main/skills/zhang.skill" },
      content: "# 升学规划\n直白务实。",
    };
    createSkill(undefined, skill);

    const back = getSkill(undefined, TID);
    expect(back).toBeTruthy();
    expect(back!.license).toBe("OPC-Original");
    expect(back!.licenseUrl).toBe("https://example.com/LICENSE");
    expect(back!.author).toBe("OPC Community");
    expect(back!.authorGitHub).toBe("opc-studio");
    expect(back!.checksum).toBe("abc123");
    expect(back!.description).toBe("升学规划风格演绎");
    expect(back!.source?.owner).toBe("opc-studio");
    expect(back!.source?.url).toContain("raw.githubusercontent.com");
    expect(back!.content.trim()).toBe("# 升学规划\n直白务实。");
  });

  it("listSkills 也带出 license/source 元数据", () => {
    const meta = listSkills().find(s => s.id === TID);
    expect(meta).toBeTruthy();
    expect(meta!.license).toBe("OPC-Original");
    expect(meta!.source?.repo).toBe("community-skills");
  });

  it("老 skill（无新字段）读回时不带 source/license（向后兼容）", () => {
    const legacyId = TID + "-legacy";
    deleteSkill(undefined, legacyId);
    createSkill(undefined, { id: legacyId, title: "老技能", role: "dev", enabled: true, lastModified: "x", content: "正文" });
    const back = getSkill(undefined, legacyId);
    expect(back!.license).toBeUndefined();
    expect(back!.source).toBeUndefined();
    deleteSkill(undefined, legacyId);
  });

  it("C1:companyId 写进 frontmatter 并读回(getSkill / listSkills 都带出);legacy 无此字段", () => {
    const cid = TID + "-companyid";
    deleteSkill(undefined, cid);
    createSkill(undefined, { id: cid, title: "带公司归属", role: "dev", enabled: true, lastModified: "x", content: "正文", origin: "bundled", companyId: "co-abc123" });
    expect(getSkill(undefined, cid)!.companyId).toBe("co-abc123");
    expect(listSkills().find(s => s.id === cid)!.companyId).toBe("co-abc123");
    // legacy(无 companyId)读回 undefined。
    const legacyId = cid + "-legacy";
    deleteSkill(undefined, legacyId);
    createSkill(undefined, { id: legacyId, title: "老打包", role: "dev", enabled: true, lastModified: "x", content: "正文", origin: "bundled" });
    expect(getSkill(undefined, legacyId)!.companyId).toBeUndefined();
    deleteSkill(undefined, cid);
    deleteSkill(undefined, legacyId);
  });
});
