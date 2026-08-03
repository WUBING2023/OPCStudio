import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentCard, CompanyTemplate, TeamTemplate, PromptTemplate, CommunityIndex, CommunityIndexEntry, CommunityFavorites, CommunityContentType, GitHubRepoSource, Skill, SkillSource } from "@opc/shared";
import { DEFAULT_ALLOWED_LICENSES } from "@opc/shared";
import { seedCommunityContent } from "../communitySeed.js";
import { parseFrontmatter } from "./skillStore.js";
import { readJSON, writeJSON } from "./jsonFile.js";
import * as crypto from "node:crypto";

const OPC_DIR = ".opc";
const COMMUNITY_DIR = "community";

function communityDir(projectRoot: string) {
  return path.join(projectRoot, OPC_DIR, COMMUNITY_DIR);
}

// Stage 8 安全:内容 id 用于 `${cid(id)}.json` 文件名 → 必须净化,防 ../ 路径穿越写出/读取 community 目录外。
function cid(id: string): string {
  // 只拦真正的路径穿越向量(分隔符/../null),不强求 ASCII —— 不破坏现有非 ASCII 但安全的 id;
  // 严格 ASCII 校验留给新导入的 zod schema(SAFE_CONTENT_ID)。
  if (typeof id !== "string" || !id || id.length > 80 || /[/\\]|\.\.|\0/.test(id)) {
    throw new Error(`invalid content id: ${String(id).slice(0, 40)}`);
  }
  return id;
}

function sourcesFile(projectRoot: string) {
  return path.join(communityDir(projectRoot), "sources.json");
}

function ensureSeeded(projectRoot: string) {
  const dir = communityDir(projectRoot);
  if (!fs.existsSync(dir)) {
    seedCommunityContent(projectRoot);
  }
}

// GitHub repo source management — persisted to .opc/community/sources.json (was a process-memory
// array that vanished on restart). add/remove/list now read/write the file.
export function listGitHubSources(projectRoot: string): GitHubRepoSource[] {
  return readJSON<GitHubRepoSource[]>(sourcesFile(projectRoot), []);
}

export function addGitHubSource(projectRoot: string, source: GitHubRepoSource): GitHubRepoSource {
  const sources = listGitHubSources(projectRoot);
  const existing = sources.find(s => s.owner === source.owner && s.name === source.name);
  if (existing) {
    existing.branch = source.branch;
    if (source.label) existing.label = source.label;
  } else {
    sources.push({ ...source, addedAt: source.addedAt ?? new Date().toISOString() });
  }
  writeJSON(sourcesFile(projectRoot), sources);
  return source;
}

export function removeGitHubSource(projectRoot: string, owner: string, name: string): boolean {
  const sources = listGitHubSources(projectRoot);
  const next = sources.filter(s => !(s.owner === owner && s.name === name));
  if (next.length === sources.length) return false;
  writeJSON(sourcesFile(projectRoot), next);
  return true;
}

export async function fetchGitHubRepoContents(
  owner: string, repo: string, branch: string, dirPath: string
): Promise<{ templates: CompanyTemplate[]; agents: AgentCard[]; prompts: PromptTemplate[] }> {
  const result = { templates: [] as CompanyTemplate[], agents: [] as AgentCard[], prompts: [] as PromptTemplate[] };
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!resp.ok) return result;
    const entries = await resp.json() as any[];
    if (!Array.isArray(entries)) return result;

    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json") || !entry.download_url) continue;
      try {
        const fileResp = await fetch(entry.download_url);
        if (!fileResp.ok) continue;
        const data = await fileResp.json();

        // Detect type by structure
        if (data.readme && Array.isArray(data.agents)) {
          result.templates.push(data as CompanyTemplate);
        } else if (data.agent && data.agent.systemPrompt) {
          result.agents.push(data as AgentCard);
        } else if (data.content && typeof data.enabled === "boolean") {
          result.prompts.push(data as PromptTemplate);
        }
      } catch { /* skip malformed entries */ }
    }
  } catch { /* network errors - return empty */ }
  return result;
}

// v3 B1: 列出社区 builtin skills（.opc/community/skills/<id>.md，OPC 官方 worker=skill）。
export function listBuiltinCommunitySkills(projectRoot: string): Skill[] {
  const dir = path.join(communityDir(projectRoot), "skills");
  if (!fs.existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const id = file.replace(/\.md$/, "");
      out.push({
        id, title: meta.title || id, role: meta.role || "dev", enabled: meta.enabled !== "false",
        lastModified: "", description: meta.description, license: meta.license,
        author: meta.author, authorGitHub: meta.authorGitHub, content: body,
      });
    } catch { /* skip */ }
  }
  return out;
}

// ── v3: 从 GitHub 拉取 .skill/.md 技能文件（董事长设想：worker = GitHub 下载的 skill）──

// 读取仓库的 SPDX License（GitHub License API），用于来源不带 license frontmatter 时兜底。
export async function fetchRepoLicense(owner: string, repo: string): Promise<{ spdx?: string; url?: string } | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/license`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return { spdx: data?.license?.spdx_id, url: data?.html_url };
  } catch {
    return null;
  }
}

// License 合规校验：license 必须在白名单内；未知 license → fail-closed（不允许）。
export function isLicenseAllowed(license: string | undefined, allowed: string[] = DEFAULT_ALLOWED_LICENSES): boolean {
  if (!license) return false;
  if (license === "NOASSERTION") return false; // GitHub 对未识别 license 的返回值
  return allowed.includes(license);
}

export interface RemoteSkill extends Skill {
  licenseAllowed: boolean; // 是否通过白名单（前端据此禁用"下载"按钮）
}

// 拉取一个目录下所有 .skill/.md 文件，解析为带来源/License 的 RemoteSkill 列表。
export async function fetchGitHubSkillFiles(
  owner: string, repo: string, branch: string, dirPath: string, allowed: string[] = DEFAULT_ALLOWED_LICENSES
): Promise<RemoteSkill[]> {
  const out: RemoteSkill[] = [];
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (!resp.ok) return out;
    const entries = await resp.json() as any[];
    if (!Array.isArray(entries)) return out;
    const repoLicense = await fetchRepoLicense(owner, repo);

    for (const entry of entries) {
      if (entry.type !== "file" || !entry.download_url) continue;
      if (!/\.(skill|md|skill\.md)$/.test(entry.name)) continue;
      try {
        const fileResp = await fetch(entry.download_url);
        if (!fileResp.ok) continue;
        const raw = await fileResp.text();
        const { meta, body } = parseFrontmatter(raw);
        const id = (meta.name || entry.name.replace(/\.(skill\.md|skill|md)$/, "")).trim();
        const source: SkillSource = { owner, repo, branch, path: entry.path, url: entry.download_url };
        // license 优先 frontmatter（SPDX 形式），否则仓库 LICENSE 的 spdx。
        const license = meta.license && /^[A-Za-z0-9.\-]+$/.test(meta.license) ? meta.license : (repoLicense?.spdx || undefined);
        out.push({
          id,
          title: meta.title || meta.name || id,
          role: meta.role || "dev",
          enabled: true,
          lastModified: new Date().toISOString(),
          description: meta.description,
          license,
          licenseUrl: repoLicense?.url,
          author: meta.author,
          authorGitHub: owner,
          source,
          checksum: crypto.createHash("sha256").update(body).digest("hex").slice(0, 16),
          content: body,
          licenseAllowed: isLicenseAllowed(license, allowed),
        });
      } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 网络错误 → 空 */ }
  return out;
}

export async function loadGitHubCommunityItems(projectRoot: string): Promise<{ templates: CompanyTemplate[]; agents: AgentCard[]; prompts: PromptTemplate[] }> {
  const result = { templates: [] as CompanyTemplate[], agents: [] as AgentCard[], prompts: [] as PromptTemplate[] };
  for (const src of listGitHubSources(projectRoot)) {
    const items = await fetchGitHubRepoContents(src.owner, src.name, src.branch, "community/templates");
    result.templates.push(...items.templates);
    const agents = await fetchGitHubRepoContents(src.owner, src.name, src.branch, "community/agents");
    result.agents.push(...agents.agents);
    const prompts = await fetchGitHubRepoContents(src.owner, src.name, src.branch, "community/prompts");
    result.prompts.push(...prompts.prompts);
  }
  return result;
}

// Index
export function loadCommunityIndex(projectRoot: string): CommunityIndex {
  ensureSeeded(projectRoot);
  const idx = readJSON<CommunityIndex>(
    path.join(communityDir(projectRoot), "index.json"),
    { templates: [], teams: [], agents: [], prompts: [] }
  );
  // Robust against older index.json written before the `teams` shelf existed.
  if (!idx.teams) idx.teams = [];
  return idx;
}

export function saveCommunityIndex(projectRoot: string, index: CommunityIndex) {
  ensureSeeded(projectRoot);
  writeJSON(path.join(communityDir(projectRoot), "index.json"), index);
}

// D8(指南 11.17 Community Report / Unlist)· "下架"是标记不是物理删除——列表默认把 visibility
// === "unlisted" 的条目过滤掉,但记录本体(index 条目 + 内容文件)照样完整保留,按 id 直读依旧能拿到。
// 缺省(未传 includeUnlisted)= 过滤;传 includeUnlisted:true 用于体检/管理类场景需要看到全量。
export interface ListOptions {
  includeUnlisted?: boolean;
}
function excludeUnlisted(list: CommunityIndexEntry[], opts?: ListOptions): CommunityIndexEntry[] {
  if (opts?.includeUnlisted) return list;
  return list.filter(e => e.visibility !== "unlisted");
}

// Listing
export function listTemplates(projectRoot: string, opts?: ListOptions) {
  return excludeUnlisted(loadCommunityIndex(projectRoot).templates, opts);
}

export function listTeams(projectRoot: string, opts?: ListOptions) {
  return excludeUnlisted(loadCommunityIndex(projectRoot).teams, opts);
}

export function listAgentCards(projectRoot: string, opts?: ListOptions) {
  return excludeUnlisted(loadCommunityIndex(projectRoot).agents, opts);
}

export function listPrompts(projectRoot: string, opts?: ListOptions) {
  return excludeUnlisted(loadCommunityIndex(projectRoot).prompts, opts);
}

// D8 · 下架本地库(.opc/community/index.json)里的一条记录——只打 visibility:"unlisted" + unlistedAt,
// 不删 index 条目、不删内容文件(templates/teams/agents/prompts 各自目录下的 <id>.json 原样保留,
// getTemplate/getTeam/... 按 id 直读依旧能拿到完整内容)。返回 false = 该 id 不在索引里(无法下架)。
export function unlistLocalEntry(projectRoot: string, type: IndexShelf, id: string): boolean {
  const index = loadCommunityIndex(projectRoot);
  const entry = shelfList(index, type).find(e => e.id === id);
  if (!entry) return false;
  entry.visibility = "unlisted";
  entry.unlistedAt = new Date().toISOString();
  saveCommunityIndex(projectRoot, index);
  return true;
}

// Template CRUD
export function getTemplate(projectRoot: string, id: string): CompanyTemplate | null {
  const filepath = path.join(communityDir(projectRoot), "templates", `${cid(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTemplate(projectRoot: string, template: CompanyTemplate) {
  ensureSeeded(projectRoot);
  const dir = communityDir(projectRoot);
  writeJSON(path.join(dir, "templates", `${cid(template.id)}.json`), template);

  const index = loadCommunityIndex(projectRoot);
  const existing = index.templates.findIndex(t => t.id === template.id);
  const entry = {
    id: template.id,
    title: template.title,
    author: template.author,
    authorGitHub: template.authorGitHub,
    tags: template.tags,
    downloads: template.downloads,
    stars: template.stars,
    createdAt: template.createdAt,
    agentCount: template.agents.length,
    license: template.license ?? "OPC-Original",
  };
  if (existing >= 0) {
    index.templates[existing] = entry;
  } else {
    index.templates.push(entry);
  }
  saveCommunityIndex(projectRoot, index);
}

// Team CRUD (a lead + subtree)
export function getTeam(projectRoot: string, id: string): TeamTemplate | null {
  const filepath = path.join(communityDir(projectRoot), "teams", `${cid(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTeam(projectRoot: string, team: TeamTemplate) {
  ensureSeeded(projectRoot);
  const dir = communityDir(projectRoot);
  writeJSON(path.join(dir, "teams", `${cid(team.id)}.json`), team);

  const index = loadCommunityIndex(projectRoot);
  const existing = index.teams.findIndex(t => t.id === team.id);
  const entry = {
    id: team.id, title: team.title, author: team.author, authorGitHub: team.authorGitHub,
    tags: team.tags, downloads: team.downloads, stars: team.stars, createdAt: team.createdAt,
    agentCount: team.agents.length, license: team.license ?? "OPC-Original",
  };
  if (existing >= 0) index.teams[existing] = entry;
  else index.teams.push(entry);
  saveCommunityIndex(projectRoot, index);
}

// Agent Card CRUD
export function getAgentCard(projectRoot: string, id: string): AgentCard | null {
  const filepath = path.join(communityDir(projectRoot), "agents", `${cid(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

export function saveAgentCard(projectRoot: string, card: AgentCard) {
  ensureSeeded(projectRoot);
  const dir = communityDir(projectRoot);
  writeJSON(path.join(dir, "agents", `${cid(card.id)}.json`), card);

  const index = loadCommunityIndex(projectRoot);
  const existing = index.agents.findIndex(a => a.id === card.id);
  const entry = {
    id: card.id,
    title: card.title,
    author: card.author,
    authorGitHub: card.authorGitHub,
    role: card.role,
    tags: card.tags,
    downloads: card.downloads,
    stars: card.stars,
    createdAt: card.createdAt,
    license: card.license ?? "OPC-Original",
    sourceUrl: card.sourceUrl,
  };
  if (existing >= 0) {
    index.agents[existing] = entry;
  } else {
    index.agents.push(entry);
  }
  saveCommunityIndex(projectRoot, index);
}

// Prompt Template CRUD
export function getPrompt(projectRoot: string, id: string): PromptTemplate | null {
  const filepath = path.join(communityDir(projectRoot), "prompts", `${cid(id)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

export function savePrompt(projectRoot: string, prompt: PromptTemplate) {
  ensureSeeded(projectRoot);
  const dir = communityDir(projectRoot);
  writeJSON(path.join(dir, "prompts", `${cid(prompt.id)}.json`), prompt);

  const index = loadCommunityIndex(projectRoot);
  const existing = index.prompts.findIndex(p => p.id === prompt.id);
  const entry = {
    id: prompt.id,
    title: prompt.name,
    author: prompt.author,
    authorGitHub: prompt.authorGitHub,
    tags: prompt.tags,
    downloads: prompt.downloads,
    stars: prompt.stars,
    createdAt: prompt.createdAt,
  };
  if (existing >= 0) {
    index.prompts[existing] = entry;
  } else {
    index.prompts.push(entry);
  }
  saveCommunityIndex(projectRoot, index);
}

// Stats
export type IndexShelf = "templates" | "teams" | "agents" | "prompts";

function shelfList(index: CommunityIndex, type: IndexShelf) {
  return type === "templates" ? index.templates
    : type === "teams" ? index.teams
    : type === "agents" ? index.agents
    : index.prompts;
}

export function incrementDownload(projectRoot: string, type: IndexShelf, id: string) {
  const index = loadCommunityIndex(projectRoot);
  const entry = shelfList(index, type).find(e => e.id === id);
  if (entry) {
    entry.downloads++;
    saveCommunityIndex(projectRoot, index);
  }
}

export function incrementStar(projectRoot: string, type: IndexShelf, id: string) {
  const index = loadCommunityIndex(projectRoot);
  const entry = shelfList(index, type).find(e => e.id === id);
  if (entry) {
    entry.stars++;
    saveCommunityIndex(projectRoot, index);
  }
}

// D8(指南 11.17)· 远程(GitHub 社区仓库)内容的下架标记——独立于本地库(templates/teams/agents/
// prompts 各自目录),因为远程条目本就不在本地存文件,每次浏览都是现拉现建(computeRemote)。
// 这份 .opc/community/remote-unlisted.json 只记 {type,id,unlistedAt} 三元组,不是"删了远程仓库的
// 文件"——GitHub 历史不可能被真正抹掉(11.17 原文),真正的文件增删只能靠 remote/delete 那条 PR
// 流程走完、且被社区仓库那边独立维护的 review.mjs Action 审核通过才会生效(该 Action 的实现在
// 另一个仓库,不在本项目代码里,本批不改它、也不假设它的行为)。这份本地标记的作用是:用户点了
// "下架"之后,**不等 PR 合并**,当前这台机器上的 OPC Studio 立刻把该条目从浏览列表里滤掉——
// 对用户体验来说这就是"下架生效了",跟 PR 最终是否被合并是两件独立的事,如实分开。
function remoteUnlistedFile(projectRoot: string) {
  return path.join(communityDir(projectRoot), "remote-unlisted.json");
}
export interface RemoteUnlistedEntry { type: string; id: string; unlistedAt: string }

export function loadRemoteUnlisted(projectRoot: string): RemoteUnlistedEntry[] {
  return readJSON<RemoteUnlistedEntry[]>(remoteUnlistedFile(projectRoot), []);
}

export function markRemoteUnlisted(projectRoot: string, type: string, id: string): RemoteUnlistedEntry {
  const list = loadRemoteUnlisted(projectRoot);
  const unlistedAt = new Date().toISOString();
  const existing = list.find(e => e.type === type && e.id === id);
  if (existing) existing.unlistedAt = unlistedAt;
  else list.push({ type, id, unlistedAt });
  writeJSON(remoteUnlistedFile(projectRoot), list);
  return { type, id, unlistedAt };
}

export function isRemoteUnlisted(projectRoot: string, type: string, id: string): boolean {
  return loadRemoteUnlisted(projectRoot).some(e => e.type === type && e.id === id);
}

// 供 communityRoutes.ts 的 computeRemote() 调用:过滤掉本地标了下架的条目;顺带兜底——如果远程
// JSON 本体已经带了 visibility:"unlisted"(比如 PR 已经被合并,内容被社区仓库那边改过),同样滤掉,
// 双重保险,不依赖哪一边一定先生效。
export function filterUnlistedRemoteEntries<T extends { type: string; id: string; visibility?: string }>(
  projectRoot: string, entries: T[],
): T[] {
  const unlisted = loadRemoteUnlisted(projectRoot);
  if (unlisted.length === 0) return entries.filter(e => e.visibility !== "unlisted");
  const key = (e: { type: string; id: string }) => `${e.type}:${e.id}`;
  const blocked = new Set(unlisted.map(key));
  return entries.filter(e => e.visibility !== "unlisted" && !blocked.has(key(e)));
}

// Favorites shelf — a per-content-type set of ids, persisted to .opc/community/favorites.json.
function favoritesFile(projectRoot: string) {
  return path.join(communityDir(projectRoot), "favorites.json");
}

export function loadFavorites(projectRoot: string): CommunityFavorites {
  const fav = readJSON<CommunityFavorites>(favoritesFile(projectRoot), { company: [], team: [], worker: [] });
  fav.company ??= []; fav.team ??= []; fav.worker ??= [];
  return fav;
}

// Toggle membership; returns the new favorited state.
export function toggleFavorite(projectRoot: string, type: CommunityContentType, id: string): boolean {
  const fav = loadFavorites(projectRoot);
  const list = fav[type];
  const i = list.indexOf(id);
  let favorited: boolean;
  if (i >= 0) { list.splice(i, 1); favorited = false; }
  else { list.push(id); favorited = true; }
  writeJSON(favoritesFile(projectRoot), fav);
  return favorited;
}

export function isFavorite(projectRoot: string, type: CommunityContentType, id: string): boolean {
  return loadFavorites(projectRoot)[type].includes(id);
}

// Rebuild
export function rebuildCommunityIndex(projectRoot: string) {
  ensureSeeded(projectRoot);
  const dir = communityDir(projectRoot);
  const templatesDir = path.join(dir, "templates");
  const teamsDir = path.join(dir, "teams");
  const agentsDir = path.join(dir, "agents");
  const promptsDir = path.join(dir, "prompts");

  const index: CommunityIndex = { templates: [], teams: [], agents: [], prompts: [] };

  if (fs.existsSync(templatesDir)) {
    for (const file of fs.readdirSync(templatesDir)) {
      if (!file.endsWith(".json")) continue;
      const t = JSON.parse(fs.readFileSync(path.join(templatesDir, file), "utf-8")) as CompanyTemplate;
      index.templates.push({
        id: t.id, title: t.title, author: t.author, authorGitHub: t.authorGitHub,
        tags: t.tags, downloads: t.downloads, stars: t.stars, createdAt: t.createdAt,
        agentCount: t.agents.length, license: t.license ?? "OPC-Original",
      });
    }
  }

  if (fs.existsSync(teamsDir)) {
    for (const file of fs.readdirSync(teamsDir)) {
      if (!file.endsWith(".json")) continue;
      const t = JSON.parse(fs.readFileSync(path.join(teamsDir, file), "utf-8")) as TeamTemplate;
      index.teams.push({
        id: t.id, title: t.title, author: t.author, authorGitHub: t.authorGitHub,
        tags: t.tags, downloads: t.downloads, stars: t.stars, createdAt: t.createdAt,
        agentCount: t.agents.length, license: t.license ?? "OPC-Original",
      });
    }
  }

  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith(".json")) continue;
      const a = JSON.parse(fs.readFileSync(path.join(agentsDir, file), "utf-8")) as AgentCard;
      index.agents.push({
        id: a.id, title: a.title, author: a.author, authorGitHub: a.authorGitHub,
        role: a.role, tags: a.tags, downloads: a.downloads, stars: a.stars, createdAt: a.createdAt,
        license: a.license ?? "OPC-Original",
        sourceUrl: a.sourceUrl,
      });
    }
  }

  if (fs.existsSync(promptsDir)) {
    for (const file of fs.readdirSync(promptsDir)) {
      if (!file.endsWith(".json")) continue;
      const p = JSON.parse(fs.readFileSync(path.join(promptsDir, file), "utf-8")) as PromptTemplate;
      index.prompts.push({
        id: p.id, title: p.name, author: p.author, authorGitHub: p.authorGitHub,
        tags: p.tags, downloads: p.downloads, stars: p.stars, createdAt: p.createdAt,
      });
    }
  }

  saveCommunityIndex(projectRoot, index);
  return index;
}
