// A5(重构指南 §4.7 Quality Gate 三层统一编排):把此前散落在 orchestrator.ts 各处的
//   L1 机械(workerArtifactGate.checkWorkerArtifact)
//   L2 结构(artifactContract.validateArtifact,含 ajv json_schema)
//   L3 语义(现有 verifier → reviewCommit 四态裁决)
// 三次独立调用收拢为一个入口 runQualityGateLayers,产出统一的三层聚合结果对象。
//
// 职责边界:本模块只做"聚合与报告",不重造任何一层的判断逻辑——
//   - L1/L2 仍是 checkWorkerArtifact / validateArtifact 的直接复用；
//   - L3 不在本模块内发起 LLM 调用或重新裁决:调用方(orchestrator)先照现状跑完 verifier
//     并把结果交给 reviewCommit(decideReview/commitReview,A1 既有的 Core 裁决者)算出
//     ReviewDecision,再把这个 decision 喂给本模块——reviewCommit 仍是唯一的最终裁决者，
//     "AI Reviewer gives judgment. Studio Core commits status." 的原则不因本次聚合改变。
import type { ArtifactContract } from "./artifactContract.js";
import { validateArtifact } from "./artifactContract.js";
import { checkWorkerArtifact } from "./workerArtifactGate.js";
import type { ReviewDecision } from "./reviewCommit.js";
import type { GovernanceLevel } from "./runGovernance.js";

export type QualityGateLayer = 1 | 2 | 3;
export type QualityGateLayerName = "mechanical" | "structural" | "semantic";

export interface QualityGateLayerResult {
  layer: QualityGateLayer;
  name: QualityGateLayerName;
  passed: boolean;
  /** 该层本次是否被跳过(未配置该层的检查依据,或因短路策略未执行)。跳过不计入失败。 */
  skipped?: boolean;
  reason: string;
  details?: unknown;
}

export interface QualityGateLayersResult {
  passed: boolean;
  /** 三层中最先未通过的层号；全部通过(或被跳过)则不设。 */
  failedLayer?: QualityGateLayer;
  layerResults: QualityGateLayerResult[];
  overallReason: string;
  /** E3→A5 合流:本次门控是在哪个 governance level 下跑的(未接治理的旧调用点不设)。 */
  governanceLevel?: GovernanceLevel;
}

export interface QualityGateLayersInput {
  /** L1 机械检查目标:worker 产出全文(content + 落盘文件内容拼接)。 */
  content: string;
  /** L1 可扩展子检查:result.json 原始字符串。未提供则跳过该子检查(向后兼容,不新增失败面)。 */
  resultJson?: string;
  /** L2 结构契约。未提供则该层视为"未配置"(跳过,不计入失败)——不是每个调用点都有现成契约。 */
  artifactContract?: ArtifactContract;
  /**
   * L3 语义裁决。由调用方先跑现状 verifier 流程、经 reviewCommit(decideReview/commitReview)
   * 算出 ReviewDecision 再传入；未提供则该层视为"未接语义审查"(跳过,不计入失败)——
   * 例如公司未声明 verification_edges 的 run,压根没有 L3 判断依据。
   */
  reviewDecision?: ReviewDecision;
  /**
   * E3→A5 合流点:Run Governance 判出的监督等级决定 gate 强度。
   * 未提供 / L0 / L1 → 与既有行为逐字节一致(所有旧调用点/测试零变化);
   * L2 / L3 → 机械层在"非空"之外额外要求最低实质长度(见 HIGH_GOVERNANCE_MIN_CHARS)——
   * 高监督 run(外部工具面/shell)的产出不允许是 "ok"/"done" 这类空转短语。
   * 仍只影响 L1 机械层的确定性判断,reviewCommit 依旧是唯一的语义最终裁决者。
   */
  governanceLevel?: GovernanceLevel;
  /**
   * P0(用户活体抓出):本 worker 是否是验证者(tester/qa/reviewer 或纯核验任务)。验证者的产出天然是**短**的
   * (测试通过摘要、退出码确认),其有效性由真实 TestEvidence + 交付合同覆盖率(DeliveryAcceptance 独立验证门)
   * 判定,**绝不能因文本过短被高监督 min-chars 规则判失败**——否则 tester 短输出被拒→测试根本没进执行→run 假失败。
   * 缺省 false=生产者:仍受 min-chars 约束(高监督 run 里生产者产出 "ok"/"done" 是空转)。
   */
  isVerifier?: boolean;
}

// L2/L3 下机械层的最低实质长度(去空白后)。刻意保守:正常最小交付(哪怕一段话)远超此值,
// 只拦"ok"/"done"/单行敷衍——这些在高监督 run 里几乎必然是空转产出。
const HIGH_GOVERNANCE_MIN_CHARS = 20;

function runLayer1(content: string, resultJson?: string, governanceLevel?: GovernanceLevel, isVerifier?: boolean): QualityGateLayerResult {
  const mech = checkWorkerArtifact(content);
  if (!mech.passed) {
    return { layer: 1, name: "mechanical", passed: false, reason: mech.reason, details: mech };
  }
  // P0:验证者豁免 min-chars——tester/qa 的产出天然短(测试摘要/退出码),其有效性由 TestEvidence + 合同覆盖率
  // (DeliveryAcceptance 独立验证门)判定;若在此因文本短被拒,测试根本进不了执行,run 会假失败(用户活体抓出)。
  if (!isVerifier && (governanceLevel === "L2" || governanceLevel === "L3")) {
    const substance = content.replace(/\s/g, "").length;
    if (substance < HIGH_GOVERNANCE_MIN_CHARS) {
      return {
        layer: 1, name: "mechanical", passed: false,
        reason: `governance ${governanceLevel} 强化门:产出实质内容过短(${substance} < ${HIGH_GOVERNANCE_MIN_CHARS} 字)`,
        details: { governanceLevel, substanceChars: substance },
      };
    }
  }
  if (resultJson !== undefined) {
    try {
      JSON.parse(resultJson);
    } catch (e: any) {
      return {
        layer: 1, name: "mechanical", passed: false,
        reason: `result.json 不是合法 JSON: ${e?.message ?? e}`,
        details: { resultJsonValid: false },
      };
    }
  }
  return { layer: 1, name: "mechanical", passed: true, reason: "机械检查通过" };
}

function runLayer2(content: string, contract?: ArtifactContract): QualityGateLayerResult {
  if (!contract) {
    return { layer: 2, name: "structural", passed: true, skipped: true, reason: "未配置结构契约(L2 本次调用点未接入)" };
  }
  const vr = validateArtifact(content, contract);
  if (!vr.passed) {
    return { layer: 2, name: "structural", passed: false, reason: vr.failures[0] ?? "结构校验未通过", details: vr };
  }
  return { layer: 2, name: "structural", passed: true, reason: "结构校验通过", details: vr };
}

function runLayer3(decision?: ReviewDecision): QualityGateLayerResult {
  if (!decision) {
    return { layer: 3, name: "semantic", passed: true, skipped: true, reason: "未接语义审查(无 reviewDecision)" };
  }
  // effect 是 reviewCommit 的四态裁决在"是否放行"上的落点(requires_human_review 也可能 effect=pass,
  // 见 reviewCommit.ts 的现状降级路径)——L3 是否"通过"以 effect 为准,status 原样透传进 details 供排查。
  const passed = decision.effect === "pass";
  return { layer: 3, name: "semantic", passed, reason: decision.reason, details: decision };
}

// 分阶段短路策略(选定并说明,而非"全跑聚合"):L1 失败 → 不跑 L2/L3；L2 失败 → 不跑 L3。
// 理由:L1/L2 是纯程序判断,发现产出本身是空/垃圾或结构不达标时,再去花 ajv 结构校验成本、
// 更别提 L3 常牵动 orchestrator 里最贵的一步(一次真实 LLM runViaEngine 调用)去做语义审查，
// 纯属浪费——L1/L2 已经能给出确定性的失败原因，没必要让后续层陪跑。反之，某层通过则继续下一层。
export function runQualityGateLayers(input: QualityGateLayersInput): QualityGateLayersResult {
  const governanceLevel = input.governanceLevel;
  const l1 = runLayer1(input.content, input.resultJson, governanceLevel, input.isVerifier);
  if (!l1.passed) {
    const layerResults: QualityGateLayerResult[] = [
      l1,
      { layer: 2, name: "structural", passed: true, skipped: true, reason: "跳过:L1 未通过" },
      { layer: 3, name: "semantic", passed: true, skipped: true, reason: "跳过:L1 未通过" },
    ];
    return { passed: false, failedLayer: 1, layerResults, overallReason: l1.reason, governanceLevel };
  }

  const l2 = runLayer2(input.content, input.artifactContract);
  if (!l2.passed) {
    const layerResults: QualityGateLayerResult[] = [
      l1, l2,
      { layer: 3, name: "semantic", passed: true, skipped: true, reason: "跳过:L2 未通过" },
    ];
    return { passed: false, failedLayer: 2, layerResults, overallReason: l2.reason, governanceLevel };
  }

  const l3 = runLayer3(input.reviewDecision);
  const layerResults: QualityGateLayerResult[] = [l1, l2, l3];
  if (!l3.passed) {
    return { passed: false, failedLayer: 3, layerResults, overallReason: l3.reason, governanceLevel };
  }

  return { passed: true, layerResults, overallReason: "三层质量门全部通过", governanceLevel };
}

const LAYER_NAME_ZH: Record<QualityGateLayerName, string> = { mechanical: "机械", structural: "结构", semantic: "语义" };

/** 失败摘要(供 latestOutput 占位文案/deferred.lastError/agent_deferred 事件引用):从结构化
 *  layerResults 定位失败层(层号+层名+该层 reason),而非只截一句 overallReason。通过时原样返回。 */
export function formatGateFailure(r: QualityGateLayersResult): string {
  const failed = r.layerResults.find(l => !l.passed && !l.skipped);
  if (r.passed || !failed) return r.overallReason;
  return `L${failed.layer} ${LAYER_NAME_ZH[failed.name]}层未通过: ${failed.reason}`;
}

/** quality_gate_result 事件 payload:三层聚合结果 + 调用方补充的定位上下文。 */
export type QualityGateResultEventPayload = QualityGateLayersResult & {
  /** 被判定的产出归属方(worker/producer agentId)。 */
  producer?: string;
  /** 本次调用发生的阶段:admission=worker 产出准入(round 内即时门控),cross_verify=交叉验证(L3 语义边)。 */
  stage?: "admission" | "cross_verify";
  /** cross_verify 阶段:命中的验证边方法。 */
  method?: string;
  /** cross_verify 阶段:执行语义审查的 verifier agentId。 */
  verifierId?: string;
};
