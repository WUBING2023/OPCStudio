import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addCompany, getCompany, updateCompany, deleteCompany, loadCompanies } from "./companyStore.js";
import { closeAllDbs } from "./sqlite/db.js";

// 战役B·Phase B2b:companyStore 参数化双后端各跑一遍。
const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
  fs.mkdirSync(path.join(r, ".opc"), { recursive: true });
  roots.push(r);
  return r;
}
afterEach(() => {
  closeAllDbs();
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
  delete process.env.OPC_STORAGE_BACKEND;
});
function withBackend<T>(backend: string, fn: () => T): T {
  const prev = process.env.OPC_STORAGE_BACKEND;
  process.env.OPC_STORAGE_BACKEND = backend;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.OPC_STORAGE_BACKEND; else process.env.OPC_STORAGE_BACKEND = prev; }
}

const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("companyStore [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("Stage 5/6:install 传入的 manifest/workflow 字段真落盘(读回从权威存储验证)", () => {
    const root = mkRoot();
    run(() => {
      const c = addCompany(root, {
        name: "测试队",
        manifestTemplateId: "tpl-1",
        manifestUseCases: ["场景A"],
        manifestRiskNotes: ["不适合X"],
        manifestToolRequirements: { requiredEngines: ["codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
        workflow: { verificationEdges: [{ producer: "dev", verifier: "code_reviewer", method: "code-review", onReject: "redo" }] },
      });
      const got = getCompany(root, c.id);
      expect(got?.manifestRiskNotes).toEqual(["不适合X"]);
      expect(got?.manifestUseCases).toEqual(["场景A"]);
      expect(got?.manifestTemplateId).toBe("tpl-1");
      expect(got?.manifestToolRequirements?.requiredEngines).toContain("codex");
      expect(got?.workflow?.verificationEdges?.[0].method).toBe("code-review");
    });
  });

  it("add / update / delete 经 load/save 自动生效(默认公司不可删)", () => {
    const root = mkRoot();
    run(() => {
      const a = addCompany(root, { id: "default", name: "默认公司" });
      const b = addCompany(root, { name: "乙队" });
      expect(loadCompanies(root).map((c) => c.id).sort()).toEqual(["default", b.id].sort());
      const upd = updateCompany(root, b.id, { name: "乙队改名" });
      expect(upd?.name).toBe("乙队改名");
      expect(getCompany(root, b.id)?.name).toBe("乙队改名");
      expect(deleteCompany(root, a.id)).toBe(false); // 默认公司不可删
      expect(deleteCompany(root, b.id)).toBe(true);
      expect(loadCompanies(root).map((c) => c.id)).toEqual(["default"]);
    });
  });
});

// 双写落盘等价:sqlite 写一次(双写)后,companies.json 与 companies 表逐条一致。
describe("companyStore 双写后 companies.json == companies 表", () => {
  it("addCompany 双写", async () => {
    const { openBusinessDb, readAllDocs } = await import("./sqlite/docTableBackend.js");
    const { readJSON } = await import("./jsonFile.js");
    const root = mkRoot();
    withBackend("sqlite", () => {
      addCompany(root, { id: "default", name: "默认公司" });
      addCompany(root, { name: "乙队", description: "d" });
    });
    expect(withBackend("sqlite", () => loadCompanies(root))).toEqual(withBackend("json", () => loadCompanies(root)));
    expect(readJSON(path.join(root, ".opc", "companies.json"), [])).toEqual(readAllDocs(openBusinessDb(root), "companies"));
  });
});
