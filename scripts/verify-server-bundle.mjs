// 发行硬门(审计 P0 · 安装包污染):staging 后、electron-builder 前强制校验 server-bundle。
// 违规即 exit 1 中断构建——白名单外文件 / 运行数据 / 疑似密钥,一票否决,绝不静默放行。
import * as fs from "node:fs";
import * as path from "node:path";

const BUNDLE = path.resolve(process.env.OPC_SERVER_BUNDLE_DIR || "electron-app/server-bundle");
const errors = [];

// 门1 · 顶层白名单:dist / node_modules / package.json(npm 自动附带的 LICENSE/README 亦可)。
const TOP_ALLOW = new Set(["dist", "cli-dist", "node-runtime", "node_modules", "package.json", "LICENSE", "LICENSE.md", "README.md"]);
for (const name of fs.readdirSync(BUNDLE)) {
  if (!TOP_ALLOW.has(name)) errors.push(`顶层白名单外: ${name}`);
}

// 门2 · 递归禁品(node_modules 之外):运行数据 / 源码 / 测试 / env / 开发残留。
const FORBIDDEN_SEGMENT = new Set([".opc", ".opc-studio", "src", "__fixtures__"]);
const FORBIDDEN_FILE = /(^\.env(\..*)?$|\.test\.[cm]?[jt]sx?$|^greet\.txt$|^tsconfig.*\.json$)/;
function walk(dir, rel = "") {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // node_modules can appear below bundled runtimes (for example node-runtime/npm/node_modules).
      // Treat every dependency tree consistently: scan secrets/runtime data, but do not reject
      // legitimate third-party src/test directories as OPC Studio source leakage.
      if (e.name === "node_modules") { walkNm(path.join(dir, e.name), r); continue; }
      if (FORBIDDEN_SEGMENT.has(e.name)) { errors.push(`禁品目录: ${r}`); continue; }
      walk(path.join(dir, e.name), r);
    } else {
      if (FORBIDDEN_FILE.test(e.name)) errors.push(`禁品文件: ${r}`);
      // dist 外不允许任何 .ts(dist 内 .d.ts 类型声明放行)
      if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name) && !r.startsWith("dist/")) errors.push(`源码泄漏: ${r}`);
    }
  }
}
// node_modules 只查最要命的:.opc / .env(第三方包自带测试文件不管)。
function walkNm(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === ".opc" || e.name === ".opc-studio") { errors.push(`禁品目录: ${r}`); continue; }
      walkNm(path.join(dir, e.name), r);
    } else if (/^\.env(\..*)?$/.test(e.name)) errors.push(`禁品文件: ${r}`);
  }
}
walk(BUNDLE);

// 门3 · 密钥扫描(node_modules 外全部 ≤2MB 文本文件):sk- 长串 / apiKey 字段带 ≥20 位实值。
const KEY_PATTERNS = [/sk-[A-Za-z0-9_-]{20,}/, /"(apiKey|api_key|token|secret)"\s*:\s*"[A-Za-z0-9_-]{20,}"/i];
function scanSecrets(dir, rel = "") {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules") scanSecrets(path.join(dir, e.name), r); continue; }
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = fs.readFileSync(p, "utf-8"); } catch { continue; }
    for (const re of KEY_PATTERNS) {
      const m = text.match(re);
      if (m) { errors.push(`疑似密钥(${re}): ${r} → ${m[0].slice(0, 8)}…(已截断)`); break; }
    }
  }
}
scanSecrets(BUNDLE);

if (errors.length) {
  console.error(`✖ server-bundle 发行硬门失败(${errors.length} 项):`);
  for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
  if (errors.length > 40) console.error(`  …以及另外 ${errors.length - 40} 项`);
  process.exit(1);
}
console.log("✔ server-bundle 发行硬门通过: 顶层仅 dist/node_modules/package.json,无运行数据/源码/测试/env,无疑似密钥");
