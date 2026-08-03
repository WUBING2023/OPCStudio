import * as path from "node:path";
import * as fs from "node:fs";

let projectRoot = process.cwd();

export function getProjectRoot(): string {
  return projectRoot;
}
export function setProjectRoot(root: string) {
  projectRoot = path.resolve(root);
}

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertSafePathSyntax(target: string): void {
  if (target.includes("\0")) throw new Error("Access denied: path contains a null byte");
  if (process.platform !== "win32") return;
  const normalized = target.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) throw new Error(`Access denied: UNC or device path is not allowed: ${target}`);
  const withoutDrive = /^[a-z]:/i.test(normalized) ? normalized.slice(2) : normalized;
  const segments = withoutDrive.split("\\").filter(Boolean);
  if (segments.some((segment) => segment.includes(":"))) {
    throw new Error(`Access denied: alternate data stream path is not allowed: ${target}`);
  }
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) {
    throw new Error(`Access denied: Windows device name is not allowed: ${target}`);
  }
}

function rejectMultiLinkedFile(target: string, displayPath: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isFile() && stat.nlink > 1) {
    throw new Error(`Access denied: file has multiple hard links: ${displayPath}`);
  }
}

function isInside(root: string, target: string): boolean {
  const base = comparable(root);
  const candidate = comparable(target);
  return candidate === base || candidate.startsWith(base + path.sep);
}

function canonicalRoot(root: string): string {
  try { return fs.realpathSync(path.resolve(root)); }
  catch { throw new Error(`Access denied: project root does not exist: ${root}`); }
}

/** Resolve an existing path and verify its canonical target remains under root. */
export function resolveSafeRead(target: string, root: string = projectRoot): string {
  assertSafePathSyntax(target);
  const base = canonicalRoot(root);
  const lexical = path.resolve(base, target);
  if (!isInside(base, lexical)) throw new Error(`Access denied: ${target} is outside project root`);
  let real: string;
  try { real = fs.realpathSync(lexical); }
  catch { throw new Error(`Access denied: path does not exist: ${target}`); }
  if (!isInside(base, real)) throw new Error(`Access denied: ${target} resolves outside project root`);
  rejectMultiLinkedFile(real, target);
  return real;
}

/** Resolve a mutation target while rejecting every symlink/junction component. */
export function resolveSafeWrite(target: string, root: string = projectRoot): string {
  assertSafePathSyntax(target);
  const base = canonicalRoot(root);
  const lexical = path.resolve(base, target);
  if (!isInside(base, lexical)) throw new Error(`Access denied: ${target} is outside project root`);
  const rel = path.relative(base, lexical);
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = base;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Access denied: mutation path crosses a symlink or junction: ${target}`);
    if (stat.isFile() && stat.nlink > 1) throw new Error(`Access denied: mutation target has multiple hard links: ${target}`);
    if (!isInside(base, fs.realpathSync(cursor))) throw new Error(`Access denied: ${target} resolves outside project root`);
  }
  let parent = path.dirname(lexical);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`Access denied: no existing parent for ${target}`);
    parent = next;
  }
  if (!isInside(base, fs.realpathSync(parent))) throw new Error(`Access denied: ${target} resolves outside project root`);
  return lexical;
}

// All guards take an optional `root`; omitting it uses the global projectRoot (back-compat).
// Passing an explicit root lets concurrent workers confine to their own worktree without a
// shared mutable global — the sandbox check (must stay under root) is preserved per call.
export function isPathSafe(target: string, root: string = projectRoot): boolean {
  const base = path.resolve(root);
  // path.resolve 已规整,结果几乎不含 ".." → 旧的 includes("..") 分支恒 false、恒返回 true(失效)。
  // 直接判断:解析后必须等于 root 或在 root/ 之下(base+sep 防 "project-evil" 前缀碰撞)。
  const resolved = path.resolve(base, target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function resolveSafe(target: string, root: string = projectRoot): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, target);
  // base+sep 防前缀碰撞:/root/project-evil 不应被 /root/project 放行。
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Access denied: ${target} is outside project root`);
  }
  return resolved;
}

export function readFile(relativePath: string, root?: string): string {
  const p = resolveSafeRead(relativePath, root);
  return fs.readFileSync(p, "utf-8");
}

export function writeFile(relativePath: string, content: string, root?: string): void {
  const p = resolveSafeWrite(relativePath, root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

// 删除是显式文件能力，不借 shell 拼命令。仅允许当前工作根内的普通文件/符号链接；
// 不递归删目录，也不允许碰 OPC/Git 元数据或常见凭据文件。
export function deleteFile(relativePath: string, root?: string): void {
  const base = canonicalRoot(root ?? projectRoot);
  const p = resolveSafeRead(relativePath, base);
  const rel = path.relative(base, p).split(path.sep).join("/");
  if (!rel || rel === ".") throw new Error("Refusing to delete the working directory root");
  if (/(^|\/)(?:\.git|\.opc)(?:\/|$)/i.test(rel)) throw new Error(`Protected path cannot be deleted: ${relativePath}`);
  const name = path.basename(p).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || /^(?:id_rsa|id_ed25519|credentials)$/i.test(name)) {
    throw new Error(`Credential file cannot be deleted: ${relativePath}`);
  }
  const stat = fs.lstatSync(p);
  if (stat.isDirectory()) throw new Error("Directory deletion is not supported; delete files individually");
  fs.unlinkSync(p);
}

export function listFiles(relativePath: string, root?: string): string[] {
  const p = resolveSafeRead(relativePath, root);
  return fs.readdirSync(p);
}

export function getProjectTree(relativePath: string = ".", root?: string): string {
  const p = resolveSafeRead(relativePath, root);
  const result: string[] = [];
  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.filter(e => !e.name.startsWith(".") && e.name !== "node_modules").forEach((e, i, arr) => {
      const isLast = i === arr.length - 1;
      result.push(`${prefix}${isLast ? "└── " : "├── "}${e.name}`);
      if (e.isSymbolicLink()) return;
      if (e.isDirectory()) walk(resolveSafeRead(path.join(dir, e.name), root), prefix + (isLast ? "    " : "│   "));
    });
  }
  walk(p, "");
  return result.join("\n");
}
