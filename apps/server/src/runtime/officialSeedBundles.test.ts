import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseCompanyBundle, CompanyBundleSchema, CompanyTemplateSchema, bundleToTemplateShape,
  CURRENT_BUNDLE_SCHEMA_VERSION, type CompanyBundle,
} from "@opc/shared";
import { runTemplateDoctor, scanContentSafety } from "./templateDoctor.js";
import { OFFICIAL_SEED_BUNDLES, officialSeedTemplates, syncBuiltinContent } from "../communitySeed.js";

// 官方种子公司模板(canonical CompanyBundle v0.3.0):3 个模板必须 parseCompanyBundle 全过、
// Template Doctor 安全档零 error、bundleToTemplateShape 安装形状可用,并如实声明 required_secrets、
// 不夹带任何本机路径/密钥。最后走一遍真实 syncBuiltinContent 落盘管线,确认它们能进社区库存。

const EXPECTED = [
  { id: "research-report-company", title: "调研报告公司" },
  { id: "code-delivery-squad", title: "代码交付小队" },
  { id: "study-coach-company", title: "学习陪练公司" },
] as const;

describe("官方种子公司模板 · canonical CompanyBundle v0.3.0", () => {
  it("正好 3 个模板,id/title 符合预期,均为当前 canonical 版本的 company bundle", () => {
    expect(OFFICIAL_SEED_BUNDLES).toHaveLength(3);
    for (const [i, b] of OFFICIAL_SEED_BUNDLES.entries()) {
      expect(b.bundle_id).toBe(EXPECTED[i].id);
      expect(b.title).toBe(EXPECTED[i].title);
      expect(b.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
      expect(b.bundle_type).toBe("company");
    }
  });

  for (const [i, expected] of EXPECTED.entries()) {
    const bundle = (): CompanyBundle => OFFICIAL_SEED_BUNDLES[i];

    describe(expected.title, () => {
      it("parseCompanyBundle 通过,无错误", () => {
        const r = parseCompanyBundle(bundle());
        expect(r.ok).toBe(true);
        expect(r.errors).toBeUndefined();
        expect(r.bundle?.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
        // CompanyBundleSchema 直接校验也通过(双保险)。
        expect(CompanyBundleSchema.safeParse(bundle()).success).toBe(true);
      });

      it("bundleToTemplateShape 产出可安装的扁平 CompanyTemplate(过 CompanyTemplateSchema)", () => {
        const shape = bundleToTemplateShape(bundle());
        const parsed = CompanyTemplateSchema.safeParse(shape);
        expect(parsed.success).toBe(true);
        expect(shape.id).toBe(expected.id);
        expect((shape.agents as unknown[]).length).toBe(3);
        // 安装形状带上作者/许可/结构字段(index 重建与安装管线依赖)。
        expect(shape.author).toBe("OPC Studio");
        expect(shape.license).toBe("OPC-Original");
        expect(shape.readme).toBeTruthy();
        expect(shape.workflow).toBeTruthy();
        expect(shape.a2aChannels).toBeTruthy();
      });

      it("Template Doctor 安全档零 error(在安装形状上体检)", () => {
        const shape = bundleToTemplateShape(bundle());
        const report = runTemplateDoctor(shape);
        expect(report.errors).toBe(0);
        expect(report.install_allowed).toBe(true);
        const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
        expect(byId.schema_valid).toBe("pass");
        expect(byId.no_cycle_in_org).toBe("pass");
        expect(byId.no_secrets_detected).toBe("pass");
      });

      it("整份 bundle 无密钥形态、无本机绝对路径(scanContentSafety 零发现)", () => {
        expect(scanContentSafety(bundle())).toEqual([]);
      });

      it("required_secrets 如实:只声明 DEEPSEEK_API_KEY,且与 agents 用到的 provider 一致", () => {
        const b = bundle();
        expect(b.privacy.required_secrets.map((s) => s.name)).toEqual(["DEEPSEEK_API_KEY"]);
        const providers = new Set(b.agents.map((a) => a.provider));
        expect([...providers]).toEqual(["deepseek"]);
        expect(b.toolRequirements?.requiredProviders).toEqual(["deepseek"]);
      });

      it("验证边(workflow.verificationEdges)的 producer/verifier 指向真实存在的 agent id,且带 onReject", () => {
        const b = bundle();
        const ids = new Set(b.agents.map((a) => a.id));
        const edges = b.workflow?.verificationEdges ?? [];
        expect(edges.length).toBeGreaterThan(0);
        for (const e of edges) {
          expect(ids.has(e.producer)).toBe(true);
          expect(ids.has(e.verifier)).toBe(true);
          expect(e.producer).not.toBe(e.verifier);
          expect(["redo", "flag"]).toContain(e.onReject);
        }
      });

      it("A2A 预置通道的 from/to 均为真实 agent id", () => {
        const b = bundle();
        const ids = new Set(b.agents.map((a) => a.id));
        expect((b.a2aChannels ?? []).length).toBeGreaterThan(0);
        for (const ch of b.a2aChannels ?? []) {
          expect(ids.has(ch.from)).toBe(true);
          expect(ids.has(ch.to)).toBe(true);
        }
      });

      it("组织汇报链单根、无孤儿:childrenIds 与 parentId 互相闭合", () => {
        const b = bundle();
        const ids = new Set(b.agents.map((a) => a.id));
        const roots = b.agents.filter((a) => !a.parentId);
        expect(roots).toHaveLength(1);
        for (const a of b.agents) {
          if (a.parentId) expect(ids.has(a.parentId)).toBe(true);
          for (const c of a.childrenIds) expect(ids.has(c)).toBe(true);
        }
      });
    });
  }
});

describe("官方种子落盘管线 · syncBuiltinContent 把 3 个模板写进社区库存", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "official-seed-")); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("冷装后 templates 目录出现 3 个模板文件,index 收录,且每个落盘文件过 Doctor 零 error", () => {
    syncBuiltinContent(root);

    const templatesDir = path.join(root, ".opc", "community", "templates");
    const index = JSON.parse(fs.readFileSync(path.join(root, ".opc", "community", "index.json"), "utf-8"));
    const indexIds = new Set((index.templates as { id: string }[]).map((t) => t.id));

    for (const { id, title } of EXPECTED) {
      const file = path.join(templatesDir, `${id}.json`);
      expect(fs.existsSync(file)).toBe(true);
      expect(indexIds.has(id)).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
      expect(onDisk.title).toBe(title);
      expect(onDisk.author).toBe("OPC Studio");
      expect(onDisk.agents).toHaveLength(3);

      const report = runTemplateDoctor(onDisk, { projectRoot: root });
      expect(report.errors).toBe(0);
      expect(report.install_allowed).toBe(true);

      const entry = (index.templates as { id: string; agentCount?: number; license?: string }[]).find((t) => t.id === id)!;
      expect(entry.agentCount).toBe(3);
      expect(entry.license).toBe("OPC-Original");
    }
  });

  it("officialSeedTemplates() 与落盘一致:桥接产物即写入内容(id/agents 对齐)", () => {
    const tpls = officialSeedTemplates();
    expect(tpls.map((t) => t.id)).toEqual(EXPECTED.map((e) => e.id));
    for (const t of tpls) expect(t.agents).toHaveLength(3);
  });
});
