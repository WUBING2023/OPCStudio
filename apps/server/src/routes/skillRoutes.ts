import type { Express } from "express";
import { v4 as uuid } from "uuid";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  listSkills, getSkill, createSkill, updateSkill, deleteSkill, toggleSkill, skillsDir,
} from "../storage/skillStore.js";
import { loadConfig } from "../storage/projectStore.js";
import { randomUUID } from "node:crypto";
import { getAgents, addAgents } from "../runtime/orchestrator.js";
import { workerFromSkill, isValidAttachParent } from "../runtime/install.js";
import { isSensitive } from "./fileRoutes.js";
import { safeFetch, fetchTextWithLimit, resolvePathInAllowedRoots } from "../security/localGuards.js";
import { loadCompanies } from "../storage/companyStore.js";
import { invokeSystemModel } from "../runtime/systemModelInvoke.js";
import { saveTemplate } from "../storage/communityStore.js";
import { CompanyTemplateSchema } from "@opc/shared";
import { resolveGithubToken } from "../storage/githubTokenStore.js";
import { normalizeIncubatorDesign } from "./incubatorDesign.js";
import { resolveAdaptiveModelBinding, type RequestedModelBinding } from "../runtime/adaptiveModelBinding.js";
import {
  discoverLocalSkills, isLocalSkillInstalled, localSkillSlug,
} from "../runtime/localSkillDiscovery.js";

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
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

function isUrl(str: string): boolean {
  return /^https?:\/\//.test(str);
}

const MAX_SKILL_BYTES = 256 * 1024;

function assertSkillContentSize(content: string) {
  if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_BYTES) throw new Error("skill content is too large");
}

function companyWorkspaceRoots(projectRoot: string): string[] {
  try { return loadCompanies(projectRoot).map((c) => c.folder).filter((f): f is string => !!f && !!f.trim()); }
  catch { return []; }
}

// GitHub URL 智能解析(用户实测:贴仓库主页 URL 导入失败——之前把 GitHub 网页 HTML 当 markdown 抓)。
// 认四种形态:仓库根 / tree 目录 / blob 文件 / raw 直链;仓库与目录用 git trees API 递归找 SKILL.md
// (Claude 技能仓库惯例),找不到兜底 README.md(如实标注来源)。带 token 走认证(匿名限流 60/h)。
function ghAuthHeaders(projectRoot: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "OPC-Studio" };
  try {
    const t = resolveGithubToken(projectRoot, loadConfig(projectRoot).github?.oauth?.accessToken);
    if (t) h.Authorization = `Bearer ${t}`;
  } catch { /* 无 token 匿名走 */ }
  return h;
}

async function resolveFromGitHub(source: string, projectRoot: string): Promise<Array<{ content: string; filename: string }>> {
  const u = new URL(source);
  // raw 直链:原样抓
  if (u.hostname === "raw.githubusercontent.com") {
    const content = await fetchTextWithLimit(source, { signal: AbortSignal.timeout(15000) }, { maxBytes: MAX_SKILL_BYTES });
    return [{ content, filename: path.basename(u.pathname) || "imported-skill.md" }];
  }
  const seg = u.pathname.split("/").filter(Boolean);
  const [owner, repo] = seg;
  if (!owner || !repo) throw new Error("无法识别的 GitHub 地址");
  // blob 文件:换算 raw
  if (seg[2] === "blob" && seg.length >= 5) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${seg.slice(3).join("/")}`;
    const content = await fetchTextWithLimit(rawUrl, { signal: AbortSignal.timeout(15000) }, { maxBytes: MAX_SKILL_BYTES });
    return [{ content, filename: path.basename(u.pathname) }];
  }
  // 仓库根 / tree 目录:trees API 递归列文件
  const headers = ghAuthHeaders(projectRoot);
  const branchGuess = seg[2] === "tree" && seg[3] ? seg[3] : undefined;
  const subDir = seg[2] === "tree" && seg.length > 4 ? seg.slice(4).join("/") + "/" : "";
  const branches = branchGuess ? [branchGuess] : ["main", "master"];
  for (const br of branches) {
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${br}?recursive=1`;
    const tr = await safeFetch(treeUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (tr.status === 403) throw new Error("GitHub API 限流:请在 设置→GitHub 登录后重试,或直接贴 raw.githubusercontent.com 的 .md 链接");
    if (!tr.ok) continue;
    const tree = ((await tr.json()) as { tree?: Array<{ path: string; type: string }> }).tree ?? [];
    const files = tree.filter(t => t.type === "blob" && t.path.startsWith(subDir));
    // 优先级:SKILL.md(任意深度,Claude 技能惯例)> skill*.md > README.md
    const skillMds = files.filter(f => /(^|\/)SKILL\.md$/i.test(f.path)).slice(0, 10);
    const picks = skillMds.length ? skillMds
      : files.filter(f => /skill.*\.md$/i.test(f.path)).slice(0, 3).length
        ? files.filter(f => /skill.*\.md$/i.test(f.path)).slice(0, 3)
        : files.filter(f => /(^|\/)README\.md$/i.test(f.path)).slice(0, 1);
    if (!picks.length) throw new Error("仓库里没找到 SKILL.md / README.md——请直接贴 .md 文件链接");
    const out: Array<{ content: string; filename: string }> = [];
    for (const p of picks) {
      const rawFileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${p.path}`;
      try {
        const content = await fetchTextWithLimit(rawFileUrl, { signal: AbortSignal.timeout(15000) }, { maxBytes: MAX_SKILL_BYTES });
        // SKILL.md 用所在目录名当文件名(Claude 技能仓库里全都叫 SKILL.md,直接用会互相覆盖)
        const dir = path.dirname(p.path);
        const base = /SKILL\.md$/i.test(p.path) && dir !== "." ? `${path.basename(dir)}.md` : (path.basename(p.path) === "README.md" ? `${repo}.md` : path.basename(p.path));
        out.push({ content, filename: base });
      } catch { /* skip failed oversized/unreachable file */ }
    }
    if (out.length) return out;
  }
  throw new Error("仓库分支/文件抓取失败——请确认仓库公开,或直接贴 raw 链接");
}

async function fetchContent(source: string, projectRoot?: string): Promise<{ content: string; filename: string }> {
  const all = await fetchContents(source, projectRoot);
  return all[0];
}

async function fetchContents(source: string, projectRoot?: string): Promise<Array<{ content: string; filename: string }>> {
  if (isUrl(source)) {
    const u = new URL(source);
    if ((u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com") && projectRoot) {
      return resolveFromGitHub(source, projectRoot);
    }
    const content = await fetchTextWithLimit(source, { signal: AbortSignal.timeout(15000) }, { maxBytes: MAX_SKILL_BYTES });
    // HTML 嗅探:抓回网页就诚实报错,别把 <!DOCTYPE html> 存成"技能"
    if (/^\s*(<!doctype|<html)/i.test(content)) throw new Error("这个链接返回的是网页而不是 markdown——请贴 .md 文件的 raw 链接,或 GitHub 仓库地址(会自动找 SKILL.md)");
    const urlPath = new URL(source).pathname;
    const filename = path.basename(urlPath) || "imported-skill.md";
    return [{ content, filename }];
  } else {
    // 安全:source 是调用方任给的本地路径(preview/import 均走这)——不拦会把 keys/.env/github_oauth.json
    // 等凭证内容当"技能预览"读出来回传。复用 fileRoutes 同款敏感名单/目录拦截。
    const abs = resolvePathInAllowedRoots(projectRoot ?? process.cwd(), source, projectRoot ? companyWorkspaceRoots(projectRoot) : []);
    if (isSensitive(abs)) throw new Error("access denied: sensitive file");
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${source}`);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error("source is not a file");
    if (st.size > MAX_SKILL_BYTES) throw new Error("skill content is too large");
    const content = fs.readFileSync(abs, "utf-8");
    assertSkillContentSize(content);
    const filename = path.basename(abs);
    return [{ content, filename }];
  }
}

export function register(app: Express, projectRoot: string) {

  const withCompanyOwnership = <T extends { role: string; origin?: string; companyId?: string }>(skills: T[]): T[] => {
    const agents = getAgents();
    return skills.map((skill) => {
      if (skill.companyId || (skill.origin !== "persona" && skill.origin !== "bundled")) return skill;
      const companyIds = new Set(
        agents.filter((agent) => agent.role === skill.role).map((agent) => agent.companyId || "default"),
      );
      return companyIds.size === 1 ? { ...skill, companyId: [...companyIds][0] } : skill;
    });
  };

  app.get("/api/skills", (req, res) => {
    const origin = req.query.origin;
    const validOrigin = origin === "user" || origin === "persona" || origin === "memory" || origin === "bundled" ? origin : undefined;
    // Skill 页面只呈现真正可执行/可复用的用户 Skill。persona 已迁到 agent.systemPrompt,
    // memory 归 Memory Registry,bundled 仅供公司模板内部按显式 origin 查询。
    if (validOrigin === "persona" || validOrigin === "memory") return res.json([]);
    const skills = listSkills(projectRoot, { origin: validOrigin ?? "user" });
    res.json(withCompanyOwnership(skills));
  });

  app.get("/api/skills/path", (_req, res) => {
    res.json({ path: skillsDir(projectRoot) });
  });

  app.get("/api/skills/local", (_req, res) => {
    const installed = listSkills(projectRoot, { origin: "user" })
      .map((meta) => getSkill(projectRoot, meta.id))
      .filter((skill): skill is NonNullable<typeof skill> => !!skill);
    const candidates = discoverLocalSkills(projectRoot).map(({ content, ...candidate }) => ({
      ...candidate,
      installed: isLocalSkillInstalled({ ...candidate, content }, installed),
    }));
    res.json(candidates);
  });

  app.post("/api/skills/local/:id/import", (req, res) => {
    try {
      const candidates = discoverLocalSkills(projectRoot);
      const candidate = candidates.find((item) => item.id === req.params.id);
      if (!candidate) return res.status(404).json({ error: "local skill not found" });
      const installed = listSkills(projectRoot, { origin: "user" })
        .map((meta) => getSkill(projectRoot, meta.id))
        .filter((skill): skill is NonNullable<typeof skill> => !!skill);
      const duplicate = installed.find((skill) => isLocalSkillInstalled(candidate, [skill]));
      if (duplicate) return res.json({ skill: duplicate, duplicate: true });

      const baseId = localSkillSlug(candidate);
      let id = baseId;
      if (getSkill(projectRoot, id)) id = `${baseId.slice(0, 60)}-${candidate.id.slice(0, 8)}`;
      const skill = createSkill(projectRoot, {
        id,
        title: candidate.name,
        description: candidate.description,
        role: candidate.role,
        enabled: true,
        lastModified: new Date().toISOString(),
        content: candidate.content,
        origin: "user",
      });
      res.status(201).json({ skill, duplicate: false });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });
  app.get("/api/skills/:id", (req, res) => {
    try {
      const skill = getSkill(projectRoot, req.params.id);
      if (!skill || skill.origin === "persona" || skill.origin === "memory") {
        res.status(404).json({ error: "skill not found" });
        return;
      }
      res.json(skill);
    } catch (e: any) {
      // 排查"查看功能失效"时发现:这里之前没有 try/catch,单个技能文件 frontmatter 损坏会让请求
      // 以非预期方式失败,前端又静默吞错——用户看到的就是"点了没反应"。至少给个干净的 500。
      res.status(500).json({ error: e?.message || "读取技能失败" });
    }
  });

  app.post("/api/skills", (req, res) => {
    try {
      const { title, role, enabled, content } = req.body;
      const skill = createSkill(projectRoot, {
        id: uuid(),
        title: title || "Untitled",
        role: role || "dev",
        enabled: enabled !== false,
        lastModified: new Date().toISOString(),
        content: content || "",
        origin: "user",
      });
      res.status(201).json(skill);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/skills/preview", async (req, res) => {
    try {
      const { source } = req.body;
      if (!source || typeof source !== "string") {
        res.status(400).json({ error: "source is required" });
        return;
      }

      const all = await fetchContents(source, projectRoot);
      const { content } = all[0];
      res.json({ content: content.slice(0, 5000), preview: content.slice(0, 2000), fileCount: all.length, files: all.map(f => f.filename) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/skills/import", async (req, res) => {
    try {
      const { source, url, filePath: srcPath } = req.body;
      const inputSource = source || url || srcPath;
      if (!inputSource) {
        res.status(400).json({ error: "source, url, or filePath required" });
        return;
      }

      // 多技能导入:仓库 URL 可能带出多个 SKILL.md(Claude 技能仓库),逐个落盘。
      const items = await fetchContents(inputSource, projectRoot);
      const imported: any[] = [];
      const seenIds = new Set<string>();
      for (const { content, filename } of items) {
        assertSkillContentSize(content);
        const { meta, body } = parseFrontmatter(content);
        // Claude 技能 frontmatter 用 name 字段——一并认。
        const id = (meta.id || filename.replace(/\.md$/, "")).replace(/[^a-zA-Z0-9_一-鿿.-]/g, "-").slice(0, 80);
        const title = meta.title || meta.name || id;
        const role = meta.role || "dev";
        const enabled = meta.enabled !== "false";
        if (seenIds.has(id) || getSkill(projectRoot, id)) throw new Error(`skill id already exists: ${id}`);
        seenIds.add(id);

        const dir = skillsDir(projectRoot);
        const filepath = path.join(dir, `${id}.md`);

        const frontmatter = ["---"];
        frontmatter.push(`title: ${title}`);
        frontmatter.push(`role: ${role}`);
        frontmatter.push(`enabled: ${enabled ? "true" : "false"}`);
        // 用户主动发起的导入(GitHub/URL/本地文件)→ 真实用户资产,打 user 标记。
        frontmatter.push("origin: user");
        frontmatter.push("---");

        fs.writeFileSync(filepath, frontmatter.join("\n") + "\n" + (body || content), "utf-8");
        const skill = getSkill(projectRoot, id);
        if (skill) imported.push(skill);
      }
      if (!imported.length) return res.status(400).json({ error: "没有可导入的内容" });
      // 兼容旧前端(期待单个 skill 对象):首个 + 附带全量清单
      res.status(201).json({ ...imported[0], importedCount: imported.length, imported: imported.map(s => ({ id: s.id, title: s.title })) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch("/api/skills/:id", (req, res) => {
    try {
      const updated = updateSkill(projectRoot, req.params.id, req.body);
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/skills/:id", (req, res) => {
    const ok = deleteSkill(projectRoot, req.params.id);
    if (!ok) { res.status(404).json({ error: "skill not found" }); return; }
    res.json({ ok: true });
  });

  app.post("/api/skills/:id/toggle", (req, res) => {
    const result = toggleSkill(projectRoot, req.params.id);
    if (!result) { res.status(404).json({ error: "skill not found" }); return; }
    res.json(result);
  });

  // ⚠️ 已删除 /api/skills/:id/install-as-worker(裸导入原文当人设的旧"导入为员工"入口)——
  // 用户原话:"可以把导入员工的功能给删除掉了"。孵化器的"一名员工"档已完整覆盖这个需求且质量更高
  // (LLM 真实设计人设,不是把技能原文整段塞给 worker)。前端唯一消费方(SkillsPage.tsx 的
  // handleInstallAsWorker/installSkill)已同步删除,确认无其他调用方后端点本体一并删除。

  // ── Skill 孵化器(用户指令,Fable 亲自操刀):把一个技能孵化成"一名员工"/"一支专家小组"/"一支完整团队"。
  // 消耗用户自己的 tokens:真实调用 LLM 读技能全文做设计;诚实返回本次生成的 token/费用。
  // 两段式:①/incubate 生成设计稿(前端预览/可改名)→ ②/incubate/install 落地
  // (worker→挂到指定 lead;squad→2-4 名纯 worker 直接挂到指定 lead;team→存本地模板库;
  //  孵化得到的人设直接写入 agent.systemPrompt,之后一键建司/分享走既有全链)。
  // 命名策略(用户原话:"不需要人物化的命名"):一律用职能角色描述命名,禁止编造人名。
  const NAMING_RULE = "命名策略:name 字段必须是职能角色描述(如\"CRUD 工程师\"\"API 稳健性专家\"\"事实核查员\"),不要编造中文人名或任何人名。";
  app.post("/api/skills/:id/incubate", async (req, res) => {
    try {
      const skill = getSkill(projectRoot, req.params.id);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      const reqMode = req.body?.mode;
      const mode = reqMode === "team" ? "team" : reqMode === "squad" ? "squad" : "worker";

      const skillText = skill.content.slice(0, 5000);
      const prompt = mode === "worker"
        ? `你是资深组织设计师。请基于下面这份技能文档,设计一名专精该技能的 AI 员工。
技能《${skill.title}》全文:
${skillText}

${NAMING_RULE}
只输出一个 JSON 对象:
{"name": "职能角色描述(4-10字,例如"CRUD 工程师"/"API 稳健性专家"/"事实核查员")", "roleLabel": "岗位名(2-6字)", "persona": "该员工的系统提示词(500-900字:身份、专长=此技能的方法论内核、工作准则、输出规范。把技能文档的精华内化进去,而不是复述)"}`
        : mode === "squad"
        ? `你是资深组织设计师。请基于下面这份技能文档,设计一支 2-4 人的专家小组(只要具体干活的成员,不要 CEO/主管,他们会被直接编入用户已有的团队)。
技能《${skill.title}》全文:
${skillText}

${NAMING_RULE}
只输出一个 JSON 对象:
{"squadName": "小组名(中文,4-10字)", "description": "一句话描述这支专家小组解决什么问题", "members": [{"id": "唯一英文短标识", "name": "职能角色描述", "role": "dev|test|security|ops|docs|pm 之一(不要用 ceo/lead)", "persona": "该成员系统提示词(300-600字,与技能分工呼应)"}](2-4 个成员)}`
        : `你是资深组织设计师。请基于下面这份技能文档,设计一支围绕该技能作业的完整 AI 团队(CEO+1名Lead+3-5名worker)。
技能《${skill.title}》全文:
${skillText}

${NAMING_RULE}
只输出一个 JSON 对象:
{"teamName": "团队名(中文,4-10字)", "description": "一句话描述这支团队解决什么问题", "members": [{"id": "唯一英文短标识", "name": "职能角色描述", "role": "ceo|lead|dev|test|security|ops|docs|pm 之一(必须恰好1个ceo和1个lead)", "persona": "该成员系统提示词(300-600字,与技能分工呼应)"}], "verificationEdges": [{"producerId": "被验收成员id", "verifierId": "独立验收成员id", "method": "llm-review|code-review|fact-check"}](0-3条,必须用成员id,只在有意义时给)}`;

      const record = await invokeSystemModel(projectRoot, "creative", {
        agentId: "skill-incubator",
        messages: [{ role: "user", content: prompt }], maxTokens: 2400, agentRole: "advisor",
      });
      const raw = (record.content ?? "").replace(/^\s*DIRECT_ANSWER:\s*/, "");
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(400).json({ error: "孵化输出无法解析", raw: raw.slice(0, 300) });
      let design: any;
      try { design = JSON.parse(m[0]); } catch { return res.status(400).json({ error: "孵化输出 JSON 解析失败", raw: raw.slice(0, 300) }); }
      design = normalizeIncubatorDesign(mode, design);
      // 孵化设计本身已经通过一个真实可用的系统模型完成。落地时沿用同一套可用性解析，
      // 绝不再把员工无条件绑到 DeepSeek，避免“设计成功、员工创建后却无法执行”。
      const binding = await resolveAdaptiveModelBinding(projectRoot);
      // 诚实计量:这次孵化花了用户多少
      res.json({
        mode, design,
        binding: { ...binding.choice, source: binding.source, substituted: binding.substituted, reason: binding.reason },
        usage: { tokens: record.totalTokens, costUsd: record.estimatedCostUsd ?? 0 },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/skills/:id/incubate/install", async (req, res) => {
    try {
      const skill = getSkill(projectRoot, req.params.id);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      const { mode, design, parentId } = req.body ?? {};
      const requestedBinding = req.body?.binding && typeof req.body.binding === "object"
        ? req.body.binding as RequestedModelBinding
        : undefined;
      // 客户端只回传“偏好”，服务端重新按真实 key/订阅状态解析。若安装期间能力已经失效，
      // 这里明确失败，不创建 enabled=true 但必然 restricted 的员工。
      const resolvedBinding = await resolveAdaptiveModelBinding(projectRoot, requestedBinding);
      const executionBinding = resolvedBinding.choice;

      if (mode === "worker") {
        const parent = getAgents().find(a => a.id === parentId);
        if (!parent) return res.status(400).json({ error: "parent agent not found" });
        if (!isValidAttachParent(parent.role)) return res.status(400).json({ error: "员工只能挂到 CEO 或 Lead 下" });
        const companyId = parent.companyId || "default";
        const role = `inc-${skill.id}`.slice(0, 60);
        const newId = `${role}-${randomUUID().slice(0, 6)}`;
        const persona = String(design?.persona || skill.content).slice(0, 4000);
        const node = workerFromSkill({ ...skill, title: String(design?.name || skill.title).slice(0, 40), content: persona }, parentId, companyId, newId, role);
        node.framework = executionBinding.framework;
        node.provider = executionBinding.provider;
        node.model = executionBinding.model;
        addAgents([node]);
        return res.json({
          installed: "worker", agentId: newId, companyId, name: node.name,
          binding: { ...executionBinding, source: resolvedBinding.source, substituted: resolvedBinding.substituted },
        });
      }

      // squad(专家小组,默认推荐档):2-4 名纯 worker,不含 CEO/lead,直接挂到用户指定的 parentId 下
      // (复用 worker 档的 parentId 选择流程)。
      if (mode === "squad") {
        const parent = getAgents().find(a => a.id === parentId);
        if (!parent) return res.status(400).json({ error: "parent agent not found" });
        if (!isValidAttachParent(parent.role)) return res.status(400).json({ error: "专家小组只能挂到 CEO 或 Lead 下" });
        const companyId = parent.companyId || "default";
        const rawMembers: Array<{ name?: string; role?: string; persona?: string }> = Array.isArray(design?.members) ? design.members : [];
        const members = rawMembers.filter(mb => mb.role !== "ceo" && mb.role !== "lead").slice(0, 4);
        if (members.length < 2) return res.status(400).json({ error: "设计稿至少需要 2 名成员才能成组" });
        const tplId = `inc-${skill.id}-sq-${randomUUID().slice(0, 4)}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60);
        const now = new Date().toISOString();
        const installed: Array<{ agentId: string; name: string; role: string }> = [];
        const nodes = members.map((mb, i) => {
          const role = `${tplId}-w${i + 1}`;
          const newId = `${role}-${randomUUID().slice(0, 6)}`;
          const persona = String(mb.persona || skill.content).slice(0, 4000);
          const node = workerFromSkill({ ...skill, title: String(mb.name || skill.title).slice(0, 40), content: persona }, parentId, companyId, newId, role);
          node.framework = executionBinding.framework;
          node.provider = executionBinding.provider;
          node.model = executionBinding.model;
          installed.push({ agentId: newId, name: node.name, role });
          return node;
        });
        addAgents(nodes);
        return res.json({
          installed: "squad", companyId, members: installed,
          squadName: String(design?.squadName || `${skill.title}专家小组`),
          binding: { ...executionBinding, source: resolvedBinding.source, substituted: resolvedBinding.substituted },
        });
      }

      if (mode === "team") {
        const members: Array<{ id?: string; name?: string; role?: string; persona?: string; reportsToId?: string }> = Array.isArray(design?.members) ? design.members : [];
        if (!members.some(mb => mb.role === "ceo")) return res.status(400).json({ error: "设计稿缺 CEO,无法成团" });
        const tplId = `inc-${skill.id}-${randomUUID().slice(0, 4)}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60);
        const ceoM = members.find(mb => mb.role === "ceo")!;
        const leadM = members.find(mb => mb.role === "lead");
        const now = new Date().toISOString();
        const mkNode = (mb: { id?: string; name?: string; role?: string; persona?: string }, id: string, parent?: string, scopedRole?: string) => ({
          id, name: String(mb.name || mb.role || "成员").slice(0, 40), role: scopedRole ?? String(mb.role || "dev"),
          systemPrompt: String(mb.persona || "").slice(0, 4000) || undefined,
          parentId: parent, childrenIds: [] as string[],
          model: executionBinding.model, provider: executionBinding.provider, framework: executionBinding.framework,
          status: "idle" as const, tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, editable: true, enabled: true, deletable: true,
        });
        const ceoNode = mkNode(ceoM, String(ceoM.id || "ceo"));
        const leadNode = leadM ? mkNode(leadM, String(leadM.id || "lead"), ceoNode.id) : undefined;
        const workers = members.filter(mb => mb !== ceoM && mb !== leadM).slice(0, 6)
          .map((mb, i) => mkNode(mb, String(mb.id || `worker-${i + 1}`), leadNode?.id ?? ceoNode.id, `wk-${tplId}-w${i + 1}`));
        ceoNode.childrenIds = leadNode ? [leadNode.id] : workers.map(w => w.id);
        if (leadNode) leadNode.childrenIds = workers.map(w => w.id);
        const agents = [ceoNode, ...(leadNode ? [leadNode] : []), ...workers];
        const nodeByMemberId = new Map<string, (typeof agents)[number]>();
        for (const member of members) {
          const node = agents.find((agent) => agent.id === member.id);
          if (member.id && node) nodeByMemberId.set(member.id, node);
        }
        // 验证边以孵化稿中的稳定 member id 绑定，多个 dev/test 不再按角色名误连到第一人。
        const edges = (Array.isArray(design?.verificationEdges) ? design.verificationEdges : [])
          .map((edge: any) => {
            const producer = nodeByMemberId.get(String(edge?.producerId || ""));
            const verifier = nodeByMemberId.get(String(edge?.verifierId || ""));
            const method = ["llm-review", "code-review", "fact-check"].includes(edge?.method) ? edge.method : "llm-review";
            return producer && verifier && producer.id !== verifier.id
              ? { producer: producer.role, verifier: verifier.role, method, onReject: "redo" as const }
              : null;
          })
          .filter(Boolean).slice(0, 3);
        const template = {
          id: tplId, title: String(design?.teamName || `${skill.title}团队`).slice(0, 60),
          description: String(design?.description || `围绕技能「${skill.title}」作业的团队`).slice(0, 200),
          author: "skill-incubator", createdAt: now, tags: ["incubated", "skill"], downloads: 0, stars: 0,
          readme: `# ${String(design?.teamName || skill.title)}

由技能「${skill.title}」孵化的团队。

${String(design?.description || "")}`,
          agents,
          workflow: edges.length ? { verificationEdges: edges } : undefined,
          bundledSkills: [{ name: skill.title, description: `孵化来源技能`, content: skill.content.slice(0, 20000) }],
        };
        const parsed = CompanyTemplateSchema.safeParse(template);
        if (!parsed.success) return res.status(400).json({ error: "生成的模板未过校验: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ") });
        saveTemplate(projectRoot, parsed.data as any);
        return res.json({
          installed: "template", templateId: tplId, title: template.title, memberCount: agents.length,
          binding: { ...executionBinding, source: resolvedBinding.source, substituted: resolvedBinding.substituted },
        });
      }

      return res.status(400).json({ error: "mode 必须是 worker、squad 或 team" });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
}
