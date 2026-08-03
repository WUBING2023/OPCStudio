// i18n 完整性校验:扫描 web 源码里的 t("key")/tr("key") 用法,与 i18n.dict.json 对账。
// 输出:代码引用但 en/zh-CN 缺失的键(并发写字典被吞的键会在这现形)+ 字典有但代码未引用的键(仅提示)。
// 用法: node scripts/i18n-check.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "apps/web/src");
const DICT = path.join(ROOT, "apps/web/src/i18n.dict.json");

const used = new Set();
const KEY_RE = /\b(?:t|tr)\(\s*["'`]([A-Za-z0-9_.-]+)["'`]/g;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
    if (!/\.(tsx?|jsx?)$/.test(e.name)) continue;
    const s = fs.readFileSync(p, "utf8");
    for (const m of s.matchAll(KEY_RE)) used.add(m[1]);
  }
})(SRC);

const dicts = JSON.parse(fs.readFileSync(DICT, "utf8"));
const en = dicts.en || {}, zh = dicts["zh-CN"] || {};
const missEn = [...used].filter((k) => !(k in en)).sort();
const missZh = [...used].filter((k) => !(k in zh)).sort();
const unused = Object.keys(en).filter((k) => !used.has(k)).sort();

console.log(`代码引用键: ${used.size} · en: ${Object.keys(en).length} · zh-CN: ${Object.keys(zh).length}`);
if (missEn.length) { console.log(`\n❌ 缺 en(${missEn.length}):`); for (const k of missEn) console.log("  " + k); }
if (missZh.length) { console.log(`\n❌ 缺 zh-CN(${missZh.length}):`); for (const k of missZh) console.log("  " + k); }
if (!missEn.length && !missZh.length) console.log("✅ en/zh-CN 覆盖完整");
if (unused.length) console.log(`\n(提示)字典存在但代码未引用: ${unused.length} 键(可能动态拼 key 或待清理,不算错)`);
process.exit(missEn.length || missZh.length ? 1 : 0);
