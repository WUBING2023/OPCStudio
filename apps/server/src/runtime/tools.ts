import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { contractBindsTest } from "@opc/shared";
import { readFile, writeFile, deleteFile, listFiles, getProjectTree, resolveSafe, setProjectRoot } from "../security/pathGuard.js";
import { isShellAllowed } from "../security/shellGuard.js";
import { loadConfig } from "../storage/projectStore.js";
import { getProfileForRole, checkFileAllowed, checkShellAllowed } from "./roleProfile.js";

let toolsProjectRoot = "";

export function setToolsProjectRoot(root: string) {
  toolsProjectRoot = root;
  setProjectRoot(root);
}

// Per-call working root, carried via AsyncLocalStorage so concurrent workers (each runTool'd with
// its own worktree) stay isolated without a shared mutable global. Falls back to the global root.
const rootStore = new AsyncLocalStorage<string>();
const configRootStore = new AsyncLocalStorage<string>();
function currentRoot(): string {
  return rootStore.getStore() || toolsProjectRoot || resolveSafe(".");
}
function currentConfigRoot(): string {
  return configRootStore.getStore() || toolsProjectRoot || currentRoot();
}

// v6 P3b: 当前执行 agent 的 id（由 runEngineCore 包住整个 worker run 设置），让 request_channel 等
// 工具知道"谁在调用"，无需改 runTool 签名。
// A1-V3: 顺带携带 role,让 runShell 能按角色 shellMode 档位拦截;不传 role = 不做角色档位判定(向后兼容)。
const agentStore = new AsyncLocalStorage<{ id: string; role?: string }>();
export function runWithAgent<T>(agentId: string, fn: () => T, role?: string): T {
  return agentStore.run({ id: agentId, role }, fn);
}
function currentAgentId(): string | undefined { return agentStore.getStore()?.id; }
function currentAgentRole(): string | undefined { return agentStore.getStore()?.role; }

function assertFileMutationAllowed(relativePath: string): void {
  const config = loadConfig(currentConfigRoot());
  if (!config.permissions.allowFileWrite) {
    throw new Error("file changes are not allowed (set permissions.allowFileWrite to true)");
  }
  const role = currentAgentRole();
  if (!role) return;
  const verdict = checkFileAllowed(getProfileForRole(role), relativePath);
  if (!verdict.allowed) throw new Error(`file change blocked by role profile (${role}): ${verdict.detail}`);
}

// P0-4 · 验证者(test/tester/qa/reviewer)受限测试通道。给"跑测试"的最小授权:即便全局 allowShell=false、
// 也不看角色 shellMode 档,验证者仍可在其 run workRoot 内跑**白名单测试命令**(node <测试文件> / npm|pnpm|yarn
// test / npx vitest|jest / pytest / go test / cargo test)。这不是开放 shell:只放行单条测试命令、禁 shell
// 串接/重定向/命令替换、cwd 严格限定 workRoot;结果首行输出机器可解析的 [test-evidence] 头(含 command/cwd/
// exit/passed),deriveTestEvidence 据此把命令/cwd/退出码/输出记入 TestEvidence。
const TEST_COMMAND_RE = new RegExp(
  "^(?:" +
    "(?:npm|pnpm|yarn)\\s+(?:run\\s+)?test\\b" +          // npm/pnpm/yarn (run) test
    "|npx\\s+(?:vitest|jest|mocha)\\b" +                  // npx vitest / jest / mocha
    "|node\\s+(?:--test(?:\\s+\\S*(?:test|spec)\\S*\\.(?:m|c)?js)?|\\S*(?:test|spec)\\S*\\.(?:m|c)?js)\\b" + // node --test [x.test.js] / node x.test.js
    "|(?:python3?\\s+-m\\s+pytest|pytest)\\b" +           // python -m pytest / pytest
    "|python3?\\s+\\S*(?:test|spec)\\S*\\.py\\b" +        // python test_x.py / x_test.py
    "|go\\s+test\\b" +                                    // go test
    "|cargo\\s+test\\b" +                                 // cargo test
  ")",
  "i",
);

// 常见 ACP agent(claude-code 等)会在测试命令后追加 `; echo EXIT_CODE=$?` / `&& echo done` 来拿退出码——
// 本通道用 runTestCommandWithEvidence 自己捕获 exitCode,这类尾部 echo 冗余且无害。仅当其余段【全是纯 echo】
// 时提取首条真命令(既顺 agent 习惯又不开放真正的命令串接:有任何非 echo 搭车命令 → 原样返回,交给下方
// 串接检测拒绝)。
export function stripTrailingEcho(command: string): string {
  const raw = (command ?? "").trim();
  const parts = raw.split(/;|&&/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return raw;
  const [first, ...rest] = parts;
  return rest.every((p) => /^echo\b/i.test(p)) ? first : raw;
}

// 收口令一(选1)· 头注入防线(对抗验证 P0 CONFIRMED 修复):runTestCommandWithEvidence 把 command
// 插值进 [test-evidence] 机器头,deriveTestEvidence 只按【首行】$ 锚定解析。若 command 含换行,agent 可把
// 伪造的 passed=/testedFile=/resolvedFiles=<base64> 塞进首行、把真字段挤到第二行永不读 → 伪造 verified
// (头号红线)。故受限测试命令必须【单行且不含任何 header 字段标记】——合法测试命令绝不含这些,拒之无副作用。
// eslint-disable-next-line no-control-regex -- 有意匹配控制字符(换行/CR/Tab),空格会误伤合法命令故排除
const HEADER_INJECTION_RE = /[^\S ]|(?:cwd|exit|passed|testedFile|testedHash|resolvedFiles|command)=/i;

export function isRestrictedTestCommand(command: string): boolean {
  const c = stripTrailingEcho((command ?? "").trim());
  if (!c) return false;
  // 只跑单条测试命令:任何 shell 串接/管道/重定向/命令替换/反引号一律拒绝(防 `npm test && rm -rf x` 搭车)。
  // 尾部纯 echo 已被 stripTrailingEcho 剥离,故此处仍严格拒 `;&|` 等。
  if (/[;&|><`]|\$\(/.test(c)) return false;
  // 头注入防线:换行/控制字符 + header 字段标记(agent 无法借 command 伪造 [test-evidence] 头字段)。
  if (HEADER_INJECTION_RE.test(c)) return false;
  return TEST_COMMAND_RE.test(c);
}

// P0 · 从受限测试命令里解析"被测的测试文件"(相对 workRoot,POSIX)+ 其内容 hash——让 runShell 通道产出的
// 独立证据也能绑定本 run 交付合同(DeliveryAcceptance 据 testedFile∈合同 判覆盖)。取命令里最后一个匹配测试文件
// 名的 token(node x.test.js / npx tsx x.spec.ts / python test_x.py / pytest x_test.py);拿不到就缺省(不虚构),
// 整套命令(npm test / 无文件参数的 pytest)天然无单文件目标 → 缺省,交给 gate 的"仅套件级证据"软路径。
function evidenceTestedFile(command: string, root: string): { rel: string; hash?: string } | null {
  const tokens = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  const isTestFile = (t: string) => /\.(?:test|spec)\.(?:m|c)?[jt]sx?$/i.test(t) || /(?:^|[\\/])test_[^\\/]*\.py$/i.test(t) || /_test\.py$/i.test(t);
  let hit: string | null = null;
  for (const raw of tokens) { const t = raw.replace(/^["']|["']$/g, ""); if (isTestFile(t)) hit = t; }
  if (!hit) return null;
  const abs = path.isAbsolute(hit) ? hit : path.join(root, hit);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null; // cwd 外的文件不作为本 run 合同证据(受限通道本就限 workRoot,双保险)
  const hash = hashSnapshotFile(abs);
  return { rel, ...(hash ? { hash } : {}) };
}

// 内部 git 调用统一 execFileSync 数组传参(MUP Gate A#3:不拼 shell 字符串,消除注入面);
// stdio 全 pipe,预期失败(非 git 目录等)的 stderr 进异常对象而非刷屏。
function gitExec(root: string, args: string[], timeout: number): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

// 命令是否为 node 族测试(可注入 NODE_OPTIONS 解析链钩子):看被测文件是 JS/TS,或命令行含 node 运行器。
// python/其它语言不匹配(NODE_OPTIONS 对它们无害但无意义,不建记录器免浪费 tmpdir)。
function isNodeFamilyTestCommand(command: string, testedFileRel?: string): boolean {
  if (testedFileRel && /\.(?:m|c)?[jt]sx?$/i.test(testedFileRel)) return true;
  return /(?:^|\s)(?:node|npx|npm|pnpm|yarn|tsx|vitest|jest|mocha)(?:\s|$)/i.test(command);
}

// 在 workRoot 内跑受限测试命令,捕获 command/cwd/exitCode/stdout,返回带 [test-evidence] 头的文本。
// 信任边界(用户选2 定案):runShell 是 **agent 调用**的通道,【无权自报 verified 强证据】(resolvedProducerFiles)。
// 对抗验证证明进程内解析链可信化根本不可行(node:inspector 提密钥 / require.resolve 触发签名)。故本通道只产**弱证据**
// (command/cwd/exitCode/passed/testedFile+hash)→ 封顶 tests_ran_unbound;verified 强证据【只】由 Core 驱动的进程外
// CDP+coverage 观测器(runVerifierTestsInSnapshot → coreTestObserver)产出。头里不再有任何 resolvedProducerFiles/nonce。
export function compactTestOutput(output: string, passed: boolean, maxChars = 4_000): string {
  const text = output.toString();
  if (text.length <= maxChars) return text;
  if (passed) return `${text.slice(0, maxChars)}\n... [output truncated]`;
  const marker = "\n... [middle truncated; failure tail follows] ...\n";
  const headChars = Math.min(800, Math.floor(maxChars / 3));
  const tailChars = Math.max(0, maxChars - headChars - marker.length);
  return text.slice(0, headChars) + marker + text.slice(-tailChars);
}

function runTestCommandWithEvidence(command: string, root: string): string {
  const tf = evidenceTestedFile(command, root);
  let exitCode: number;
  let output: string;
  let passed: boolean;
  try {
    output = execSync(command, { timeout: 120000, cwd: root, encoding: "utf-8", stdio: "pipe" }).toString();
    exitCode = 0; passed = true;
  } catch (e: any) {
    output = (((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "tests failed").toString();
    exitCode = typeof e.status === "number" ? e.status : 1;
    passed = false;
  }
  // P0 · testedFile/testedHash 追加在 passed 之后(成对出现,供 gate 判合同覆盖——这是弱证据,不足以 verified)。
  const tail = tf ? ` testedFile=${tf.rel}${tf.hash ? ` testedHash=${tf.hash}` : ""}` : "";
  const head = `[test-evidence] command=${command} cwd=${root} exit=${exitCode} passed=${passed}${tail}`;
  const body = compactTestOutput(output, passed);
  return `${head}\n${passed ? body : `Tests failed:\n${body}`}`;
}

// v6 P3b: request_channel 工具把申请交给编排层（runChannels）的钩子——避免 tools↔orchestrator 循环依赖。
// A2A: kind 可选(默认 peer-worker),让 worker 也能申请 peer-lead 等通道。
type ChannelRequestHandler = (from: string, target: string, reason: string, kind?: import("@opc/shared").ChannelKind) => string;
let channelRequestHandler: ChannelRequestHandler | null = null;
export function setChannelRequestHandler(fn: ChannelRequestHandler | null): void { channelRequestHandler = fn; }

// A2A: agent 主动通信工具的钩子(均由 orchestrator 注入,避免循环依赖)。
type DiscoverHandler = (from: string, filter: { role?: string; skill?: string; produces?: string }) => string;
type A2ASendHandler = (from: string, target: string, text: string, artifactId?: string) => string;
type ShareHandler = (from: string, target: string, artifactId: string, note?: string) => string;
type AskHandler = (from: string, target: string, question: string) => Promise<string>;
type InboxPeekHandler = (agentId: string) => string;
let discoverHandler: DiscoverHandler | null = null;
let a2aSendHandler: A2ASendHandler | null = null;
let shareHandler: ShareHandler | null = null;
let askHandler: AskHandler | null = null;
let inboxPeekHandler: InboxPeekHandler | null = null;
export function setDiscoverHandler(fn: DiscoverHandler | null): void { discoverHandler = fn; }
export function setA2ASendHandler(fn: A2ASendHandler | null): void { a2aSendHandler = fn; }
export function setShareHandler(fn: ShareHandler | null): void { shareHandler = fn; }
export function setAskHandler(fn: AskHandler | null): void { askHandler = fn; }
export function setInboxPeekHandler(fn: InboxPeekHandler | null): void { inboxPeekHandler = fn; }

export interface ToolParamSchema {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  execute(args: Record<string, any>): Promise<string>;
  paramSchema?: ToolParamSchema;        // inline param schema (MCP tools carry their own)
  source?: "builtin" | "mcp";
  mcpServerId?: string;
}

export const ALL_TOOLS: ToolDef[] = [
  {
    name: "readFile",
    description: "Read file content. Args: path (relative path)",
    execute: async (args) => readFile(args.path, currentRoot()),
  },
  {
    name: "writeFile",
    description: "Create or modify a file inside the assigned working directory. Args: path, content",
    execute: async (args) => {
      assertFileMutationAllowed(args.path);
      writeFile(args.path, args.content, currentRoot());
      return `Written: ${args.path}`;
    },
  },
  {
    name: "deleteFile",
    description: "Delete one file inside the assigned working directory. Directories, credentials, .git, and .opc are protected. Args: path",
    execute: async (args) => {
      assertFileMutationAllowed(args.path);
      deleteFile(args.path, currentRoot());
      return `Deleted: ${args.path}`;
    },
  },
  {
    // v6 P3b: worker 运行中主动申请与项目里另一个成员建立通信通道（待其 lead 批准）。
    name: "request_channel",
    description: "Request a communication channel with another team member to coordinate. Args: target (the other agent's id), reason (why you need to talk to them), kind (optional: peer-worker default / peer-lead). The request is sent to your lead/CEO for approval. Tip: use discover_agents first to find who to talk to.",
    paramSchema: { properties: { target: { type: "string", description: "the other agent's id" }, reason: { type: "string", description: "why you need to talk to them" }, kind: { type: "string", description: "channel type: peer-worker (default) or peer-lead" } }, required: ["target", "reason"] },
    execute: async (args) => {
      const from = currentAgentId();
      if (!from) return "无法确定申请方身份，申请未提交。";
      if (!channelRequestHandler) return "当前不在运行上下文中，无法申请通道。";
      if (!args.target) return "请提供 target（想交流的成员 id）。";
      return channelRequestHandler(from, String(args.target), String(args.reason || ""), args.kind as import("@opc/shared").ChannelKind | undefined);
    },
  },
  {
    // A2A: 按角色/能力发现可协作的成员(Agent Card 目录 / FIPA DF 黄页)。
    name: "discover_agents",
    description: "Discover other agents you can collaborate with, filtered by role/skill/what-they-produce. Returns a capability directory (id, name, role, summary, skills). Use this BEFORE request_channel to find the right teammate.",
    paramSchema: { properties: { role: { type: "string", description: "filter by role" }, skill: { type: "string", description: "filter by skill keyword" }, produces: { type: "string", description: "filter by artifact type they produce" } }, required: [] },
    execute: async (args) => {
      const from = currentAgentId();
      if (!from || !discoverHandler) return "当前不在运行上下文中，无法发现成员。";
      return discoverHandler(from, { role: args.role ? String(args.role) : undefined, skill: args.skill ? String(args.skill) : undefined, produces: args.produces ? String(args.produces) : undefined });
    },
  },
  {
    // A2A: 向已开通通道的成员发单向通知(performative=inform),可附带产出物引用。不等回复。
    name: "send_message",
    description: "Send a one-way notification to another agent you have an OPEN channel with (use request_channel first). Optionally attach one of your artifacts by id. Does NOT wait for a reply — use ask_agent if you need an answer.",
    paramSchema: { properties: { target: { type: "string", description: "recipient agent id" }, text: { type: "string", description: "the message" }, artifactId: { type: "string", description: "optional: your artifact id to attach" } }, required: ["target", "text"] },
    execute: async (args) => {
      const from = currentAgentId();
      if (!from || !a2aSendHandler) return "当前不在运行上下文中，无法发送消息。";
      if (!args.target || !args.text) return "请提供 target 和 text。";
      return a2aSendHandler(from, String(args.target), String(args.text), args.artifactId ? String(args.artifactId) : undefined);
    },
  },
  {
    // A2A: 把自己产出的文档/代码/报告(claim-check artifact)发给某成员,只传引用不内联全文。
    name: "share_artifact",
    description: "Share one of YOUR produced artifacts (document/code-diff/report) with another agent by artifact id. The recipient receives a reference + summary (not the full text). Requires an open channel.",
    paramSchema: { properties: { target: { type: "string", description: "recipient agent id" }, artifactId: { type: "string", description: "the artifact id to share" }, note: { type: "string", description: "a short note about it" } }, required: ["target", "artifactId"] },
    execute: async (args) => {
      const from = currentAgentId();
      if (!from || !shareHandler) return "当前不在运行上下文中，无法分享产出物。";
      if (!args.target || !args.artifactId) return "请提供 target 和 artifactId。";
      return shareHandler(from, String(args.target), String(args.artifactId), args.note ? String(args.note) : undefined);
    },
  },
  {
    // A2A Phase 5: 向某成员问询并等待其回答(query-ref);不转移任务所有权(区别 handoff)。
    name: "ask_agent",
    description: "Ask another agent a question and WAIT for their answer (you keep ownership of your task — this is NOT handing the task to them). Requires an open channel. Returns their reply text, or a notice if they don't respond in time.",
    paramSchema: { properties: { target: { type: "string", description: "the agent to ask" }, question: { type: "string", description: "your question" } }, required: ["target", "question"] },
    execute: async (args) => {
      const from = currentAgentId();
      if (!from || !askHandler) return "当前不在运行上下文中，无法问询。";
      if (!args.target || !args.question) return "请提供 target 和 question。";
      return askHandler(from, String(args.target), String(args.question));
    },
  },
  {
    // A2A: 自省——查看自己 inbox 里待处理的同侪消息(不消费)。
    name: "list_my_inbox",
    description: "List the messages other agents have sent you that are waiting (without consuming them), so you can decide whether to reply or act.",
    paramSchema: { properties: {}, required: [] },
    execute: async () => {
      const from = currentAgentId();
      if (!from) return "当前不在运行上下文中。";
      return inboxPeekHandler ? inboxPeekHandler(from) : "(inbox 自省未启用)";
    },
  },
  {
    name: "listFiles",
    description: "List directory. Args: path (default '.')",
    execute: async (args) => listFiles(args.path || ".", currentRoot()).join("\n"),
  },
  {
    name: "getProjectTree",
    description: "Show project tree. Args: path (default '.')",
    execute: async (args) => getProjectTree(args.path || ".", currentRoot()),
  },
  {
    name: "searchFiles",
    description: "Search project files for a query string. Args: query",
    execute: async (args) => {
      const query = args.query;
      if (!query) return "Error: query is required";
      const results: string[] = [];
      const MAX_RESULTS = 50;
      const TEXT_EXTENSIONS = new Set([
        ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h",
        ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss", ".less",
        ".md", ".txt", ".csv", ".env", ".gitignore", ".sh", ".bash", ".zsh",
        ".vue", ".svelte", ".astro", ".sql", ".graphql", ".prisma",
      ]);

      const root = currentRoot();
      function walk(dir: string) {
        if (results.length >= MAX_RESULTS) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (results.length >= MAX_RESULTS) return;
                if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                  const relPath = path.relative(root, fullPath);
                  results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }
      walk(root);
      return results.length ? results.join("\n") : `No matches found for "${query}"`;
    },
  },
  {
    name: "runShell",
    description: "Execute a shell command. Args: command",
    execute: async (args) => {
      const command = args.command;
      if (!command) return "Error: command is required";
      const role = currentAgentRole();
      const root = currentRoot();
      // P0-4 · 受限测试通道:白名单测试命令(node <测试文件> / npm|pnpm|yarn test / npx vitest|jest /
      // pytest / go|cargo test)直接放行(绕过全局 allowShell 开关),只在其 workRoot(currentRoot)内执行,
      // 输出 [test-evidence] 头供 TestEvidence 采集。安全靠【命令白名单 + 禁串接/重定向 + workRoot 限定】。
      // 角色门:仅 shellMode=none(fact_checker:纯检索+文本产出,明确零命令执行)不破例;其余角色
      // (dev/tester/architect/lead/researcher 等 allowlist/full)本就可经 SHELL_ALLOWLIST_COMMANDS 跑
      // node/python(见 roleProfile),此通道对它们不扩权,只额外绕过全局 allowShell 门——好让"要求测试的
      // 编码任务"在 allowShell=false 时也能产出真 TestEvidence(活体验证暴露:实际跑测试的常是 dev/architect
      // 单 worker,只放 verifier 会让 DeliveryAcceptance 永远 missing_test_evidence)。无 role 上下文(直调/
      // 单测)=按 full 放行(向后兼容)。尾部纯 echo(agent 惯用 `; echo EXIT_CODE=$?`)由 stripTrailingEcho
      // 剥离后再执行(exitCode 本通道自捕,无需 echo)。
      if (isRestrictedTestCommand(command)) {
        const shellMode = role ? getProfileForRole(role).shellMode : "full";
        if (shellMode !== "none") {
          const testCmd = stripTrailingEcho(command);
          console.log(`[runShell:test] ${testCmd} (role=${role ?? "?"})`);
          return runTestCommandWithEvidence(testCmd, root);
        }
      }
      // A1-V3: 角色档位在全局开关之外叠加(none 全禁 / allowlist 首词白名单 / full 不限)。
      // 无 role 上下文(直调 runTool 的旧路径/测试)= 跳过角色判定,只走全局门。
      if (role) {
        const verdict = checkShellAllowed(getProfileForRole(role), command);
        if (!verdict.allowed) {
          return `Error: shell blocked by role profile (${role}): ${verdict.detail}`;
        }
      }
      const config = loadConfig(currentConfigRoot());
      if (!isShellAllowed(config.permissions)) {
        return "Error: shell execution is not allowed (set permissions.allowShell to true)";
      }
      console.log(`[runShell] ${command}`);
      try {
        const stdout = execSync(command, { timeout: 30000, cwd: root, encoding: "utf-8" });
        return compactTestOutput(stdout.toString(), true);
      } catch (e: any) {
        const stderr = (((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "").toString();
        return `Error: ${compactTestOutput(stderr, false)}`;
      }
    },
  },
  {
    name: "gitStatus",
    description: "Show git working tree status. No args.",
    execute: async () => {
      const root = currentRoot();
      try {
        return gitExec(root, ["status", "--short"], 10000);
      } catch (e: any) {
        return `Error: ${e.stderr || e.message || "git command failed"}`;
      }
    },
  },
  {
    name: "gitDiff",
    description: "Show git diff (unstaged changes). No args.",
    execute: async () => {
      const root = currentRoot();
      try {
        const output = gitExec(root, ["diff"], 15000);
        return output || "(no unstaged changes)";
      } catch (e: any) {
        return `Error: ${e.stderr || e.message || "git command failed"}`;
      }
    },
  },
  {
    name: "gitLog",
    description: "Show recent git log. Args: count (default 5)",
    execute: async (args) => {
      const root = currentRoot();
      const count = Math.max(1, Math.min(100, Math.floor(Number(args.count)) || 5));
      try {
        return gitExec(root, ["log", "--oneline", "-n", String(count)], 10000);
      } catch (e: any) {
        return `Error: ${e.stderr || e.message || "git command failed"}`;
      }
    },
  },
  {
    name: "gitBranch",
    description: "Show current branch name. No args.",
    execute: async () => {
      const root = currentRoot();
      try {
        return gitExec(root, ["branch", "--show-current"], 5000).trim();
      } catch (e: any) {
        return `Error: ${e.stderr || e.message || "git command failed"}`;
      }
    },
  },
  {
    name: "gitCreateBranch",
    description: "Create and switch to a new git branch. Args: name",
    execute: async (args) => {
      const root = currentRoot();
      const name = String(args.name ?? "");
      if (!name) return "Error: name is required";
      // 注入面收口:LLM 提供的分支名走白名单(拒绝空格/引号/控制字符/选项注入的 - 前缀/..),
      // 且经 execFileSync 数组传参,绝不进 shell。
      if (!/^[A-Za-z0-9._/-]{1,80}$/.test(name) || name.startsWith("-") || name.includes("..")) {
        return `Error: invalid branch name "${name.slice(0, 80)}" (allowed: letters/digits/._/- , max 80 chars, no leading -)`;
      }
      try {
        const output = gitExec(root, ["checkout", "-b", name], 10000);
        return output || `Switched to new branch '${name}'`;
      } catch (e: any) {
        return `Error: ${e.stderr || e.message || "git command failed"}`;
      }
    },
  },
  {
    name: "checkTypeErrors",
    description: "Check for TypeScript/JS type errors. No args.",
    execute: async () => {
      const root = currentRoot();
      const hasTsc = fs.existsSync(path.join(root, "tsconfig.json"));
      const hasEslint = fs.existsSync(path.join(root, "eslint.config.js"))
        || fs.existsSync(path.join(root, ".eslintrc.js"))
        || fs.existsSync(path.join(root, ".eslintrc.json"));

      const results: string[] = [];
      if (hasTsc) {
        try {
          const out = execSync("npx tsc --noEmit 2>&1", { cwd: root, encoding: "utf-8", timeout: 30000 });
          if (out.trim()) results.push("--- TypeScript ---\n" + out.trim().slice(0, 1000));
          else results.push("TypeScript: no errors");
        } catch (e: any) {
          results.push("--- TypeScript ERRORS ---\n" + (e.stderr || e.stdout || e.message || "").slice(0, 1000));
        }
      }
      if (hasEslint) {
        try {
          const out = execSync("npx eslint . --max-warnings 999 2>&1", { cwd: root, encoding: "utf-8", timeout: 30000 });
          if (out.trim()) results.push("--- ESLint ---\n" + out.trim().slice(0, 1000));
          else results.push("ESLint: no issues");
        } catch (e: any) {
          const errOutput = (e.stderr || e.stdout || e.message || "").slice(0, 1000);
          if (errOutput) results.push("--- ESLint ---\n" + errOutput);
        }
      }
      if (!hasTsc && !hasEslint) return "No TypeScript/ESLint config found in project root.";
      return results.join("\n") || "No diagnostics issues found.";
    },
  },
  {
    name: "runTests",
    description: "Auto-detect and run the project's test suite. No args.",
    execute: async () => {
      // A8 · 复用 runTestsResult(同一套 detectTestCommand,消掉此前重复的框架检测),并在返回文本
      // **首行**输出机器可解析证据头——deriveTestEvidence 来源 b 靠它配对解析;tool_result 事件
      // 只保留前 500 字,首行必然存活。未检测到框架 → 无任何真实执行,不带证据头。
      const res = runTestsResult(currentRoot());
      if (!res.ran) return "No test framework detected in project root.";
      const head = `[test-evidence] command=${res.command} exit=${res.exitCode} passed=${res.passed}`;
      return `${head}\n${res.passed ? res.output : `Tests failed:\n${res.output}`}`;
    },
  },
];

// `root` (optional) confines this tool call to a specific working dir (a worker's worktree),
// carried via AsyncLocalStorage so concurrent calls don't clobber a shared global. Omitting it
// uses the global toolsProjectRoot (back-compat with all existing callers).
export async function runTool(name: string, args: Record<string, string>, root?: string, configRoot?: string): Promise<string> {
  const tool = getActiveTools().find(t => t.name === name);
  // v7 健壮性：工具永不抛错——未知工具/缺文件(ENOENT)/参数错都返回错误字符串给模型，
  // 让它据此调整（例如换路径、改用 writeFile），而不是冒泡成引擎 failed 把整个 run 崩掉。
  if (!tool) return `Error: 未知工具 "${name}"。可用工具见工具列表。`;
  try {
    const execute = () => tool.execute(args);
    if (root && configRoot) return await configRootStore.run(configRoot, () => rootStore.run(root, execute));
    if (root) return await rootStore.run(root, execute);
    if (configRoot) return await configRootStore.run(configRoot, execute);
    return await execute();
  } catch (e: any) {
    return `Error: 工具 ${name} 执行失败: ${e?.message || String(e)}`;
  }
}

// ── Active tool registry = built-in + discovered MCP tools (Phase 5) ──
let mcpToolCache: ToolDef[] = [];

// Re-discover MCP tools from enabled stdio servers (cached for the run). Failures → empty (no MCP).
export async function refreshMcpTools(projectRoot: string): Promise<number> {
  try {
    const { discoverMcpTools, mcpToolToToolDef } = await import("./mcpToolBridge.js");
    const tools = await discoverMcpTools(projectRoot);
    mcpToolCache = tools.map(t => mcpToolToToolDef(t, projectRoot));
  } catch {
    mcpToolCache = [];
  }
  return mcpToolCache.length;
}

export function getActiveTools(): ToolDef[] {
  return [...ALL_TOOLS, ...mcpToolCache];
}

// ── Structured quality-gate primitives (exit-code → pass/fail), used by qualityGate.ts.
// Distinct from the LLM-facing ALL_TOOLS variants which return prose for the model.

function resolveWorkdir(workdir?: string): string {
  return workdir || toolsProjectRoot || resolveSafe(".");
}

export function checkTypeErrorsResult(workdir?: string): { ran: boolean; passed: boolean; output: string } {
  const root = resolveWorkdir(workdir);
  if (!fs.existsSync(path.join(root, "tsconfig.json"))) return { ran: false, passed: true, output: "no tsconfig.json" };
  try {
    execSync("npx tsc --noEmit", { cwd: root, encoding: "utf-8", timeout: 60000, stdio: "pipe" });
    return { ran: true, passed: true, output: "tsc: no type errors" };
  } catch (e: any) {
    const full = (((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "type errors").toString();
    // Prepend an accurate count so it survives the 2000-char slice (tsc's "Found N errors"
    // summary is at the END and would otherwise be cut off, breaking diff-relative gating).
    const out = `Found ${countTsErrors(full)} errors\n${full}`;
    return { ran: true, passed: false, output: compactTestOutput(out, false) };
  }
}

// Count type errors from tsc output: prefer the "Found N error(s)" summary, else count
// distinct "error TSxxxx" occurrences. Used for diff-relative gating (don't increase errors).
export function countTsErrors(output: string): number {
  const summary = output.match(/Found (\d+) error/);
  if (summary) return parseInt(summary[1], 10);
  const matches = output.match(/error TS\d+/g);
  return matches ? matches.length : 0;
}

function detectTestCommand(root: string): string | null {
  if (fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "pyproject.toml"))) return "python -m pytest -q";
  if (fs.existsSync(path.join(root, "vitest.config.ts")) || fs.existsSync(path.join(root, "vitest.config.js"))) return "npx vitest run";
  if (fs.existsSync(path.join(root, "jest.config.ts")) || fs.existsSync(path.join(root, "jest.config.js"))) return "npx jest --passWithNoTests";
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return "cargo test";
  if (fs.existsSync(path.join(root, "go.mod"))) return "go test ./...";
  if (fs.existsSync(path.join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
      if (pkg.scripts?.test) return "npm test --silent";
    } catch { /* ignore */ }
  }
  // 无框架/无 package.json 的裸测试文件(sum.test.js 这类最小任务)故意不在此自动探测:质量门(runTestsResult)
  // 若在此兜底会与 verifier 经 runShell 受限通道的显式测试**双重执行 + 双 TestEvidence**,违反 P0-3/P0-4
  // 单次执行契约与效率闸。裸测试文件由 verifier 显式 `node x.test.js`(P0-4 受限通道)执行,不走 runTests 自动门。
  return null;
}

// A8 · TestEvidence:command/cwd/exitCode/durationMs 加性可选字段——真实执行过(ran=true)才带,
// ran=false(未检测到测试框架)一律缺省,不虚构。exitCode:成功恒 0;失败取 execSync 的 e.status,
// 拿不到(如被信号杀)诚实兜底 1。
export interface TestCommandResult {
  ran: boolean;
  passed: boolean;
  output: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  // P0 · 交付合同绑定:该条测试实际执行的测试文件(相对快照根,POSIX)+ 其快照内容 hash。
  // 只有 runVerifierTestsInSnapshot 的绑定路径会填;框架整套跑/无文件粒度时缺省。
  testedFile?: string;
  testedFileHash?: string;
  // MUP 波2 · Node 解析链证据:该测试执行时实际解析加载的、位于快照根内的非测试文件
  // (path=相对快照根 POSIX,hash=sha256 全量小写 hex)。仅 node 族且记录成功时带;
  // python 族/记录失败 → 缺省(诚实,不虚构)。
  resolvedProducerFiles?: Array<{ path: string; hash: string }>;
}

export function runTestsResult(workdir?: string): TestCommandResult {
  const root = resolveWorkdir(workdir);
  const cmd = detectTestCommand(root);
  if (!cmd) return { ran: false, passed: true, output: "no test framework detected" };
  const startedAt = Date.now();
  try {
    const out = execSync(cmd, { cwd: root, encoding: "utf-8", timeout: 120000, stdio: "pipe" });
    return {
      ran: true, passed: true, output: compactTestOutput((out || "tests passed").toString(), true),
      command: cmd, cwd: root, exitCode: 0, durationMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    const out = ((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "tests failed";
    return {
      ran: true, passed: false, output: compactTestOutput(out.toString(), false),
      command: cmd, cwd: root, exitCode: typeof e.status === "number" ? e.status : 1, durationMs: Date.now() - startedAt,
    };
  }
}

// 一条裸测试文件条目:绝对路径(execSync 用)、相对快照根路径(POSIX,合同绑定/testedFile 用)、语言族。
interface BareTestEntry { command: string; absFile: string; relFile: string; lang: "node" | "python"; }

// P0-3 · Verifier Snapshot 里的裸测试文件探测(浅扫 depth≤2,排除 node_modules/.opc/.git)。返回结构化条目,
// 供合同绑定(runVerifierTestsInSnapshot)与 testedFile 记录用;detectBareTestFiles 保留 string[] 公共签名。
function detectBareTestFileEntries(root: string): BareTestEntry[] {
  const out: BareTestEntry[] = [];
  const SKIP = new Set(["node_modules", ".opc", ".git"]);
  const scan = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      const n = e.name;
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (/\.test\.(?:m|c)?js$/i.test(n) || /\.spec\.(?:m|c)?js$/i.test(n)) out.push({ command: `node "${full}"`, absFile: full, relFile: rel, lang: "node" });
      else if (/\.test\.ts$/i.test(n) || /\.spec\.ts$/i.test(n)) out.push({ command: `npx tsx "${full}"`, absFile: full, relFile: rel, lang: "node" });
      else if (/^test_.*\.py$/i.test(n) || /_test\.py$/i.test(n)) out.push({ command: `python "${full}"`, absFile: full, relFile: rel, lang: "python" });
    }
  };
  scan(root, 0);
  return out;
}

export function detectBareTestFiles(root: string): string[] {
  return detectBareTestFileEntries(root).map((e) => e.command);
}

// P0 · 合同绑定判据已抽成共享 helper(packages/shared/src/contractBinding.ts 的 contractBindsTest/
// testTargetStems),验收门与本快照运行器共用同一判据,并修了目录敏感假阴性(src/sum.js 合同可绑根级
// sum.test.js:stem 匹配按 basename 层与带目录层都试)。

function hashSnapshotFile(absFile: string): string | undefined {
  try { return createHash("sha256").update(fs.readFileSync(absFile)).digest("hex").slice(0, 16); } catch { return undefined; }
}

// P0-3/P0 · 在 Verifier Snapshot(root)里跑测试并收结构化证据,**绑定到本 run 交付合同**。
// contractFiles(本 run 变更文件相对路径)传入 → 绑定模式:只跑属于合同(或直接测试合同源文件)的测试,并
// 记录 testedFile + 快照内容 hash;拒跑共享工作目录里历次遗留的无关测试(否则一条无关变更 + 遗留测试通过 =
// 假成功窗口)。contractFiles 缺省(undefined)→ 旧非绑定行为(兼容既有调用/单测)。
// 框架优先级:node 框架仅当快照真有 node_modules 才跑(经 git checkout-index 播种的快照默认无依赖,避免伪
// 依赖失败误判 test_failed);绑定模式下框架优先"限定到合同测试文件"逐个跑(vitest/jest/pytest 支持传文件),
// 不可限定的框架(cargo/go/npm-script)仅当合同含同语言文件才整套跑,否则退到合同绑定的裸文件。
export function runVerifierTestsInSnapshot(root: string, contractFiles?: string[]): TestCommandResult[] {
  // 普通执行(execSync):跑测试拿 pass/fail + testedFile+hash 绑定。选1(降级·07-14):【绝不产 resolvedProducerFiles】
  // ——"测过 producer 逻辑"的可信证据不存在(进程内钩子被 inspector 提密钥、进程外 CDP 观测器被 vm 逐字节重跑,均可伪造),
  // verified 已退役。独立测试通过 + 交付字节==冻结 manifest(deliveryAcceptance 的 artifact_mismatch 门)= 接受档
  // independent_tests_passed。见 opc-verified-cdp-observer-mandate。
  const runPlain = (cmd: string, relFile?: string, absFile?: string): TestCommandResult => {
    const startedAt = Date.now();
    const hash = absFile ? hashSnapshotFile(absFile) : undefined;
    const bind = relFile ? { testedFile: relFile, ...(hash ? { testedFileHash: hash } : {}) } : {};
    try {
      const out = execSync(cmd, { cwd: root, encoding: "utf-8", timeout: 120000, stdio: "pipe" });
      return { ran: true, passed: true, output: compactTestOutput((out || "tests passed").toString(), true), command: cmd, cwd: root, exitCode: 0, durationMs: Date.now() - startedAt, ...bind };
    } catch (e: any) {
      const out = ((e.stdout || "") + "\n" + (e.stderr || "")).trim() || e.message || "tests failed";
      return { ran: true, passed: false, output: compactTestOutput(out.toString(), false), command: cmd, cwd: root, exitCode: typeof e.status === "number" ? e.status : 1, durationMs: Date.now() - startedAt, ...bind };
    }
  };

  const bound = Array.isArray(contractFiles);
  const bareAll = detectBareTestFileEntries(root);
  // 合同绑定判据走共享 helper(与验收门同口径):verifier 在快照根新建的 sum.test.js 也能绑合同里的 src/sum.js,仍拒纯遗留。
  const admittedBare = bound ? bareAll.filter((b) => contractBindsTest(b.relFile, contractFiles!)) : bareAll;

  const framework = detectTestCommand(root);
  if (framework) {
    const isNodeFramework = /^(?:npx\s+(?:vitest|jest|mocha)|(?:npm|pnpm|yarn)\s)/.test(framework);
    const hasNodeModules = (() => { try { return fs.existsSync(path.join(root, "node_modules")); } catch { return false; } })();
    if (!isNodeFramework || hasNodeModules) {
      if (!bound) return [runPlain(framework)];
      // 绑定模式:把框架限定到"合同绑定的测试文件"逐个跑(每条证据绑一个文件+hash)。框架经 runPlain → 不产强证据(unbound)。
      const scopable =
        /^npx\s+vitest\b/.test(framework) ? (f: string) => `npx vitest run "${f}"`
        : /^npx\s+jest\b/.test(framework) ? (f: string) => `npx jest "${f}"`
        : /^npx\s+mocha\b/.test(framework) ? (f: string) => `npx mocha "${f}"`
        : /^python -m pytest\b/.test(framework) ? (f: string) => `python -m pytest -q "${f}"`
        : null;
      if (scopable) {
        const lang: "node" | "python" = /pytest/.test(framework) ? "python" : "node";
        const files = admittedBare.filter((b) => b.lang === lang);
        // 可限定框架但合同里没有该语言的测试文件 → 诚实空(交独立门判 missing_independent),绝不整套跑遗留测试。
        return files.map((b) => runPlain(scopable(b.relFile), b.relFile, b.absFile));
      }
      // 不可逐文件限定(cargo/go/npm 脚本)在绑定模式下绝不整套跑(防旧测试假通过)——落到下方裸文件路径。
    }
    // node 框架但快照无依赖 → 落到裸文件路径(避免伪依赖解析失败)。
  }
  // 裸测试文件:全部普通执行(execSync)拿 pass/fail + 合同绑定;不产 resolvedProducerFiles(选1 降级)。
  return admittedBare.map((b) => runPlain(b.command, b.relFile, b.absFile));
}
