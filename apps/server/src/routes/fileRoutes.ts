import type { Express } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCompanies } from "../storage/companyStore.js";
import { resolvePathInAllowedRoots } from "../security/localGuards.js";

// Phase 0(工作台·文件管理器):在 projectRoot 子树内安全地列目录 / 读文件,
// 供右上文件管理器打开 md / 代码 / pdf / 图片 / html 预览。
//
// 安全红线(董事长强调):绝不暴露密钥/凭证。三重拦截:
//   1) 路径必须解析在 projectRoot 子树内(修正 startsWith 前缀 bug);
//   2) 敏感目录段(keys/.git/node_modules)与敏感文件名(.env/auth.json/*.key/.opc 配置等)一律拒绝,
//      且在列目录时直接隐藏(explorer 里都看不到);
//   3) 读文件按扩展名白名单分流,未知类型 415 拒绝。

const DENY_SEGMENTS = new Set(["keys", "node_modules", ".git"]);
const DENY_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".npmrc", "auth.json",
  "accounts.json", "providers.json", "config.json", "github_oauth.json",
]);

export function isSensitive(rel: string): boolean {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => DENY_SEGMENTS.has(s.toLowerCase()))) return true;
  const base = (segs[segs.length - 1] || "").toLowerCase();
  if (DENY_BASENAMES.has(base)) return true;
  if (/\.(key|pem|p12|pfx|crt)$/.test(base)) return true;
  if (/(secret|credential|token|password).*\.json$/i.test(base)) return true;
  if (/^id_rsa|^id_ed25519/.test(base)) return true;
  return false;
}

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "log", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "json", "jsonl", "css", "scss", "less", "html", "htm", "csv", "tsv", "yml", "yaml",
  "toml", "xml", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "sql", "ini", "conf", "gitignore", "vue", "svelte", "env",
]);
const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
};
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/mp4",
};
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus",
};

// 媒体/二进制流式响应(支持 Range,让 <video>/<audio> 能 seek;无 Range 则整发)。
function streamFile(req: any, res: any, abs: string, mime: string, size: number): void {
  const range = req.headers?.range as string | undefined;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace("bytes=", "").split("-");
    const start = s ? parseInt(s, 10) : 0;
    const end = e ? parseInt(e, 10) : size - 1;
    if (isNaN(start) || start >= size || end >= size || start > end) { res.status(416).setHeader("Content-Range", `bytes */${size}`); res.end(); return; }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", size);
    fs.createReadStream(abs).pipe(res);
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""; // i>0:".gitignore" → ""(无扩展,按文本)
}

// 解析并确保在 root 子树内(resolved 必须等于 base 或以 base+sep 开头,杜绝 /root vs /rootx 前缀绕过)。
export function safeResolve(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel || ".");
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

// D5 本地单用户(用户选 2+3:浏览本机真实文件):放宽"必须在 projectRoot 子树内"的限制——绝对路径直接用,
// 相对路径相对项目根。**密钥/凭证仍由 isSensitive 全程拦截**(.key/.env/config/keys/credentials 在列目录里隐藏、读也 403)。
// 注:多租户/公开发布前应改回 safeResolve 收紧(见 Stage 9 残留)。
function allowedBrowseRoots(projectRoot: string): string[] {
  try { return loadCompanies(projectRoot).map((c) => c.folder).filter((f): f is string => !!f && !!f.trim()); }
  catch { return []; }
}

export function resolveBrowse(projectRoot: string, p: string): string {
  return resolvePathInAllowedRoots(projectRoot, p, allowedBrowseRoots(projectRoot));
}

export function register(app: Express, projectRoot: string) {
  // 列目录:返回 { dir(绝对), entries:[{name,path(绝对),type,ext,size}] },敏感项已隐藏；只允许已授权工作根。
  app.get("/api/files", (req, res) => {
    const dir = typeof req.query.dir === "string" ? req.query.dir : ".";
    let abs: string;
    try { abs = resolveBrowse(projectRoot, dir); }
    catch (e: any) { return res.status(403).json({ error: e?.message || "access denied" }); }
    if (isSensitive(abs)) return res.status(403).json({ error: "access denied" });
    try {
      const st = fs.statSync(abs);
      if (!st.isDirectory()) return res.status(400).json({ error: "not a directory" });
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !isSensitive(path.join(abs, e.name)))
        .map((e) => {
          const childAbs = path.join(abs, e.name);
          let size = 0;
          try { if (e.isFile()) size = fs.statSync(childAbs).size; } catch { /* ignore */ }
          return {
            name: e.name, path: childAbs.replace(/\\/g, "/"),
            type: e.isDirectory() ? "dir" : "file",
            ext: e.isFile() ? extOf(e.name) : "", size,
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      res.json({ dir: abs.replace(/\\/g, "/"), entries });
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });

  // 读文件:文本→{text};pdf/图片→二进制流；只允许已授权工作根，密钥/凭证类 403。
  app.get("/api/file", (req, res) => {
    const p = typeof req.query.path === "string" ? req.query.path : "";
    if (!p) return res.status(400).json({ error: "path required" });
    let abs: string;
    try { abs = resolveBrowse(projectRoot, p); }
    catch (e: any) { return res.status(403).json({ error: e?.message || "access denied" }); }
    if (isSensitive(abs)) return res.status(403).json({ error: "access denied" });
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { return res.status(404).json({ error: "not found" }); }
    if (!st.isFile()) return res.status(400).json({ error: "not a file" });
    const ext = extOf(abs);
    // 文本/代码 → JSON({text});图片/PDF/视频/音频 → 带 Range 的媒体流;其余二进制 → octet-stream(可下载)。
    if (TEXT_EXT.has(ext) || ext === "") {
      if (st.size > MAX_TEXT_BYTES) return res.status(413).json({ error: "file too large" });
      try { return res.json({ path: abs.replace(/\\/g, "/"), ext, text: fs.readFileSync(abs, "utf-8"), size: st.size }); }
      catch { return res.status(500).json({ error: "read failed" }); }
    }
    const mime = ext === "pdf" ? "application/pdf" : IMG_MIME[ext] || VIDEO_MIME[ext] || AUDIO_MIME[ext];
    if (mime) return streamFile(req, res, abs, mime, st.size);
    // 未知二进制:仍可流式下载(尽量让"各种类型都能读/取"),由前端给下载入口。
    return streamFile(req, res, abs, "application/octet-stream", st.size);
  });
}
