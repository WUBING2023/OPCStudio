import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Company, AgentNodeConfig } from "@opc/shared";
import { loadAgents } from "./projectStore.js";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";

const OPC_DIR = ".opc";

function file(projectRoot: string) {
  return path.join(projectRoot, OPC_DIR, "companies.json");
}

export const DEFAULT_COMPANY_ID = "default";

// 战役B·Phase B2b:接后端开关。默认 json 逐字节不变(读 companies.json、写 companies.json);
// sqlite 时读走 companies 表(权威)、写【双写】(companies.json 照写 + 全量重写表)。整数组覆盖语义
// 与 governanceStore(B2a)一致。getCompany/addCompany/updateCompany/deleteCompany/ensureCompanies
// 全部经 load/save 自动生效,无需各自接开关。
export function loadCompanies(projectRoot: string): Company[] {
  if (isSqliteBackend(projectRoot)) {
    return readAllDocs(openBusinessDb(projectRoot), "companies") as Company[];
  }
  return readJSON<Company[]>(file(projectRoot), []);
}
export function saveCompanies(projectRoot: string, companies: Company[]) {
  writeJSON(file(projectRoot), companies);
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "companies", companies);
  }
}
export function getCompany(projectRoot: string, id: string): Company | undefined {
  return loadCompanies(projectRoot).find(c => c.id === id);
}
export function addCompany(projectRoot: string, company: Partial<Company> & { name: string }): Company {
  const companies = loadCompanies(projectRoot);
  const c: Company = {
    id: company.id ?? randomUUID().slice(0, 8),
    name: company.name,
    description: company.description ?? "",
    folder: company.folder,
    ceoId: company.ceoId,
    createdAt: company.createdAt ?? new Date().toISOString(),
    visibilityPolicy: company.visibilityPolicy,
    // Stage 5/6:install 时从 manifest 保留的元数据 + 交叉验证链(之前被这里静默丢弃)。
    manifestTemplateId: company.manifestTemplateId,
    manifestUseCases: company.manifestUseCases,
    manifestRiskNotes: company.manifestRiskNotes,
    manifestToolRequirements: company.manifestToolRequirements,
    workflow: company.workflow,
    manifestMcpRequirements: company.manifestMcpRequirements,
    presetChannels: company.presetChannels,
    memoryExportEnabled: company.memoryExportEnabled,
    maxTokensTotal: company.maxTokensTotal,
    // P0-B③:安装模板时保留的作者手填示例任务(持久落点,导出侧优先读它)。
    defaultTasks: company.defaultTasks,
    recommendedConfig: company.recommendedConfig,
    requiredPermissions: company.requiredPermissions,
    nativeExecution: company.nativeExecution,
  };
  companies.push(c);
  saveCompanies(projectRoot, companies);
  return c;
}
export function updateCompany(projectRoot: string, id: string, patch: Partial<Company>): Company | undefined {
  const companies = loadCompanies(projectRoot);
  const idx = companies.findIndex(c => c.id === id);
  if (idx === -1) return undefined;
  companies[idx] = { ...companies[idx], ...patch, id: companies[idx].id };
  saveCompanies(projectRoot, companies);
  return companies[idx];
}
export function deleteCompany(projectRoot: string, id: string): boolean {
  if (id === DEFAULT_COMPANY_ID) return false; // never delete the default company
  const companies = loadCompanies(projectRoot);
  const next = companies.filter(c => c.id !== id);
  if (next.length === companies.length) return false;
  saveCompanies(projectRoot, next);
  return true;
}

// Backfill: an older project with no companies.json gets a single default company seeded from the
// existing CEO agent. Returns the company list (guaranteed non-empty when agents exist).
export function ensureCompanies(projectRoot: string): Company[] {
  const existing = loadCompanies(projectRoot);
  if (existing.length > 0) return existing;
  const agents = loadAgents(projectRoot, []);
  const ceo = agents.find((a: AgentNodeConfig) => a.role === "ceo");
  const seeded: Company = {
    id: DEFAULT_COMPANY_ID,
    name: "默认公司",
    description: "由现有组织迁移而来",
    ceoId: ceo?.id,
    createdAt: new Date().toISOString(),
  };
  saveCompanies(projectRoot, [seeded]);
  return [seeded];
}
