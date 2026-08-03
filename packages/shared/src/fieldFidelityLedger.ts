// P0 Part B · Field-Fidelity Ledger —— 模板/公司分享保真的"逐字段判定台账"。
//
// 用途:对比【源公司的每个可移植设计字段】与【往返后(导出→导入→再导出 / 公司→工坊→保存→社区往返)
// 的结果】,把每个字段归入五类之一,并把"静默丢失"这条最危险的路径显式量化为 lost:
//   · preserved                —— 原样带回(语义等值)。
//   · intentionally_transformed —— 按设计有意改变:新 ID / 时间戳 / 运行态复位 / 本机路径重映射 / 密钥剥离。
//   · requires_local_setup     —— 作为"需接收方本机配置"的声明带回(provider key / MCP / generic CLI 命令)。
//   · approved_after_import    —— 导入默认安全安装时按设计降权,但显式进入"逐项批准队列"(不是静默消失)。
//   · lost                     —— 静默消失。**产品硬约束:lost 最终必须为 0**,除非该字段被明确声明为不可移植
//                                 (且此时应归入 intentionally_transformed 的 path/secret 类,而非 lost)。
//
// 关键设计:每个字段用 FieldSpec 显式声明其【预期归属 + 证据】,classifyField 校验往返后的真实行为是否
// 兑现了这个预期——**任何一个"本该保真却没保真""本该降权入队却没入队""本该带声明却连声明都没了"的字段,
// 一律降级判为 lost**。因此本台账不是"给通过找借口"的白名单,而是"抓静默丢失"的执法机构:测试断言
// ledger.lost 为空即"零静默丢失"。纯函数、无副作用、无 fs/网络依赖,server 与 web 两侧测试共用。

export type FidelityCategory =
  | "preserved"
  | "intentionally_transformed"
  | "requires_local_setup"
  | "approved_after_import"
  | "lost";

// intentionally_transformed 的合法子类(用于人读的证据说明;缺省不给则该字段的"有意改变"不被承认 → 判 lost)。
export type TransformKind = "new-id" | "timestamp" | "runtime-reset" | "path-remap" | "secret-removed";

export interface FieldSpec {
  /** 人读字段路径,如 "agents.dev.claudeCodeUseApiKey" / "company.visibilityPolicy"。 */
  field: string;
  /** 该字段【应当】落入的类别(不含 lost —— lost 只能是"预期没兑现"时的判定结果,不能被预期)。 */
  expect: Exclude<FidelityCategory, "lost">;
  /** 源公司上的值。 */
  source: unknown;
  /** 往返后的值(再导出物 / 安装后公司)。 */
  roundTrip: unknown;
  /** intentionally_transformed 必填:声明这是哪种有意改变;缺省则拒绝承认"改变合理" → 判 lost。 */
  transformKind?: TransformKind;
  /** requires_local_setup 必填:承载该需求的"声明"(如 required_secrets 条目 / redacted_fields 条目 / mcpRequirements);
   *  为空 = 字段没了且连声明都没留下 → 静默丢失 → 判 lost。 */
  declaredIn?: unknown;
  /** approved_after_import 必填:导入降权时该项被登记进的"逐项批准队列"(如 safeInstall.stripped)。 */
  approvalQueue?: unknown[];
  /** approved_after_import 必填:在 approvalQueue 中定位本项的谓词;命中 = 已入队待批准(非静默),否则判 lost。 */
  approvalMatch?: (queueItem: unknown) => boolean;
  note?: string;
}

export interface FieldVerdict {
  field: string;
  expected: FidelityCategory;
  actual: FidelityCategory;
  ok: boolean; // 已兑现预期(且从不静默丢失)
  reason: string;
  source: unknown;
  roundTrip: unknown;
}

export interface FidelityLedger {
  verdicts: FieldVerdict[];
  counts: Record<FidelityCategory, number>;
  /** 静默丢失的字段(产品硬约束:必须为空)。 */
  lost: FieldVerdict[];
  /** 判定与预期不符的字段(含 lost 以及"预期入队却没入队"等);测试可据此断言全部兑现。 */
  unmet: FieldVerdict[];
  /** 保真率 = preserved / 总字段数(供验收报告引用)。 */
  preservedRate: number;
}

// 顺序无关的深比较(对象按 key 集合比,数组按序比;undefined 与"缺键"经属性访问都取到 undefined,视为相等
// —— 与 JSON 往返"undefined 字段被剥离"的真实行为一致)。
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? String(v)).slice(0, 80);
}

export function classifyField(spec: FieldSpec): FieldVerdict {
  const base = { field: spec.field, expected: spec.expect, source: spec.source, roundTrip: spec.roundTrip };
  const equal = deepEqual(spec.source, spec.roundTrip);
  const ok = (actual: FidelityCategory, reason: string): FieldVerdict => ({ ...base, actual, ok: true, reason });
  const lost = (reason: string): FieldVerdict => ({ ...base, actual: "lost", ok: false, reason });

  switch (spec.expect) {
    case "preserved":
      // 本该保真:等值即兑现;不等值 = "经工坊/往返静默丢字段"的病灶,一律判 lost。
      return equal
        ? ok("preserved", spec.note ?? "往返后与源逐字段一致")
        : lost(`本应保真但往返后不一致(源=${short(spec.source)} 往返=${short(spec.roundTrip)})`);

    case "requires_local_setup":
      // 作为"需接收方本机配置"的声明带回:只要声明在(required_secrets / redacted_fields / mcpRequirements 条目),
      // 就算兑现(值可能等值=声明原样带回,也可能不等值=本机字段被剥离但留了声明);声明也没了才是静默丢失。
      return isEmpty(spec.declaredIn)
        ? lost("字段未带回且无任何'需本机配置'声明 —— 静默丢失")
        : ok("requires_local_setup", spec.note ?? "作为'需接收方本机配置'的声明带回");

    case "intentionally_transformed":
      // 有意改变:恰好没变也不算丢失(记 preserved);真变了必须声明 transformKind,否则视为静默丢失。
      if (equal) return ok("preserved", "预期有意改变但值恰好未变(非丢失)");
      return spec.transformKind
        ? ok("intentionally_transformed", spec.note ?? `按设计有意改变:${spec.transformKind}`)
        : lost("值发生改变但未声明 transformKind —— 视为静默丢失");

    case "approved_after_import": {
      // 默认安全安装降权:若该项未被降权(等值)= 已保留;若被降权(不等值),必须能在逐项批准队列里定位到,
      // 否则就是静默消失。
      if (equal) return ok("preserved", "该项未被降权(已保留)");
      const found = (spec.approvalQueue ?? []).some((q) => (spec.approvalMatch ? spec.approvalMatch(q) : false));
      return found
        ? ok("approved_after_import", spec.note ?? "默认安全安装下降权,已入队待逐项批准(非静默消失)")
        : lost("导入降权但未进入逐项批准队列 —— 静默丢失");
    }
  }
}

export function buildLedger(specs: FieldSpec[]): FidelityLedger {
  const verdicts = specs.map(classifyField);
  const counts: Record<FidelityCategory, number> = {
    preserved: 0, intentionally_transformed: 0, requires_local_setup: 0, approved_after_import: 0, lost: 0,
  };
  for (const v of verdicts) counts[v.actual]++;
  const lost = verdicts.filter((v) => v.actual === "lost");
  const unmet = verdicts.filter((v) => !v.ok);
  const preservedRate = verdicts.length ? counts.preserved / verdicts.length : 1;
  return { verdicts, counts, lost, unmet, preservedRate };
}

// 人读一行摘要(测试 console.log / 报告引用)。
export function formatLedger(ledger: FidelityLedger): string {
  const c = ledger.counts;
  return (
    `[field-fidelity] 字段=${ledger.verdicts.length} ` +
    `preserved=${c.preserved} transformed=${c.intentionally_transformed} ` +
    `requires_local_setup=${c.requires_local_setup} approved_after_import=${c.approved_after_import} ` +
    `lost=${c.lost} 保真率=${(ledger.preservedRate * 100).toFixed(1)}%` +
    (ledger.lost.length ? ` 丢失字段=${JSON.stringify(ledger.lost.map((v) => v.field))}` : "")
  );
}

// ── 完整性兜底:防"台账漏列某字段 → 该字段静默变了也发现不了" ─────────────────────────
// 对两份导出物做深度叶子比对,返回不一致的叶子路径。链路测试在显式台账之外再跑一遍此兜底:
// 每条不一致路径必须被"身份/时间戳/有意转换"白名单解释掉,否则说明有未登记字段在静默漂移。
export function diffLeafPaths(a: unknown, b: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    const xo = x !== null && typeof x === "object" && !Array.isArray(x);
    const yo = y !== null && typeof y === "object" && !Array.isArray(y);
    if (xo && yo) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], p ? `${p}.${k}` : k);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const len = Math.max(x.length, y.length);
      for (let i = 0; i < len; i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    if (!deepEqual(x, y)) out.push(p);
  };
  walk(a, b, prefix);
  return out;
}
