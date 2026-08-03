import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { contractBindsTest, type FileChange, type RunTestEvidence } from "@opc/shared";

// P0 · DeliveryAcceptance —— 交付验收的【唯一最终门槛】。
// 背景:真实 run 证明系统会把 scratch 临时目录里的文本误判为真实交付(changes.json=[]、workRoot 无文件、
// tests=null,但 run=done、A2A=resolved、memory=committed)。根因是证据层(manifest 诚实记空)与状态层
// (run.status 只看 run.degraded)之间缺一道"真实文件/测试落地"的反馈边。本模块就是那道边:run 状态 /
// A2A resolved / final report / artifact final / memory auto-commit 一律只消费 status==="verified"(或研究型
// 任务的 "not_required")。宪法:证据不足即失败,绝不把 worker 文本产出当作实际文件交付。

export type DeliveryAcceptanceStatus =
  | "verified"                // 编码任务:文件真实落 workRoot + 有真 fileChanges +(要求测试则)TestEvidence exit0
  // 选1(降级·07-14)接受档:独立 verifier 跑了绑定合同的测试且通过 + 交付字节==冻结 manifest(artifact_mismatch 门保证)。
  // 【不声称】测试执行了 producer 逻辑——"测过 producer"的可信证明需完整能力沙箱(禁 vm/eval/_compile,已延期):对抗验证
  // 证明进程内解析链(inspector 提密钥)与进程外 CDP 观测器(vm 逐字节重跑,V8 无法区分 genuine-require)均被伪造。故本档
  // 是当前可如实达成的最高交付信任度(全部由 Core 强制、不可伪造),按 isDeliveryVerified=通过收敛为 done。
  | "independent_tests_passed"
  | "not_required"            // 非编码任务(研究/写作):交付是文本报告,不要求 workRoot 代码文件
  | "no_delivery"             // 编码任务但零 fileChanges(产出未落盘,scratch 假交付的典型)
  | "missing_required_files"  // 声称变更但 workRoot 里文件不存在
  | "missing_test_evidence"   // 要求测试但无真实 TestEvidence(测试从未执行)
  | "test_failed"             // 有 TestEvidence 但 exitCode≠0 / 未通过
  | "missing_independent_verification" // 要求独立验证但无任何独立(verifier)测试证据(producer 自测不算数)
  | "no_producer_source"      // 编码任务但无一个产物来自 producer(非 verifier)——防"验证者创造被验证交付物"的自证
  | "artifact_mismatch"       // MUP Gate A#1:交付文件重算 hash 与 ProducerArtifactManifest 冻结条目不一致(产物被改写/替换)
  | "tests_ran_unbound"       // MUP Gate A#1:测试确已运行(全绿)但无强绑定独立证据——展示"已运行测试·未强绑定",诚实失败,绝不 verified
  | "simulated_run";          // MUP Gate A#2:本 run 含 mock/simulated 模型调用——模拟执行不构成可验证交付,永不 verified

export interface DeliveryAcceptance {
  status: DeliveryAcceptanceStatus;
  requiresCode: boolean;
  requiresTests: boolean;
  reasons: string[];          // 未 verified 时的人类可读原因(进 report/degradedReason;partial 附注也落此)
  missingFiles?: string[];    // missing_required_files 时列出
  // D2 · 本 run 含超时抢救的 partial 产物:验收结果无论何种状态都带此标记(not_required 的"纯净通过"
  // 在此被否定)——调用方据此置 run.partialDelivery 并保证 finalState 至少 degraded。
  partialDelivery?: true;
}

// 文件路径是代码文件的判据(与 parallelExecutor 的 CODE_EXT 同源语义)。
export const CODE_PATH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|swift|kt|vue|svelte|sql|sh|ps1)$/i;

// 任务文本里"要求代码/实现/测试文件/改源码"的信号(中英)。用于 requiresCode 判定——
// 【绝不再依赖 code-review verification edge】(那是可选的"是否加审查",不能决定"是否允许代码落盘")。
const CODE_SIGNAL_RE =
  /代码|源码|源代码|脚本|函数|测试文件|单元测试|改.*源码|修改.*(源码|项目)|实现[^。;\n]{0,12}(函数|方法|类|模块|接口|算法|脚本|程序|功能)|写(一个|个)?(函数|脚本|程序|模块|类)|编写[^。;\n]{0,8}(代码|程序|脚本|测试)|\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|rb|php|cs|swift|kt|vue|svelte)\b|\.test\.|\bunit test|write[^.\n]{0,20}(code|function|script|test|module|class)|implement[^.\n]{0,20}(function|class|module|method|algorithm|api|feature)|create[^.\n]{0,20}\.(js|ts|py|go|rs|java)|fix[^.\n]{0,12}bug|修复[^。\n]{0,8}(bug|缺陷|错误)/i;

// 明确的"研究/写作"任务信号——命中且【无】代码信号时视为非编码(交付是文本报告)。
const RESEARCH_ONLY_RE =
  /^\s*(研究|调研|分析|综述|撰写|写一?[篇份]|输出.*报告|market research|research|analy[sz]e|summar[iy]|write.*(report|article|essay|memo|brief))/i;

// 明确的"不要代码/只做研究"否定式结构化意图——**优先于关键词判断**(见 taskRequiresCode)。修复:
// 此前"不要编写代码""无需代码"这类否定表达里的"编写…代码"会被 CODE_SIGNAL_RE 命中而把研究任务误判成
// 编码 → 研究产出被判 no_delivery。正则不理解否定,故显式识别这些否定/纯研究意图并短路为"非编码"。
// 只匹配明确的否定或"只做研究/只输出报告"意图,绝不误伤"创建 x.js 实现函数""实现快排算法"等真编码任务。
const NO_CODE_RE =
  /不(要|需|用|得)(编写|写|生成|创建|修改|产出|使用)?(任何)?(代码|程序|脚本|源码|文件)|无需(编写|写)?代码|不(涉及|包含|含)代码|不(创建|修改)(或(创建|修改))?(任何)?文件|只(做|需|要|输出|给出|提供).{0,4}(研究|调研|分析|报告|文字|文本)|纯(研究|文本|文字)|\bno code\b|text[- ]only|prose only|research only|(don['’]?t|do not|does ?n['’]?t|no need to)\s+(write|create|generate|modify)(?:\s+or\s+(?:write|create|generate|modify))?\s+(any\s+)?(code|scripts?|files?)|without\s+(writing\s+)?code/i;

// 编码角色(与派单里的工程角色一致)。
const CODER_ROLE_RE = /^(dev|coder|code|engineer|swe|backend|frontend|fullstack|full-stack|programmer|工程师|开发)$/i;

// 测试要求信号。
const TEST_SIGNAL_RE = /测试|单元测试|\btest(s|ing)?\b|\.test\.|\bspec\b|test file|跑.*测试|运行.*测试|确保.*通过/i;

export function isCoderRole(role?: string): boolean {
  return !!role && CODER_ROLE_RE.test(role.trim());
}

// 单一事实源:用户目标是否**显式声明不要代码**(否定式/纯研究意图)。这是全链路"是否编码"判定的**上限(ceiling)**——
// 命中即整条 run 一律非编码,任何子任务措辞都不能把它抬回 coding(修:此前子任务里出现"代码/实现"等词会经
// taskRequiresCode/classifyTaskType 各自重新判成编码 → 注入"写可运行代码" → 研究综合被判 no_delivery)。
// 只认显式否定(NO_CODE_RE),绝不误伤"研究并实现算法"这类真编码——那类没有显式否定,不命中。
export function goalForbidsCode(goal: string): boolean {
  return NO_CODE_RE.test(goal ?? "");
}

// 该子任务是否要求真实代码落盘 → 决定 worker 进 git worktree(可 merge)而非 scratch。
// 由【任务合同 + 预期产物 + 角色】判定,不看 code-review edge(P0-1)。
export function taskRequiresCode(task: string, role?: string, expectedArtifacts?: string[]): boolean {
  const t = task ?? "";
  // (1) 最强信号:显式声明的产物本身就是代码文件 → 必是编码(任何研究/否定措辞都盖不过)。
  if (expectedArtifacts?.some((a) => CODE_PATH_EXT.test(a))) return true;
  // (2) 结构化意图优先于关键词:明确的"不要代码/只做研究/只输出报告"否定式意图 → 非编码(交付是文本)。
  //     必须先于 CODE_SIGNAL_RE,否则"不要编写代码"里的"编写…代码"会被关键词命中而误判编码。
  if (NO_CODE_RE.test(t)) return false;
  // (3) 关键词信号(未被上面的否定意图短路时)。
  if (CODE_SIGNAL_RE.test(t)) return true;
  // (4) 工程角色 + 非"纯研究/写作"任务 → 要求代码(role 是次级信号,研究型任务显式排除,防误判)。
  if (isCoderRole(role) && !RESEARCH_ONLY_RE.test(t)) return true;
  return false;
}

// 该任务是否要求真实测试执行 → 决定 DeliveryAcceptance 是否强制 TestEvidence exit0。
export function taskRequiresTests(task: string, expectedArtifacts?: string[]): boolean {
  const t = task ?? "";
  if (expectedArtifacts?.some((a) => /\.test\.|\.spec\.|_test\./i.test(a))) return true;
  return TEST_SIGNAL_RE.test(t);
}

// P0-3/P0-4 · 验证者(verifier)角色判定。验证者跑在 producer(编码/写作)merge 之后的第二批,worktree
// 从【已 merge 的 workRoot】新建(HEAD 已含 dev 产物),因此能看到 dev 的 sum.js 并跑 node sum.test.js;
// 并获准使用 tools.runShell 的受限测试通道(白名单测试命令、cwd 限 workRoot)。
const VERIFIER_ROLE_RE = /^(test|tester|qa|reviewer|review|code[_-]?reviewer)$/i;

export function isVerifierRole(role?: string): boolean {
  return !!role && VERIFIER_ROLE_RE.test(role.trim());
}

// 该 worker 是否是本 lead 的验证者:①验证角色,或 ②任务要求测试且本身不是编码/产出任务(纯核验)。
// 依赖序:producer 先并行跑+commit+merge 回 workRoot → verifier 后跑(worktree 从 merged workRoot 新建)。
export function isVerifierTask(role: string | undefined, task: string): boolean {
  if (isVerifierRole(role)) return true;
  return taskRequiresTests(task) && !taskRequiresCode(task, role);
}

// #1 · 文本依赖型 worker(综合/事实核查/汇编/主编):它的输入是【其他 worker 的文本产出】,不是文件。
// 这类 worker 若当普通 producer 会和被依赖的研究员同批并发、拿不到输入而空跑;若当 verifier 又只吃文件不吃
// 文本。runWorkersParallel 为它单开一批——排在 producer 批之后,把 producer 的文本产出注入其 prompt,且不受
// "无文件产物就跳过"的文件合同门约束。角色名判定(不匹配 researcher/lead/coder/verifier,零破坏现有团队)。
const TEXT_DEPENDENT_ROLE_RE = /^(synth|synthesi[sz]er?|synthesis|fact[_-]?check(er)?|factchecker|aggregator|editor|compiler|汇编|综合(员|者)?|事实核查(员)?|主编)$/i;
export function isTextDependentWorker(role: string | undefined, task?: string): boolean {
  if (!role) return false;
  if (isVerifierRole(role)) return false; // verifier 优先(它有独立的文件依赖语义)
  if (TEXT_DEPENDENT_ROLE_RE.test(role.trim())) return true;
  // 任务显式声明"综合/汇总/核查各研究员/各成员的产出"也算(措辞信号,保守:需同时出现"综合类动词"+"他人产出")
  const t = (task ?? "").toLowerCase();
  return /(综合|汇总|整合|核查|校对|汇编|synthesi|aggregate|consolidate|fact[- ]?check)/.test(t) &&
    /(各(位)?(研究员|成员|worker)|其他(研究员|成员|worker)|上游|团队(成员)?的?产出|他人的?产出|each (researcher|member|worker)|other (researcher|member|worker)s?|upstream)/.test(t);
}

// MUP Gate A#1 · ProducerArtifactManifest 条目的结构类型(storage/producerManifestStore 的
// ProducerManifestEntry 结构兼容;本模块保持纯判定,不 import store)。
export interface ProducerManifestEntryLike {
  path: string;      // 相对 workRoot POSIX(保留大小写)
  hash: string;      // 冻结时刻 sha256 全量小写 hex(64 位)
  agentId?: string;
  role?: string;
  mergedAt?: string;
}

export interface EvaluateInput {
  requiresCode: boolean;
  requiresTests: boolean;
  workRoot: string;                       // 公司工作根(代码文件真实落盘处,activeWorkRoot)
  allChanges: FileChange[];               // 全部被接受并 merge 回 workRoot 的文件变更
  testEvidence: RunTestEvidence[];        // A8 deriveTestEvidence(worker 真实执行过的测试)
  // MUP Gate A#1(决策①)· 独立验证由任务合同派生:requiresCode && requiresTests 即要求独立验证——
  // 本字段不再是开关(显式 true 仍尊重,false/缺省不再能对"要求测试的编码任务"关闭独立门)。旧语义
  // "verifierAgentIds.size>0 才启用"已废除:没派 tester 的 run 全绿自测最多 tests_ran_unbound,绝不 verified
  // (矩阵4"没有 tester 时诚实失败")。
  requiresIndependentVerification?: boolean;
  producerAgentIds?: string[];            // 非 verifier 的 worker agentId 集合(其证据不算独立)
  verifierAgentIds?: string[];            // verifier 的 worker agentId 集合(其证据兜底判独立)
  // P0 · 本 run 交付合同(变更文件相对路径)。传入即启用【合同覆盖门】:通过的独立测试里至少一条必须绑定
  // 本 run 合同(共享判据 contractBindsTest:测试自身∈合同 或 目标 stem∈合同,与 Verifier Snapshot 运行器
  // 同口径),否则拒——不能把共享工作目录里无关/遗留测试的通过当作本任务完成。⚠️ stem 匹配只是绑定候选面
  // ("测的是不是本合同"),verified 由解析链×产物清单强判据把关,启发式放宽不单独产 verified。
  // 不传(undefined)= 旧行为(不启用覆盖门,兼容既有调用/单测)。
  contractFiles?: string[];
  // MUP Gate A#1 · ProducerArtifactManifest 消费(producerManifestStore 冻结落盘,orchestrator 读回传入)。
  // 传入(含空数组)即启用【清单模式】:
  //   ① producer 来源门改从清单非测试条目派生(任意扩展名——.html/.css/.md 等合法非 CODE_PATH_EXT 交付
  //      不再被计数判据误杀);清单无非测试条目且 verifier 有被接受变更 → no_producer_source;
  //   ② 验收时重算最终 workRoot 各合同文件 sha256 与清单最新条目(同 path 取最新)比对,失配 → artifact_mismatch;
  //   ③ verified 强判据(Node 族):独立测试证据必须有 resolvedProducerFiles 且 ∃ 条目 path∈清单且 hash 与
  //      最新条目一致;Node 族无解析链证据 → 最多 tests_ran_unbound,绝不 verified。
  // 不传(undefined)= 兼容旧调用:退回下方 producerCodeFileCount/producerSourcePaths 启发式判定。
  producerManifestEntries?: ProducerManifestEntryLike[];
  // 清单模式的 no_producer_source 搭档:verifier 贡献的被接受变更数(任意扩展名)。
  verifierChangeFileCount?: number;
  // 【兼容(非清单模式)】producer/verifier 授权的源码文件数(CODE_PATH_EXT 的被接受变更,按贡献者角色计数)。
  // 仅当未传 producerManifestEntries 时生效:producerCodeFileCount===0 && verifierCodeFileCount>0 →
  // no_producer_source。生产路径已改走清单模式(CODE_PATH_EXT 计数对 .html/.css 交付有误杀,已废除)。
  producerCodeFileCount?: number;
  verifierCodeFileCount?: number;
  // Model C(用户决策)· producer 授权的【非测试】来源文件相对路径(清单模式下由 manifest 非测试条目派生)。
  // 传入非空即启用【测试引用门】:提供独立证据的测试文件必须 import/require 至少一个 producer 来源,否则该
  // 证据不算数(自包含测试=验证者藏码)。清单模式下本门仅对非 Node 族(python 等)保留——Node 族由解析链
  // 强判据接管,basename 正则启发式不再能为 Node 产出 verified。不传/空 = 不启用(兼容)。
  producerSourcePaths?: string[];
  // D2(已拍板)· 本 run 存在超时抢救/partial 的 worker 产出。true → 结果附 partialDelivery:true;
  // not_required(非编码)分支因此不再是"纯净通过"。不传 = 旧行为(兼容既有调用/单测)。
  hasPartialSalvage?: boolean;
  // MUP Gate A#2(已拍板)· 本 run 含 mock/simulated 模型调用。true → 直接判 simulated_run,永不 verified
  // (也不给 not_required 的纯净等价态)。不传 = 旧行为。
  simulated?: boolean;
}

// 交付路径归一(POSIX 斜杠 + 去 ./ + 小写),与 tools.ts 快照绑定同口径,供合同覆盖门比对 testedFile∈合同。
function normDeliveryPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// 测试路径判据(与 orchestrator/parallelExecutor 的声明式测试路径同语义):*.test.* / *.spec.* /
// (tests|__tests__)/**。清单模式下 producer 来源 = manifest 里【非】此类路径的条目(任意扩展名)。
const TEST_PATH_RE = /(\.(test|spec)\.[a-z0-9]+$)|(^|\/)(tests?|__tests__)\//i;

export function isTestFilePath(p: string): boolean {
  return TEST_PATH_RE.test(p.replace(/\\/g, "/"));
}

function sha256FileHex(abs: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(abs)).digest("hex"); } catch { return null; }
}

// 清单最新条目(消费方取最新:同 path 归一后多条,后追加者胜)。key=归一小写路径。
function latestManifestHashByPath(entries: ProducerManifestEntryLike[]): Map<string, { path: string; hash: string }> {
  const m = new Map<string, { path: string; hash: string }>();
  for (const e of entries) m.set(normDeliveryPath(e.path), { path: e.path, hash: (e.hash ?? "").toLowerCase() });
  return m;
}

// MUP Gate A#1 · 合同子集 hash 自验:对【合同 ∩ 清单最新条目】重算最终 workRoot 实文件 sha256 与冻结指纹
// 比对。用途:① 验收门的 artifact_mismatch 判定;② A2A resolve / memory commit 等正向消费发生前的
// 消费前子集自验(evidenceManifest 全量自验仍留 run-end 绝对最后,时序铁律不动)。
// 清单为空 → 无基准可比,ok:true(诚实:不虚构失配;清单缺失的 fail-closed 由测试强判据承担)。
export function verifyContractSubsetAgainstManifest(
  workRoot: string,
  contractPaths: string[],
  entries: ProducerManifestEntryLike[],
): { ok: boolean; mismatches: string[] } {
  if (entries.length === 0) return { ok: true, mismatches: [] };
  const latest = latestManifestHashByPath(entries);
  const contractSet = new Set(contractPaths.map(normDeliveryPath));
  const mismatches: string[] = [];
  for (const [key, ent] of latest) {
    if (!contractSet.has(key)) continue;
    const actual = sha256FileHex(path.join(workRoot, ent.path));
    if (actual !== ent.hash) mismatches.push(ent.path);
  }
  return { ok: mismatches.length === 0, mismatches };
}

// 选1(降级·07-14)· "测试真实执行了 producer 冻结产物"的证明【已退役】:曾用运行时解析链证据
// (resolvedProducerFiles ∩ manifest hash)授予 verified,但对抗验证证明该证据【根本不可信】——进程内钩子被
// node:inspector 提密钥、进程外 CDP 观测器被 vm 逐字节重跑(V8 无法区分 genuine-require)双双伪造,连跑不起来
// 的坏 producer 都能伪 verified。可信证明"测过 producer 逻辑"需完整能力沙箱(禁 vm/eval/_compile),已延期。
// 故当前最高交付信任度 = independent_tests_passed(独立测试通过 + artifact 完整性门保证交付字节==冻结 manifest),
// 均由 Core 强制、不可伪造;不再声称 producer 逻辑被有效测试。此常量保留=true 记录"若日后开放该证明必须落在
// 不可伪造的证据上(如完整沙箱),绝不回退到可被伪造的解析链/静态正则"。
export const VERIFIED_REQUIRES_RUNTIME_RESOLUTION_CHAIN = true as const;

// 路径的模块基名(去目录 + 去扩展名,小写):factorial.js→factorial,src/solution.ts→solution。
function moduleBase(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
}

// Model C(用户决策)· 该测试文件是否 import/require 了至少一个 producer 授权的源码。完全自包含的测试
// (自己定义被测逻辑、不引用任何 producer 源码)不算对交付的独立验证——堵"verifier 把实现藏进 *.test.js
// + producer 只交 stub 源码"的自证。按模块基名匹配(容忍相对路径/带不带扩展名)。读不到文件 → 保守判 false。
function testReferencesProducerSource(testAbsPath: string, producerSourcePaths: string[]): boolean {
  let content: string;
  try { content = fs.readFileSync(testAbsPath, "utf-8"); } catch { return false; }
  const specs = new Set<string>();
  // JS/TS:require('x') / import(...'x') / from 'x'
  for (const m of content.matchAll(/(?:require\s*\(\s*|import\s*\(\s*|\bfrom\s+)['"]([^'"]+)['"]/g)) specs.add(m[1]);
  // Python:from X import … / import X
  for (const m of content.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) specs.add(m[1].replace(/\./g, "/"));
  const specBases = new Set([...specs].map(moduleBase));
  return producerSourcePaths.some((src) => specBases.has(moduleBase(src)));
}

// 单一验收判定。宪法诚实性:任一必需条件不满足即返回对应失败状态,绝不"就近判成功"。
// MUP 加性外壳:①simulated 短路(模拟执行永不 verified,引擎层 status=done 的 mock E2E 不受影响——
// run 级 done 由调用方保持,但绝不纯净);②hasPartialSalvage 统一附着 partialDelivery:true。
export function evaluateDeliveryAcceptance(input: EvaluateInput): DeliveryAcceptance {
  if (input.simulated === true) {
    const r: DeliveryAcceptance = {
      status: "simulated_run",
      requiresCode: input.requiresCode,
      requiresTests: input.requiresTests,
      reasons: ["simulated_run:本 run 含 mock/模拟模型调用——模拟执行不构成可验证交付(演示/冒烟用途),永不 verified,不产生记忆/复用/公司知识正向效应"],
    };
    return input.hasPartialSalvage === true ? { ...r, partialDelivery: true } : r;
  }
  const core = evaluateCore(input);
  if (input.hasPartialSalvage === true) {
    return {
      ...core,
      partialDelivery: true,
      reasons: (core.status === "not_required" || core.status === "verified")
        ? [...core.reasons, "含超时抢救的部分产物(partial):文本已保留为部分结果,但不构成纯净交付——run 最终态至少 degraded"]
        : core.reasons,
    };
  }
  return core;
}

function evaluateCore(input: EvaluateInput): DeliveryAcceptance {
  const { requiresCode, requiresTests, workRoot, allChanges, testEvidence } = input;
  const producerIds = new Set(input.producerAgentIds ?? []);
  const verifierIds = new Set(input.verifierAgentIds ?? []);
  // 独立性判据(混合,decision 3):快照权威证据显式 independent:true 优先;API/in-process verifier 靠
  // agentId∈verifierAgentIds 兜底判独立;两种都要求 agentId∉producerAgentIds(producer 自测绝不算独立)。
  const isIndependentEvidence = (e: RunTestEvidence): boolean => {
    if (e.agentId && producerIds.has(e.agentId)) return false;
    return e.independent === true || (!!e.agentId && verifierIds.has(e.agentId));
  };
  if (!requiresCode) {
    return { status: "not_required", requiresCode: false, requiresTests, reasons: [] };
  }
  // ① 编码任务必须有真实文件变更(scratch 假交付在此被堵:fileChanges 被置空 → no_delivery → 失败)。
  if (allChanges.length === 0) {
    return {
      status: "no_delivery",
      requiresCode: true,
      requiresTests,
      reasons: ["编码任务无任何被接受的文件变更(产出未落盘/未 merge 回 workRoot,不能把 worker 文本当作文件交付)"],
    };
  }
  // ①' producer 来源门。清单模式(传了 producerManifestEntries):producer 来源 = ProducerArtifactManifest
  // 的【非测试】条目(任意扩展名)——.html/.css/.md 等合法非 CODE_PATH_EXT 交付不再被计数判据误杀(矩阵2);
  // 清单无任何非测试 producer 产物且 verifier 有被接受变更 → 疑似 verifier 自建产物自证 → no_producer_source。
  // 兼容模式(未传清单):维持 CODE_PATH_EXT 计数判据(存量调用/单测)。
  const manifestEntries = input.producerManifestEntries;
  if (manifestEntries !== undefined) {
    const producerNonTest = manifestEntries.filter((e) => !isTestFilePath(e.path));
    if (producerNonTest.length === 0 && (input.verifierChangeFileCount ?? 0) > 0) {
      return {
        status: "no_producer_source",
        requiresCode: true,
        requiresTests,
        reasons: ["产物清单(ProducerArtifactManifest)里没有任何来自 producer 的非测试产物,而 verifier 有被接受的变更——验证者不得创造被验证的交付物;疑似 producer 零产物、verifier 自建文件自证"],
      };
    }
  } else if (input.producerCodeFileCount === 0 && (input.verifierCodeFileCount ?? 0) > 0) {
    return {
      status: "no_producer_source",
      requiresCode: true,
      requiresTests,
      reasons: ["编码任务的代码文件全部来自验证者、无一来自 producer——验证者不得创造被验证的交付物;疑似 producer 零产物、verifier 自建源码+测试的自证"],
    };
  }
  // ② 声称变更的文件必须真实存在于最终 workRoot(delete 变更除外)。
  const missingFiles = allChanges
    .filter((c) => c.changeType !== "delete")
    .map((c) => c.path)
    .filter((p) => {
      try { return !fs.existsSync(path.join(workRoot, p)); } catch { return true; }
    });
  if (missingFiles.length > 0) {
    return {
      status: "missing_required_files",
      requiresCode: true,
      requiresTests,
      reasons: [`声称变更但最终 workRoot 里不存在的文件: ${missingFiles.slice(0, 10).join(", ")}${missingFiles.length > 10 ? " …" : ""}`],
      missingFiles,
    };
  }
  // ②' MUP Gate A#1 · 产物清单 hash 复核:重算最终 workRoot 各合同文件 sha256,与清单最新条目(同 path
  // 取最新)比对,失配 → artifact_mismatch——producer 完成后被改写/替换的交付不可信,fail-closed。
  if (manifestEntries !== undefined && manifestEntries.length > 0) {
    const contractPaths = input.contractFiles?.length
      ? input.contractFiles
      : allChanges.filter((c) => c.changeType !== "delete").map((c) => c.path);
    const sub = verifyContractSubsetAgainstManifest(workRoot, contractPaths, manifestEntries);
    if (!sub.ok) {
      return {
        status: "artifact_mismatch",
        requiresCode: true,
        requiresTests,
        reasons: [`交付文件重算 hash 与 ProducerArtifactManifest 冻结指纹不一致: ${sub.mismatches.slice(0, 10).join(", ")}${sub.mismatches.length > 10 ? " …" : ""} —— producer 完成后产物被改写/替换,交付不可信`],
      };
    }
  }
  // ③ 要求测试时:MUP Gate A#1(决策①)独立验证由任务合同派生——requiresCode && requiresTests 即要求,
  // 不再取决于"是否恰好派了 verifier"。最终 pass/fail 以**独立证据**为准(忽略 producer 自测的 fail,dev
  // 本地迭代失败不阻塞);无强绑定独立证据时,自测确实全绿 → tests_ran_unbound(展示"已运行测试·未强绑定",
  // 诚实失败),绝不 verified。
  if (requiresTests) {
    const independent = testEvidence.filter(isIndependentEvidence);
    const passingIndependent = independent.filter((e) => e.passed && e.exitCode === 0);
    if (passingIndependent.length > 0) {
      // P0 · 合同覆盖门(传了 contractFiles 才启用):通过的独立测试里**至少一条**必须绑定本 run 交付合同
      // (contractBindsTest,与快照运行器同判据)。否则一律拒——**绝不用工作区遗留测试兜底**。
      if (input.contractFiles && input.contractFiles.length > 0) {
        const inContract = passingIndependent.filter((e) => e.testedFile && contractBindsTest(e.testedFile, input.contractFiles!));
        if (manifestEntries !== undefined) {
          // 选1(降级·07-14):verified 曾要求"解析链证据×清单 hash 交叉(resolvedProducerFiles)证明测试执行了 producer"。
          // 对抗验证证明该证据【根本不可信】——进程内(inspector 提密钥)与进程外 CDP 观测器(vm 逐字节重跑,V8 无法区分
          // genuine-require)均被伪造,连跑不起来的坏 producer 都能伪 verified。故【不再】以它授予 verified(见状态类型注释)。
          // 已如实达成且不可伪造的:artifact_mismatch 门(上方)保证交付字节==冻结 manifest + 独立 verifier 跑绑定合同测试且通过。
          // 据实收 independent_tests_passed(接受档,honest 不声称"测过 producer 逻辑")。
          if (inContract.length > 0) {
            const files = [...new Set(inContract.map((e) => e.testedFile).filter(Boolean))].slice(0, 5);
            return {
              status: "independent_tests_passed",
              requiresCode: true,
              requiresTests: true,
              reasons: [`独立测试通过并绑定合同(${files.join(", ")}),交付字节==冻结 producer manifest(artifact 完整性门已过)。注:当前不证明测试执行了 producer 逻辑——该证明需完整能力沙箱(已延期),不构成 verified`],
            };
          }
        } else {
          // 兼容模式(未传清单,存量调用/单测):维持既有 Model C 引用门 + 合同绑定判定。
          const enforceRef = !!input.producerSourcePaths && input.producerSourcePaths.length > 0;
          const covering = enforceRef
            ? inContract.filter((e) => testReferencesProducerSource(path.join(workRoot, e.testedFile!), input.producerSourcePaths!))
            : inContract;
          if (covering.length > 0) {
            return { status: "verified", requiresCode: true, requiresTests: true, reasons: [] };
          }
          // 自包含拒因(Model C)优先如实标注:测试覆盖了合同但没引用任何 producer 源码。
          if (enforceRef && inContract.length > 0) {
            return {
              status: "missing_independent_verification",
              requiresCode: true,
              requiresTests: true,
              reasons: [`独立测试覆盖了合同文件但均未 import/require 任何 producer 源码(疑似自包含测试/验证者把实现藏进测试文件): ${inContract.map((e) => e.testedFile).slice(0, 5).join(", ")} —— 独立验证必须真实执行 producer 的源码`],
            };
          }
        }
        const withTarget = [...new Set(passingIndependent.map((e) => e.testedFile).filter(Boolean))].slice(0, 5);
        const detail = withTarget.length > 0
          ? `独立测试通过但均未覆盖本 run 交付文件(testedFile∉合同): ${withTarget.join(", ")}`
          : `独立测试通过但无一条能关联到本 run 交付文件(证据缺 testedFile,可能是整套遗留测试的假通过)`;
        return {
          status: "missing_independent_verification",
          requiresCode: true,
          requiresTests: true,
          reasons: [`${detail} —— 不能用工作区遗留测试兜底,把无关测试的通过当作本任务完成`],
        };
      }
      return { status: "verified", requiresCode: true, requiresTests: true, reasons: [] };
    }
    if (independent.length === 0) {
      // 无任何独立证据:先区分"测试从未执行"与"自测跑了"。
      if (testEvidence.length === 0) {
        return {
          status: "missing_test_evidence",
          requiresCode: true,
          requiresTests: true,
          reasons: ["任务要求测试,但无任何真实 TestEvidence(测试从未执行——不能用测试 Agent 的自然语言确认替代真实测试)"],
        };
      }
      const failed = testEvidence.filter((e) => !e.passed || (typeof e.exitCode === "number" && e.exitCode !== 0));
      if (failed.length > 0) {
        const cmds = [...new Set(failed.map((e) => e.command).filter(Boolean))].slice(0, 5);
        return {
          status: "test_failed",
          requiresCode: true,
          requiresTests: true,
          reasons: [`测试未通过(exitCode≠0): ${failed.length} 项${cmds.length ? ` — ${cmds.join("; ")}` : ""}`],
        };
      }
      // MUP Gate A#1(决策①)· 自测确实全绿——如实展示"已运行测试",但 producer 自测不构成独立强绑定证据
      // (矩阵4:没有 tester 时诚实失败),绝不 verified。
      return {
        status: "tests_ran_unbound",
        requiresCode: true,
        requiresTests: true,
        reasons: ["已运行测试·未强绑定:仅有 producer 自测证据(全绿),无任何独立(verifier)强绑定证据——合同派生的独立验证要求未满足,producer 自测不算数"],
      };
    }
    const cmds = [...new Set(independent.map((e) => e.command).filter(Boolean))].slice(0, 5);
    return {
      status: "test_failed",
      requiresCode: true,
      requiresTests: true,
      reasons: [`独立验证未通过(exitCode≠0): ${independent.length} 项独立测试证据均失败${cmds.length ? ` — ${cmds.join("; ")}` : ""}`],
    };
  }
  return { status: "verified", requiresCode: true, requiresTests, reasons: [] };
}

// 便捷判据:是否算"已验证交付"(verified 或非编码的 not_required)——A2A resolve / memory auto-commit 的门。
// 入参放宽为只读 status 的结构类型:Run.deliveryAcceptance 是 shared 里的结构化字段(status:string),兼容。
export function isDeliveryVerified(a: { status: string } | undefined | null): boolean {
  // 选1(降级·07-14):independent_tests_passed 是当前可如实达成的最高交付信任度(独立测试通过+交付字节==冻结产物,
  // 均 Core 强制不可伪造),收敛为通过。verified 保留在类型里但当前无路径产出(执行观测证据不可信,已退役)。
  return a?.status === "verified" || a?.status === "independent_tests_passed" || a?.status === "not_required";
}

// ── MUP Gate A · run 终态单一收敛 ──────────────────────────────────────────────
// run-end 的唯一出口:一切加性信号(deliveryAcceptance / degraded / partialDelivery / 未决合并冲突 /
// simulated / 证据完整性)在此收敛为一个 finalState。status 四态契约与 toContractRunStatus 冻结不动——
// finalState 是加性字段,旧 run 无此字段 = 安全降级(消费方按缺省处理,不虚构)。
// 优先级:requires_review > failed > degraded > verified;simulated run 永不 verified。
// "done + degraded"(证据自验失败等)不再是矛盾态:finalState=degraded 是权威终态语义。
// 选1(降级·07-14):tests_passed=独立测试通过的编码交付(诚实终态,不声称"验证了 producer 逻辑")。
// verified 保留供旧 run + 非编码 not_required 兼容;执行观测 verified 已退役,新编码 run 不再收敛到 verified。
export type FinalRunState = "verified" | "tests_passed" | "degraded" | "failed" | "requires_review";

export interface FinalRunStateInput {
  status: string;                                   // run.status(RunStatus 宽入;收尾才调用,非 done 即失败)
  deliveryAcceptance?: { status: string } | null;
  degraded?: boolean;
  partialDelivery?: boolean;
  hasUnresolvedConflict?: boolean;                  // worker merge 冲突或 run 分支 merge-back 冲突(分支保留待人工)
  simulated?: boolean;
  evidenceIntegrity?: string;                       // "ok" | "degraded"(缺省按 ok)
}

export function deriveFinalRunState(i: FinalRunStateInput): FinalRunState {
  if (i.hasUnresolvedConflict === true) return "requires_review";
  if (i.status !== "done") return "failed";
  if (i.simulated === true) return "degraded";      // simulated 永不 verified(引擎层 done 保住,终态诚实降级)
  if (i.degraded === true || i.partialDelivery === true) return "degraded";
  if (i.evidenceIntegrity === "degraded") return "degraded";
  if (!isDeliveryVerified(i.deliveryAcceptance ?? undefined)) return "degraded";
  // 选1(降级):独立测试通过的编码交付收敛为 tests_passed(诚实=独立测试通过,前端显"独立测试通过",绝不显"已验证生产逻辑");
  // 非编码 not_required(及旧 run 的 verified)仍收 verified(前端文案已改"已完成",非"已验证")。执行观测 verified 已退役。
  if (i.deliveryAcceptance?.status === "independent_tests_passed") return "tests_passed";
  return "verified";
}
