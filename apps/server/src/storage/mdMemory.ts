import * as fs from "node:fs";
import * as path from "node:path";

// OPC 层「共享 md 记忆」——框架无关:无论节点跑在 claude-code / codex / Hermes,记忆都以纯文本注入
// prompt、跑后写回 md 文件,因此换执行框架不丢记忆(解决 v2 的 Q1 可移植问题)。四层:
//   company.md           —— 公司共性知识 / 对外口径(CEO 维护/初始化),全员可读
//   teams/<leadId>.md    —— 团队职责 + 能力史(lead 维护/自扫描初始化),团队成员可读
//   projects/<id>.md     —— 项目目标 / 设计 / 共享事实档案(编排器维护),项目内可读
//   agents/<id>-memory.md —— 每个 agent 的持久记忆(跑后写回),仅该 agent 读
// 统一存放于 <projectRoot>/.opc/knowledge/(随项目,可 gitignore 私有内容)。

function knowledgeDir(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "knowledge");
}
const safe = (s: string) => (s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);

// company.md 按公司隔离(2026-07-04):以前全项目共享一份 `.opc/knowledge/company.md`,不同公司的知识
// 混在一起。现在按 companyId 各自一份 `.opc/knowledge/companies/<companyId>/company.md`。
//
// companyId 在类型上仍是可选的——这是刻意的向后兼容口子,不是没做完:contextBuilder.ts(注入 prompt)
// 和 memoryPack.ts(记忆聚合视图)两处遗留读取点目前仍按旧签名调用(不传 companyId),继续读旧的全局共享
// 文件。这两处不在本次改造范围内,所以"写"(ensureCompanyMd/appendCompanyKnowledge,见 orchestrator.ts)
// 已经隔离到各公司,但运行时真正注入到 agent prompt 里的仍是旧共享文件的内容——隔离尚未在读侧生效,
// 是明确的已知缺口,见改造说明。
export function companyMdPath(projectRoot: string, companyId?: string): string {
  if (!companyId) return path.join(knowledgeDir(projectRoot), "company.md"); // 旧的全局共享路径(遗留调用点回退到此)
  return path.join(knowledgeDir(projectRoot), "companies", safe(companyId), "company.md");
}

// 一次性迁移(幂等):某公司的隔离文件第一次被访问、尚不存在,但旧的全局共享文件存在时,把旧文件内容
// 复制一份作为这个公司的初始内容。旧文件本来就混着多个公司的东西,没法真正拆分——只能让每个公司从同一个
// 起点各自独立累积,之后不再共享。旧的全局文件本身保留不删除(以防 contextBuilder.ts/memoryPack.ts 等
// 遗留调用点还在用)。best-effort:迁移失败就当没有初始内容,后续 ensureCompanyMd 会补冷启动骨架。
function migrateLegacyCompanyMd(projectRoot: string, companyId: string): void {
  const isolatedPath = companyMdPath(projectRoot, companyId);
  if (fs.existsSync(isolatedPath)) return;
  const legacyPath = companyMdPath(projectRoot);
  if (!fs.existsSync(legacyPath)) return;
  try {
    const legacyContent = fs.readFileSync(legacyPath, "utf-8");
    fs.mkdirSync(path.dirname(isolatedPath), { recursive: true });
    fs.writeFileSync(isolatedPath, legacyContent, "utf-8");
  } catch { /* best-effort */ }
}
export function teamMdPath(projectRoot: string, leadId: string): string {
  return path.join(knowledgeDir(projectRoot), "teams", `${safe(leadId)}.md`);
}
export function projectMdPath(projectRoot: string, projectId: string): string {
  return path.join(knowledgeDir(projectRoot), "projects", `${safe(projectId)}.md`);
}
export function agentMemoryPath(projectRoot: string, agentId: string): string {
  return path.join(knowledgeDir(projectRoot), "agents", `${safe(agentId)}-memory.md`);
}
export function userMemoryPath(projectRoot: string, userId = "local-user"): string {
  return path.join(projectRoot, ".opc", "memory", "users", safe(userId), "preferences.md");
}

function readMd(p: string): string {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").trim() : ""; } catch { return ""; }
}
export function readCompanyMd(projectRoot: string, companyId?: string): string {
  if (companyId) migrateLegacyCompanyMd(projectRoot, companyId);
  return readMd(companyMdPath(projectRoot, companyId));
}
export function readTeamMd(projectRoot: string, leadId?: string): string { return leadId ? readMd(teamMdPath(projectRoot, leadId)) : ""; }
export function readProjectMd(projectRoot: string, projectId?: string): string { return projectId ? readMd(projectMdPath(projectRoot, projectId)) : ""; }
export function readAgentMemory(projectRoot: string, agentId: string): string { return readMd(agentMemoryPath(projectRoot, agentId)); }
export function readUserMd(projectRoot: string, userId = "local-user"): string { return readMd(userMemoryPath(projectRoot, userId)); }

function writeMd(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.endsWith("\n") ? content : content + "\n", "utf-8");
}
export function writeCompanyMd(projectRoot: string, content: string, companyId?: string): void { writeMd(companyMdPath(projectRoot, companyId), content); }
export function writeTeamMd(projectRoot: string, leadId: string, content: string): void { writeMd(teamMdPath(projectRoot, leadId), content); }
export function writeProjectMd(projectRoot: string, projectId: string, content: string): void { writeMd(projectMdPath(projectRoot, projectId), content); }
export function writeUserMd(projectRoot: string, userId: string, content: string): void { writeMd(userMemoryPath(projectRoot, userId), content); }

// 跑后写回:把一条学得的经验追加进该 agent 的持久记忆(去重 + 上限,避免无限膨胀)。
const MAX_AGENT_MEMORY_LINES = 60;
export function appendAgentMemory(projectRoot: string, agentId: string, line: string, stampIso?: string): void {
  const clean = (line || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  try {
    const p = agentMemoryPath(projectRoot, agentId);
    const existing = readMd(p);
    if (existing.includes(clean)) return; // 已记过,跳过
    const stamp = (stampIso || new Date().toISOString()).slice(0, 10);
    const lines = (existing ? existing.split("\n") : []).filter((l) => l.trim());
    lines.push(`- [${stamp}] ${clean}`);
    const trimmed = lines.slice(-MAX_AGENT_MEMORY_LINES); // 只留最近 N 条
    writeMd(p, trimmed.join("\n"));
  } catch { /* best-effort,记忆写回失败不影响 run */ }
}

// 团队能力史(决策#2):在 team.md 的「最近任务」区维护**最近 3 条**任务记录,供 CEO 按团队战绩选队。
// team.md 结构 = 静态花名册 + 该区;只重写该区,不动花名册。
const TEAM_HISTORY_HEADER = "## 最近任务(能力史)";
const MAX_TEAM_HISTORY = 3;
export function appendTeamTask(projectRoot: string, leadId: string, taskLine: string, stampIso?: string): void {
  const clean = (taskLine || "").replace(/\s+/g, " ").trim();
  if (!leadId || !clean) return;
  try {
    const p = teamMdPath(projectRoot, leadId);
    const existing = readMd(p);
    const idx = existing.indexOf(TEAM_HISTORY_HEADER);
    const staticPart = (idx >= 0 ? existing.slice(0, idx) : existing).trim();
    const histPart = idx >= 0 ? existing.slice(idx + TEAM_HISTORY_HEADER.length) : "";
    const stamp = (stampIso || new Date().toISOString()).slice(0, 10);
    const hist = histPart.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    hist.push(`- [${stamp}] ${clean}`);
    const kept = hist.slice(-MAX_TEAM_HISTORY);
    writeMd(p, `${staticPart}\n\n${TEAM_HISTORY_HEADER}\n${kept.join("\n")}`);
  } catch { /* best-effort */ }
}

// company.md 的持续维护(决策#5):run 收尾把项目历程追加进「项目历程」区(保留最近 N 条),使 company.md
// 不止冷启动 init、而是随每次运行累积演进。只重写该区,不动 CEO 初始化的公司描述/团队花名册。
const COMPANY_HISTORY_HEADER = "## 项目历程(自动累积)";
const MAX_COMPANY_HISTORY = 12;
export function appendCompanyKnowledge(projectRoot: string, line: string, stampIso?: string, companyId?: string): void {
  const clean = (line || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  try {
    const p = companyMdPath(projectRoot, companyId);
    const existing = readMd(p);
    if (!existing) return; // company.md 尚未 init 则不创建(由 ensureCompanyMd 负责首建)
    const idx = existing.indexOf(COMPANY_HISTORY_HEADER);
    const staticPart = (idx >= 0 ? existing.slice(0, idx) : existing).trim();
    const histPart = idx >= 0 ? existing.slice(idx + COMPANY_HISTORY_HEADER.length) : "";
    const stamp = (stampIso || new Date().toISOString()).slice(0, 10);
    const hist = histPart.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
    if (hist.some((l) => l.includes(clean))) return; // 去重
    hist.push(`- [${stamp}] ${clean}`);
    writeMd(p, `${staticPart}\n\n${COMPANY_HISTORY_HEADER}\n${hist.slice(-MAX_COMPANY_HISTORY).join("\n")}`);
  } catch { /* best-effort */ }
}
