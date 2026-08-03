import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderSkillMarkdown, SHARED_SKILLS } from "./catalog.js";

export interface SharedSkillsExportResult {
  schemaVersion: "1";
  outputPath: string;
  generatedAt: string;
  skills: Array<{ name: string; version: string; path: string; sha256: string }>;
}

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf-8").digest("hex");
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function assertSafeDestination(outputPath: string): string {
  if (!outputPath.trim() || outputPath.includes("\x00")) throw new Error("Invalid export destination");
  const resolved = path.resolve(outputPath);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  const cwd = path.resolve(process.cwd());
  if (samePath(resolved, root) || samePath(resolved, home) || samePath(resolved, cwd)) throw new Error("Refusing unsafe export destination");
  if (fs.existsSync(resolved)) throw new Error("Export destination already exists");
  return resolved;
}
function assertNoSymlinkAncestors(target: string): void {
  let current = path.dirname(target);
  const root = path.parse(current).root;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Refusing export through a symbolic-link directory");
    if (samePath(current, root)) break;
    current = path.dirname(current);
  }
}
function writeExclusive(filename: string, content: string): void {
  fs.writeFileSync(filename, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
}

export function exportSharedSkills(
  outputPath: string,
  options: { now?: () => string; createId?: () => string } = {},
): SharedSkillsExportResult {
  const destination = assertSafeDestination(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlinkAncestors(destination);
  const staging = path.join(path.dirname(destination), "." + path.basename(destination) + ".tmp-" + (options.createId ?? randomUUID)());
  if (fs.existsSync(staging)) throw new Error("Temporary export destination already exists");
  const generatedAt = (options.now ?? (() => new Date().toISOString()))();
  const exported: SharedSkillsExportResult["skills"] = [];
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    for (const skill of SHARED_SKILLS) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) throw new Error("Invalid Agent Skill name: " + skill.name);
      const directory = path.join(staging, skill.name);
      fs.mkdirSync(directory, { mode: 0o700 });
      const markdown = renderSkillMarkdown(skill);
      const manifest = {
        schemaVersion: "1",
        name: skill.name,
        version: skill.version,
        skillFile: "SKILL.md",
        mcpServer: "opc-studio",
        mcpTools: [...skill.mcpTools],
        dataPolicy: { includes: ["instructions"], excludes: ["memory", "credentials", "runtime-state"] },
      };
      writeExclusive(path.join(directory, "SKILL.md"), markdown);
      writeExclusive(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      exported.push({ name: skill.name, version: skill.version, path: skill.name + "/SKILL.md", sha256: sha256(markdown) });
    }
    const result: SharedSkillsExportResult = { schemaVersion: "1", outputPath: destination, generatedAt, skills: exported };
    writeExclusive(path.join(staging, "manifest.json"), JSON.stringify({
      schemaVersion: result.schemaVersion,
      generatedAt: result.generatedAt,
      format: "agent-skills",
      skills: result.skills,
      dataPolicy: { includes: ["instructions"], excludes: ["memory", "credentials", "runtime-state"] },
    }, null, 2) + "\n");
    fs.renameSync(staging, destination);
    return result;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
