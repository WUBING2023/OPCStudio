// i18n 翻译填充:以 en 为基准,把 apps/web/src/i18n.dict.json 里其它语言的缺失键用 deepseek-chat
// (最便宜)批量翻译补齐。串行、分批(40 键/批)、原子写回、可重复跑(只补缺失)。
// 用法: node scripts/i18n-fill.mjs [--dry] [--fix-same]
//   --fix-same: 复审发现批翻会把 General/Auth/"{n} runs" 这类词过度当"技术词"原样保留——
//   该模式找出"值与 en 完全相同"的键重译一轮(prompt 放宽:让模型自行判断纯技术词才保留),
//   译文仍与 en 相同的不改(视为模型确认是技术词)。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DICT = path.join(ROOT, "apps/web/src/i18n.dict.json");
const DRY = process.argv.includes("--dry");
const FIX_SAME = process.argv.includes("--fix-same");

const LANG_NAMES = { "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", es: "Spanish", hi: "Hindi", ar: "Arabic", pt: "Portuguese", ru: "Russian", ja: "Japanese", fr: "French", de: "German" };

function readKey() {
  for (const dir of [process.env.OPC_KEYS_DIR, path.join(ROOT, ".opc", "keys"), path.resolve(ROOT, "..", "..", "keys")].filter(Boolean)) {
    try { const f = path.join(dir, "deepseek.key"); if (fs.existsSync(f)) { const k = fs.readFileSync(f, "utf8").trim(); if (k) return k; } } catch {}
  }
  return process.env.DEEPSEEK_API_KEY || "";
}
const KEY = readKey();
if (!KEY && !DRY) { console.error("无 deepseek key"); process.exit(1); }

async function translateBatch(lang, entries, strict = false) {
  const rules = strict
    // --fix-same 重译:这些串上一轮被原样保留了——放宽"技术词"判定,只有纯技术标识才许保留。
    ? `Rules: these strings were previously left untranslated by mistake — translate them properly into ${LANG_NAMES[lang]}. ONLY these exact tokens may stay in English: OPC, MCP, API, worktree, and placeholder patterns like {n}/{name}/{id}. Everything else (including words like "General", "Auth", "runs", "Run") must be translated naturally. Keep them concise like UI labels; return ONLY a JSON object mapping the same keys to translated strings.`
    : `Rules: keep them concise like UI labels; do NOT translate product/technical terms (OPC, MCP, API, Agent, token, run, Trace, worktree); keep any placeholders like {n} or {name} unchanged; return ONLY a JSON object mapping the same keys to translated strings, no explanations.`;
  const prompt = `Translate the following UI label strings from English to ${LANG_NAMES[lang]}. They are short interface labels for a desktop app that manages AI agent "companies".
${rules}

${JSON.stringify(entries, null, 0)}`;
  const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 4000 }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error("deepseek " + resp.status);
  const txt = (await resp.json()).choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in response");
  return JSON.parse(m[0]);
}

const dicts = JSON.parse(fs.readFileSync(DICT, "utf8"));
const en = dicts.en || {};
const enKeys = Object.keys(en);
console.log(`en 基准 ${enKeys.length} 键`);

let totalFilled = 0;
for (const lang of Object.keys(LANG_NAMES)) {
  dicts[lang] = dicts[lang] || {};
  // 常规模式:补缺失键;--fix-same:重译"值与 en 原样相同"的键(排除 zh-CN 巧合同形基本不存在)
  const targets = FIX_SAME
    ? enKeys.filter((k) => k in dicts[lang] && dicts[lang][k] === en[k] && /[A-Za-z]{3,}/.test(en[k]))
    : enKeys.filter((k) => !(k in dicts[lang]));
  if (!targets.length) { console.log(`${lang}: ${FIX_SAME ? "无同形键" : "完整"}`); continue; }
  console.log(`${lang}: ${FIX_SAME ? "同形" : "缺"} ${targets.length} 键${DRY ? "(dry,跳过)" : ",翻译中…"}`);
  if (DRY) continue;
  for (let i = 0; i < targets.length; i += 40) {
    const batchKeys = targets.slice(i, i + 40);
    const batch = Object.fromEntries(batchKeys.map((k) => [k, en[k]]));
    try {
      const out = await translateBatch(lang, batch, FIX_SAME);
      for (const k of batchKeys) if (typeof out[k] === "string" && out[k].trim()) {
        const v = out[k].trim();
        if (FIX_SAME && v === en[k]) continue; // 模型确认保留英文(纯技术词)→ 不计
        dicts[lang][k] = v; totalFilled++;
      }
    } catch (e) { console.error(`  批 ${i / 40 + 1} 失败: ${e.message}(跳过,可重跑补)`); }
  }
  // 每语言落一次盘(原子):中途断了不丢已翻的
  const tmp = DICT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dicts, null, 2) + "\n");
  fs.renameSync(tmp, DICT);
}
console.log(`完成:共${FIX_SAME ? "重译" : "补"} ${totalFilled} 条。`);
