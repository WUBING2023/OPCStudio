import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, SkillMeta, Skill } from "@opc/shared";
import { getSkillsDir } from "./userDataStore.js";

const OPC_DIR = ".opc";
const SKILLS_DIR = "skills";

let migrated = false;

function ensureMigration(projectRoot?: string) {
  if (migrated) return;
  migrated = true;

  const newDir = getSkillsDir();
  if (projectRoot) {
    const oldDir = path.join(projectRoot, OPC_DIR, SKILLS_DIR);
    if (fs.existsSync(oldDir)) {
      for (const file of fs.readdirSync(oldDir)) {
        if (!file.endsWith(".md")) continue;
        const oldPath = path.join(oldDir, file);
        const newPath = path.join(newDir, file);
        if (!fs.existsSync(newPath)) {
          fs.copyFileSync(oldPath, newPath);
        }
      }
    }
  }
}

export function skillsDir(_projectRoot?: string): string {
  ensureMigration(_projectRoot);
  const dir = getSkillsDir();
  fs.mkdirSync(dir, { recursive: true });
  ensureOriginMigration(dir);
  return dir;
}

// 技能库分层 · 存量迁移(幂等):进程内只跑一次(见 ensureOriginMigration 的 flag),给缺 origin frontmatter
// 的老技能按 inferSkillOrigin() 规则回填。直接操作原始 frontmatter(不经 readMetaFields 白名单),只加
// origin 一个字段,其余字段原样保留;写回后把 mtime 复原,不让"补字段"污染 lastModified/最近修改排序。
function migrateSkillOriginsInDir(dir: string): Record<NonNullable<SkillMeta["origin"]>, number> {
  const stats: Record<NonNullable<SkillMeta["origin"]>, number> = { user: 0, persona: 0, memory: 0, bundled: 0 };
  if (!fs.existsSync(dir)) return stats;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const filepath = path.join(dir, file);
    const raw = fs.readFileSync(filepath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    let origin = meta.origin as SkillMeta["origin"] | undefined;
    if (origin !== "user" && origin !== "persona" && origin !== "memory" && origin !== "bundled") {
      const id = skillIdFromFilename(file);
      origin = inferSkillOrigin(id, meta.title || id);
      const stat = fs.statSync(filepath);
      fs.writeFileSync(filepath, buildFrontmatter({ ...meta, origin }) + body, "utf-8");
      try { fs.utimesSync(filepath, stat.atime, stat.mtime); } catch { /* best-effort,不影响迁移本身 */ }
    }
    stats[origin]++;
  }
  return stats;
}

let originsMigrated = false;
function ensureOriginMigration(dir: string) {
  if (originsMigrated) return;
  originsMigrated = true;
  try { migrateSkillOriginsInDir(dir); } catch { /* best-effort:迁移失败不阻断技能读写 */ }
}

// 供启动脚本/CLI 手动触发并拿到本次分类统计(与 ensureOriginMigration 的一次性 flag 无关,可重复调用;
// 重复调用是安全的空操作——只会再数一遍已分类的技能,不会重复改写)。
export function migrateSkillOrigins(projectRoot?: string): Record<NonNullable<SkillMeta["origin"]>, number> {
  ensureMigration(projectRoot);
  const dir = getSkillsDir();
  fs.mkdirSync(dir, { recursive: true });
  return migrateSkillOriginsInDir(dir);
}

// Stage 8 安全:skill id 用于 `${id}.md` 文件名 → 拦路径穿越向量(分隔符/../null),防写出/读取 skills 目录外。
function cid(id: string): string {
  if (typeof id !== "string" || !id || id.length > 80 || /[/\\]|\.\.|\0/.test(id)) {
    throw new Error(`invalid skill id: ${String(id).slice(0, 40)}`);
  }
  return id;
}

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };
  const endIdx = lines.slice(1).findIndex(l => l.trim() === "---");
  if (endIdx === -1) return { meta: {}, body: content };
  const fmLines = lines.slice(1, endIdx + 1);
  const meta: Record<string, string> = {};
  for (const line of fmLines) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const body = lines.slice(endIdx + 2).join("\n");
  return { meta, body };
}

function buildFrontmatter(meta: Record<string, string>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function skillIdFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "");
}

// v3: 从 frontmatter 读出来源/License 元数据（全部可选，老文件无则不带）。
function readMetaFields(meta: Record<string, string>): Partial<SkillMeta> {
  const out: Partial<SkillMeta> = {};
  if (meta.description) out.description = meta.description;
  if (meta.license) out.license = meta.license;
  if (meta.licenseUrl) out.licenseUrl = meta.licenseUrl;
  if (meta.author) out.author = meta.author;
  if (meta.authorGitHub) out.authorGitHub = meta.authorGitHub;
  if (meta.checksum) out.checksum = meta.checksum;
  if (meta.source) { try { out.source = JSON.parse(meta.source); } catch { /* 忽略坏 source */ } }
  if (meta.origin === "user" || meta.origin === "persona" || meta.origin === "memory" || meta.origin === "bundled") out.origin = meta.origin;
  if (meta.companyId) out.companyId = meta.companyId; // C1:bundled 技能公司归属(legacy 无此字段)
  return out;
}

// v3: 把 skill 的来源/License 元数据写回 frontmatter（仅写有值的，保持文件干净）。
function writeMetaFields(skill: Pick<Skill, "title" | "role" | "enabled"> & Partial<SkillMeta>): Record<string, string> {
  const fm: Record<string, string> = {
    title: skill.title,
    role: skill.role,
    enabled: skill.enabled ? "true" : "false",
  };
  if (skill.description) fm.description = skill.description;
  if (skill.license) fm.license = skill.license;
  if (skill.licenseUrl) fm.licenseUrl = skill.licenseUrl;
  if (skill.author) fm.author = skill.author;
  if (skill.authorGitHub) fm.authorGitHub = skill.authorGitHub;
  if (skill.checksum) fm.checksum = skill.checksum;
  if (skill.source) fm.source = JSON.stringify(skill.source);
  if (skill.origin) fm.origin = skill.origin;
  if (skill.companyId) fm.companyId = skill.companyId; // C1:bundled 技能公司归属(有值才写,保持文件干净)
  return fm;
}

// 技能库分层地基:按 id/title 命名模式推断一个技能的来源分层(createSkill 未显式传 origin 时的兜底,
// 也是存量迁移 migrateSkillOrigins 的核心规则)。规则(与实际磁盘数据核对过,详见迁移报告):
// - title 以 "workflow-" 开头 → 旧 skillEvolution.ts(C层,已砍)物化的程序性技能沉淀,判定
//   **必须排在 id 判断之前**——记忆架构瘦身验收时活体证实了一条洗白通道:C层技能被"技能孵化器"
//   (skillRoutes.ts 的 team 模式)打包进 bundledSkills、经社区模板安装重新落盘后,id 会变成
//   `bundled-{tplId}-{name}--{role}` 这种形状;若先判 id 前缀,这类技能会被误判成 origin:"bundled"、
//   绕过 contextBuilder.ts 新加的 `origin!=="memory"` 过滤器,继续被真实注入进 agent 的 system prompt
//   (已用真实 CEO 任务调用证实发生过)。title 判断优先,能把这类"披着bundled外皮的C层遗产"正确
//   打回 memory,不留下这条绕路。
// - id 以 "bundled-" 开头 → 模板/工坊安装时按角色扇出的打包技能副本(communityRoutes.ts install/company)
// - id 以 "sk-" 或 "wk-" 开头 → 导入为员工/孵化时按角色作用域落盘的人设副本("sk-${role}" 命名模式)
// - 其余 → 用户自己创建/导入的真技能
export function inferSkillOrigin(id: string, title: string): NonNullable<SkillMeta["origin"]> {
  // P0-3 · 旧 C 层(skillEvolution.ts)已砍,不再自动把 procedural memory 写进 skill store。
  // workflow-* 前缀的遗留记忆技能转为 user(保留内容,但标记为 manually promoted)。
  if (title.startsWith("workflow-")) return "user";
  if (id.startsWith("bundled-")) return "bundled";
  if (id.startsWith("sk-") || id.startsWith("wk-")) return "persona";
  return "user";
}

// opts.origin 不传 = 全量返回(向后兼容——contextBuilder 等内部消费方不传,继续拿到全部技能不受影响)。
// 传了则只返回该分层(SkillsPage 默认只拉 origin=user,给用户看自己的真实资产)。
export function listSkills(projectRoot?: string, opts?: { origin?: SkillMeta["origin"] }): SkillMeta[] {
  const dir = skillsDir(projectRoot);
  const results: SkillMeta[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const id = skillIdFromFilename(file);
    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);
    const raw = fs.readFileSync(filepath, "utf-8");
    const { meta } = parseFrontmatter(raw);
    results.push({
      id,
      title: meta.title || id,
      role: meta.role || "dev",
      enabled: meta.enabled !== "false",
      lastModified: stat.mtime.toISOString(),
      ...readMetaFields(meta),
    });
  }
  if (opts?.origin) return results.filter(s => (s.origin ?? "user") === opts.origin);
  return results;
}

export function getSkill(projectRoot: string | undefined, id: string): Skill | null {
  const dir = skillsDir(projectRoot);
  const filepath = path.join(dir, `${cid(id)}.md`);
  if (!fs.existsSync(filepath)) return null;
  const stat = fs.statSync(filepath);
  const raw = fs.readFileSync(filepath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);
  return {
    id,
    title: meta.title || id,
    role: meta.role || "dev",
    enabled: meta.enabled !== "false",
    lastModified: stat.mtime.toISOString(),
    ...readMetaFields(meta),
    content: body,
  };
}

export function createSkill(projectRoot: string | undefined, skill: Skill): Skill {
  const dir = skillsDir(projectRoot);
  const filepath = path.join(dir, `${cid(skill.id)}.md`);
  if (fs.existsSync(filepath)) throw new Error(`Skill "${skill.id}" already exists`);
  // 调用方没显式打 origin(如 communityRoutes.ts 的打包技能扇出)→ 按命名模式兜底推断,
  // 保证技能库分层不依赖"每个写入点都记得手动打标"。
  const tagged: Skill = { ...skill, origin: skill.origin ?? inferSkillOrigin(skill.id, skill.title) };
  const fm = buildFrontmatter(writeMetaFields(tagged));
  fs.writeFileSync(filepath, fm + tagged.content, "utf-8");
  return tagged;
}

export function updateSkill(projectRoot: string | undefined, id: string, patch: Partial<Skill>): Skill {
  const existing = getSkill(projectRoot, id);
  if (!existing) throw new Error(`Skill "${id}" not found`);
  const merged = { ...existing, ...patch, id };
  const dir = skillsDir(projectRoot);
  const filepath = path.join(dir, `${cid(id)}.md`);
  const fm = buildFrontmatter(writeMetaFields(merged));
  fs.writeFileSync(filepath, fm + merged.content, "utf-8");
  return merged;
}

export function deleteSkill(projectRoot: string | undefined, id: string): boolean {
  const dir = skillsDir(projectRoot);
  const filepath = path.join(dir, `${cid(id)}.md`);
  if (!fs.existsSync(filepath)) return false;
  fs.unlinkSync(filepath);
  return true;
}

export interface PersonaSkillMigrationResult {
  migratedAgentIds: string[];
  removedSkillIds: string[];
  orphanedSkillIds: string[];
  failedSkillIds: string[];
}

/**
 * Legacy builds stored employee personas as globally visible Skills. Move those prompts onto the
 * matching AgentNodeConfig, which is the canonical runtime and template field, then remove the
 * duplicate Skill records. Company-scoped records match by company + role; old unscoped records
 * migrate only when their role identifies exactly one agent.
 */
export function migrateLegacyPersonaSkills(
  projectRoot: string | undefined,
  agents: AgentNodeConfig[],
  persistPrompt: (agentId: string, systemPrompt: string) => void,
): PersonaSkillMigrationResult {
  const result: PersonaSkillMigrationResult = {
    migratedAgentIds: [],
    removedSkillIds: [],
    orphanedSkillIds: [],
    failedSkillIds: [],
  };

  for (const meta of listSkills(projectRoot, { origin: "persona" })) {
    const skill = getSkill(projectRoot, meta.id);
    if (!skill) continue;
    const sameRole = agents.filter((agent) => agent.role === skill.role);
    const matches = skill.companyId
      ? sameRole.filter((agent) => (agent.companyId || "default") === skill.companyId)
      : sameRole.length === 1 ? sameRole : [];

    let failed = false;
    for (const agent of matches) {
      if (agent.systemPrompt?.trim() || !skill.content.trim()) continue;
      try {
        const prompt = skill.content.slice(0, 32 * 1024);
        persistPrompt(agent.id, prompt);
        agent.systemPrompt = prompt;
        result.migratedAgentIds.push(agent.id);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      result.failedSkillIds.push(skill.id);
      continue;
    }

    if (matches.length === 0) result.orphanedSkillIds.push(skill.id);
    try {
      if (deleteSkill(projectRoot, skill.id)) result.removedSkillIds.push(skill.id);
    } catch {
      result.failedSkillIds.push(skill.id);
    }
  }
  return result;
}

export function toggleSkill(projectRoot: string | undefined, id: string): Skill | null {
  const existing = getSkill(projectRoot, id);
  if (!existing) return null;
  return updateSkill(projectRoot, id, { enabled: !existing.enabled });
}
