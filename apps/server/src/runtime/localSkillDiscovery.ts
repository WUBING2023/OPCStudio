import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Skill } from "@opc/shared";

export type LocalSkillSource = "codex" | "claude-code" | "agent";
export type LocalSkillScope = "user" | "project";

export interface LocalSkillRoot {
  source: LocalSkillSource;
  scope: LocalSkillScope;
  root: string;
}

export interface LocalSkillCandidate {
  id: string;
  name: string;
  description?: string;
  role: string;
  source: LocalSkillSource;
  scope: LocalSkillScope;
  relativePath: string;
  modifiedAt: string;
  contentHash: string;
  content: string;
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 5;
const MAX_CANDIDATES = 200;
const SKIPPED_DIRS = new Set([".git", ".system", "node_modules", "cache", "backup", "backups"]);

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

export function defaultLocalSkillRoots(projectRoot: string): LocalSkillRoot[] {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  return [
    { source: "codex", scope: "user", root: path.join(codexHome, "skills") },
    { source: "claude-code", scope: "user", root: path.join(claudeHome, "skills") },
    { source: "agent", scope: "user", root: path.join(home, ".agents", "skills") },
    { source: "codex", scope: "project", root: path.join(projectRoot, ".codex", "skills") },
    { source: "claude-code", scope: "project", root: path.join(projectRoot, ".claude", "skills") },
    { source: "agent", scope: "project", root: path.join(projectRoot, ".agents", "skills") },
  ];
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: normalized };
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { meta: {}, body: normalized };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end + 1)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: lines.slice(end + 2).join("\n").trim() };
}

function summarize(body: string): string | undefined {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  return paragraph?.slice(0, 180);
}

function hashText(content: string): string {
  return createHash("sha256").update(content.trim(), "utf8").digest("hex");
}

function candidateId(filepath: string): string {
  return createHash("sha256").update(path.resolve(filepath).toLowerCase(), "utf8").digest("hex").slice(0, 24);
}

function scanRoot(spec: LocalSkillRoot, out: LocalSkillCandidate[]): void {
  const root = normalizeRoot(spec.root);
  if (!fs.existsSync(root)) return;
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_CANDIDATES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_CANDIDATES) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== "skill.md") continue;
      let stat: fs.Stats;
      let raw: string;
      try {
        stat = fs.statSync(full);
        if (stat.size <= 0 || stat.size > MAX_SKILL_BYTES) continue;
        raw = fs.readFileSync(full, "utf8");
      } catch { continue; }
      const { meta, body } = parseFrontmatter(raw);
      if (!body.trim()) continue;
      const relativePath = path.relative(root, full).split(path.sep).join("/");
      out.push({
        id: candidateId(full),
        name: meta.name || meta.title || path.basename(path.dirname(full)),
        description: meta.description || summarize(body),
        role: meta.role || "dev",
        source: spec.source,
        scope: spec.scope,
        relativePath,
        modifiedAt: stat.mtime.toISOString(),
        contentHash: hashText(body),
        content: body,
      });
    }
  };
  visit(root, 0);
}

export function discoverLocalSkills(
  projectRoot: string,
  roots: LocalSkillRoot[] = defaultLocalSkillRoots(projectRoot),
): LocalSkillCandidate[] {
  const seenRoots = new Set<string>();
  const seenFiles = new Set<string>();
  const candidates: LocalSkillCandidate[] = [];
  for (const spec of roots) {
    const normalized = normalizeRoot(spec.root).toLowerCase();
    if (seenRoots.has(normalized)) continue;
    seenRoots.add(normalized);
    const start = candidates.length;
    scanRoot(spec, candidates);
    for (let i = start; i < candidates.length; i += 1) {
      if (seenFiles.has(candidates[i].id)) {
        candidates.splice(i, 1);
        i -= 1;
      } else {
        seenFiles.add(candidates[i].id);
      }
    }
  }
  return candidates.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

export function isLocalSkillInstalled(candidate: LocalSkillCandidate, installed: Skill[]): boolean {
  return installed.some((skill) => hashText(skill.content) === candidate.contentHash);
}

export function localSkillSlug(candidate: LocalSkillCandidate): string {
  const base = candidate.name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || `local-${candidate.id.slice(0, 8)}`;
}
