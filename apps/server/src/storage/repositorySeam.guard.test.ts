import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 存储访问缝隙守卫:静态扫描 apps/server/src/routes 与 apps/server/src/runtime 下所有非测试 .ts
// 文件,拦截对 .opc 路径的直接 fs 读写(readFileSync/writeFileSync/appendFileSync/fs.promises.*)。
// 持久化必须经 apps/server/src/storage/*.ts(store 层);routes/runtime 不得自己拼 ".opc/..." 路径
// 再裸调 fs.*。规则同款也刻在 jsonFile.ts 头部注释。
//
// 白名单是"当前已核实、暂不搬"的例外,每条必须附一行理由;LaneC(orchestrator.ts)/LaneA
// (communityRoutes.ts)域内违规按约定只记入白名单+TODO,不在本次改动范围内搬迁。
// 匹配按 file+line+call 精确定位——代码挪动导致行号漂移会让条目重新"落回违规"或"过期",
// 都会让本文件测试失败:这是有意为之的摩擦,逼着改动者重新核实例外是否仍然成立,
// 不做"整文件/整函数豁免"这种一次白名单永久生效的宽松处理。

const STORAGE_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../apps/server/src/storage
const SRC_ROOT = path.dirname(STORAGE_DIR); // .../apps/server/src
const SCAN_DIRS = ["routes", "runtime"];

const FS_CALL_RE =
  /\b(fs\.readFileSync|fs\.writeFileSync|fs\.appendFileSync|fs\.promises\.readFile|fs\.promises\.writeFile|fs\.promises\.appendFile|nodeFs\.readFileSync|nodeFs\.writeFileSync|nodeFs\.appendFileSync|fsp\.readFile|fsp\.writeFile|fsp\.appendFile)\s*\(/g;

interface Hit {
  file: string; // 相对 apps/server/src,正斜杠
  line: number;
  call: string;
}

interface WhitelistEntry extends Hit {
  reason: string;
}

const WHITELIST: WhitelistEntry[] = [
  {
    file: "runtime/engines/acpWorkerBackend.ts", line: 59, call: "fs.readFileSync",
    reason: "P1 · resolveAcpMcpServers 读【真项目】.opc/config.json 的 acpMcp 门控字段(server 端,有真 projectRoot)," +
      "把 enabled MCP 解析后 seed 进隔离沙盒供 worker 用。TODO:后续可经 storage 层暴露 config.acpMcp 的读取器。",
  },
  {
    file: "runtime/engines/acpWorkerBackend.ts", line: 262, call: "fs.readFileSync",
    reason: "readEvidenceEvents 读的是 mkdtemp 隔离根(os.tmpdir()/opc-acp-worker-*)里的 run 证据 " +
      "events.jsonl,不是正式项目 .opc 库——隔离根的存在恰恰是为了让 worker 绝不触碰正式库;" +
      "证据入账由 server 读回后经正规链路落账。(行号随 P1 resolveAcpMcpServers 上移)",
  },
  {
    file: "runtime/engines/acpWorkerBackend.ts", line: 272, call: "fs.readFileSync",
    reason: "readDeliverableContent 读隔离根 run 目录的 report.md 兜底交付文本,同上非正式 .opc 库。(行号随 P1 上移)",
  },
  {
    file: "runtime/engines/acpWorkerBackend.ts", line: 307, call: "fs.writeFileSync",
    reason: "向 mkdtemp 隔离根写单-agent 名册(agents.json),供 worker 在隔离环境解析 agent——" +
      "写正式库反而是这里要防止的事故;经 jsonFile 也可,但隔离根生命周期短暂且随后整树清理。(行号随 P1 上移)",
  },
  {
    file: "runtime/engines/acpWorkerBackend.ts", line: 312, call: "fs.writeFileSync",
    reason: "P1 · 向 mkdtemp 隔离根写 acp_mcp.json(server 端解析好的 ACP McpServer[]),供 worker 读回透传 " +
      "session/new——同 agents.json 一样写隔离沙盒而非正式库,随 run 结束整树清理。",
  },
  // (收口作战令一.2:runExcludedFromInjection 已从 runtime/committedMemoryRetriever 提取到
  //  storage/runInjectionPolicy.ts——storage 层是 .opc 读写的合法区,原白名单例外随之清除。)
  {
    file: "runtime/artifactRegistry.ts", line: 247, call: "fs.readFileSync",
    reason: "readArtifactBytes 读 report.md 是为了算 sha256/size 证据指纹,需要原始 Buffer 而非 " +
      "jsonFile 的 utf-8 文本读取,与 projectStore.loadRunReport(string) 语义不同。" +
      "TODO:若要收口,需在 storage 层补一个返回 Buffer 的等价 helper。",
  },
  {
    file: "runtime/artifactRegistry.ts", line: 344, call: "fs.writeFileSync",
    reason: "archiveArtifactEntities 把任意产物字节归档成 .opc/runs/<id>/artifacts/<按内容动态算出的文件名>" +
      "(扩展名/文件名逐条产物计算,超 1MB 截断),不是单一路径的 JSON/文本文件,不适配 jsonFile 的整文件" +
      "读写模型。TODO:后续若要收口,需要 storage 层新增专门的二进制归档 helper。",
  },
  {
    file: "runtime/eventBus.ts", line: 206, call: "fs.appendFileSync",
    reason: "emit() 是全链路最热路径(每条事件同步 append),文件内注释已明确标注这是刻意的同步高频写入" +
      "设计;包一层 store 函数无隔离收益,只加一次调用开销。TODO:评估是否值得挪成 storage/eventLogStore.ts " +
      "的 append 原语。",
  },
  {
    file: "runtime/globalDoctor.ts", line: 284, call: "fs.writeFileSync",
    reason: "checkDirWritable 对任意目录(不限 .opc)写一次性探针文件测试可写性,体检的目的就是验证裸 fs " +
      "写入是否会被杀软/权限拦——包一层 store 会掩盖体检本身要暴露的问题。",
  },
  {
    file: "runtime/globalDoctor.ts", line: 379, call: "fs.readFileSync",
    reason: "checkMcpConfig 注释明确写明'直接读原始文件 JSON.parse,体检要的恰恰是把损坏暴露出来'—— " +
      "readJSON/listMcpServers 的静默回退恰恰是体检要绕开的行为,不能替换。",
  },
  {
    file: "runtime/globalDoctor.ts", line: 620, call: "fs.readFileSync",
    reason: "checkDeepStoreParse 同上:抽查关键 store 文件能否裸 JSON.parse,目的是暴露损坏而非静默回退," +
      "不能换成 readJSON。",
  },
  {
    file: "runtime/mcpGovernance.ts", line: 210, call: "fs.readFileSync",
    reason: "loadSigningKey 读的是 .opc/mcp_signing.key —— HMAC 签名密钥,纯文本非 JSON,安全敏感路径," +
      "不适配 jsonFile 的 JSON helper,改动需要更谨慎的独立评审。TODO:评估是否需要专门的 secretFile store。",
  },
  {
    file: "runtime/eventBus.ts", line: 69, call: "fs.readFileSync",
    reason: "loadPersistedSequence reads the canonical durable event log so a restarted run can continue a monotonic event sequence.",
  },
  {
    file: "runtime/orchestrator.ts", line: 3247, call: "fs.writeFileSync",
    reason: "orchestrator.ts 域内既有例外,只记入白名单+TODO:写 failure-report.json," +
      "应搬进 storage 层(如 runHistoryStore 对应的写侧函数)。(行号随 token-first 收口移动,已逐条重核仍是同一调用)",
  },
  {
    file: "runtime/orchestrator.ts", line: 3250, call: "fs.writeFileSync",
    reason: "orchestrator.ts 域内既有例外,只记入白名单+TODO:写 run-history.jsonl," +
      "应搬进 storage 层。(行号随 token-first 收口移动,已逐条重核仍是同一调用)",
  },
  {
    file: "runtime/orchestrator.ts", line: 3251, call: "fs.writeFileSync",
    reason: "orchestrator.ts 域内既有例外,只记入白名单+TODO:写 run-summary.json," +
      "应搬进 storage 层(projectStore.updateRunIndex 相邻语义,可考虑合并)。(行号随 token-first 收口移动,已逐条重核仍是同一调用)",
  },
  {
    file: "runtime/orchestrator.ts", line: 3273, call: "fs.writeFileSync",
    reason: "orchestrator.ts 域内既有例外,只记入白名单+TODO:写 result.json" +
      "(ResultContract),应搬进 storage 层。(行号随 token-first 收口移动,已逐条重核仍是同一调用)",
  },
];

function listTsFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// 从 openIdx(指向 "(")往后找配对的 ")"(计深度,支持嵌套括号/跨行)。
function findMatchingParenEnd(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 从 "=" 之后取到语句结尾的 ";"(顶层深度,支持跨行/嵌套括号)。
function extractStatementValue(text: string, startIdx: number): string {
  let depth = 0;
  let i = startIdx;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) break;
  }
  return text.slice(startIdx, i);
}

// 从完整参数列表文本里切出第一个参数(顶层第一个逗号之前) —— fs.* 系列函数的路径都是首参。
function firstArgText(fullArgText: string): string {
  let depth = 0;
  for (let i = 0; i < fullArgText.length; i++) {
    const c = fullArgText[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return fullArgText.slice(0, i);
  }
  return fullArgText;
}

// 扫描单个文件:找出所有 fs 读写调用,首参字面量含 ".opc",或首参引用了一个"沾污"变量
// (该变量的声明语句里直接含字面量 ".opc",按同文件内定点传播,覆盖
// "const dir = path.join(root, '.opc', 'runs'); … fs.xxx(dir)" 这类间接路径构造)。
// 刻意保持"同文件内简单变量追踪",不跨函数解析(如 path.join(fnReturningOpcPath()) 不会被追出来)——
// 这是static-text 启发式的已知局限,不做成完整数据流分析。
function scanFile(absFile: string, relFile: string): Hit[] {
  const text = fs.readFileSync(absFile, "utf-8");
  const hits: Hit[] = [];

  const declRe = /\b(?:const|let|var)\s+(\w+)\s*=/g;
  const decls: Array<{ name: string; valueText: string }> = [];
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(text))) {
    const eqIdx = dm.index + dm[0].length;
    decls.push({ name: dm[1], valueText: extractStatementValue(text, eqIdx) });
  }
  const tainted = new Set<string>();
  for (const d of decls) if (d.valueText.includes(".opc")) tainted.add(d.name);
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (const d of decls) {
      if (tainted.has(d.name)) continue;
      for (const t of tainted) {
        if (new RegExp(`\\b${t}\\b`).test(d.valueText)) {
          tainted.add(d.name);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  FS_CALL_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FS_CALL_RE.exec(text))) {
    const openIdx = fm.index + fm[0].length - 1;
    const closeIdx = findMatchingParenEnd(text, openIdx);
    if (closeIdx === -1) continue;
    const pathArg = firstArgText(text.slice(openIdx + 1, closeIdx));
    let hit = pathArg.includes(".opc");
    if (!hit) {
      for (const t of tainted) {
        if (new RegExp(`\\b${t}\\b`).test(pathArg)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      const line = text.slice(0, fm.index).split("\n").length;
      hits.push({ file: relFile, line, call: fm[1] });
    }
  }
  return hits;
}

function scanAll(): Hit[] {
  const hits: Hit[] = [];
  for (const dirName of SCAN_DIRS) {
    const dirAbs = path.join(SRC_ROOT, dirName);
    for (const abs of listTsFiles(dirAbs)) {
      const rel = path.relative(SRC_ROOT, abs).split(path.sep).join("/");
      hits.push(...scanFile(abs, rel));
    }
  }
  return hits;
}

describe("Repository 缝隙守卫:routes/runtime 不得直接 fs 读写 .opc 路径", () => {
  const hits = scanAll();

  it("每一处命中要么已改走 storage 层,要么在白名单里且附了理由", () => {
    const unlisted = hits.filter(
      (h) => !WHITELIST.some((w) => w.file === h.file && w.line === h.line && w.call === h.call),
    );
    expect(
      unlisted,
      `发现未列入白名单的直接 fs 读写 .opc 路径,请搬进 apps/server/src/storage/ 下的 store,` +
        `或在 WHITELIST 里补一条附理由的例外:\n${JSON.stringify(unlisted, null, 2)}`,
    ).toEqual([]);
  });

  it("白名单没有过期条目(每条都仍对应一处真实命中)", () => {
    const stale = WHITELIST.filter(
      (w) => !hits.some((h) => h.file === w.file && h.line === w.line && h.call === w.call),
    );
    expect(
      stale,
      `以下白名单条目已找不到对应的违规行(代码已挪动/已修复),请清理 WHITELIST:\n${JSON.stringify(stale, null, 2)}`,
    ).toEqual([]);
  });

  it("白名单理由不能是空话(每条至少 10 个字)", () => {
    for (const w of WHITELIST) {
      expect(w.reason.trim().length, `${w.file}:${w.line} 的白名单理由太短`).toBeGreaterThanOrEqual(10);
    }
  });
});
