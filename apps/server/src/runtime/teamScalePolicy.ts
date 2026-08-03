// 效率治理 · 团队规模建议(纯函数,零 IO,零模块状态)。
//
// 背景:通宵实验里同一道"单文件纯函数"级任务也常被铺成 CEO + 多 lead + 多 dev + reviewer 的满编团队,
// 每多一个团队/成员就多一轮 lead 拆解、peer 通道、跨团队综合与评审——简单任务的 token/延迟主要浪费源。
// orchestrator 已有 classifyTaskScale(trivial/default/expand)+ clampLeadsForScale 做机器级钳制,但那只裁
// "团队/worker 数量",没有把"这道任务到底最少需要哪些角色"表达成一个可复用、可单测、可被 orchestrator
// 接线的建议对象。本模块补这一层:给定 goal + 已分类的 taskScale + 是否要求测试,产出一个**建议**(不是命令)——
//   - trivial 编码任务  → 单 coder(要求测试则 + 1 tester),不铺 CEO/Lead/多 dev;
//   - trivial 非编码任务 → 单 worker;
//   - default            → 单团队(maxLeads=1),团队内 worker 数仍由 lead 自拆(不额外钳);
//   - expand             → 不钳(保留完整规模,复杂任务需要多角色/多团队)。
//
// 设计约束:
//   1. taskScale 由调用方(orchestrator.classifyTaskScale)提供 → 关键词分类的单一真源在 orchestrator,
//      本模块不再维护第二张关键词表(避免分叉)。缺省时保守按 "default"。
//   2. 只**建议最小集**;requireVerifier 与调用方的"要求测试的编码 run 即便 trivial 也必须保留独立 verifier"
//      不变量对齐(见 orchestrator ~1722 的 P0 注释)——收敛只能裁 producer,绝不移除 verifier。
//   3. roles 用中性名(coder/tester/worker);orchestrator 负责映射到本公司具体角色(dev/engineer↔coder,
//      reviewer/test↔tester)。default/expand 返回空 roles = "不建议裁剪成员"。

import { classifyTaskType } from "./runCritic.js";

export type TaskScale = "trivial" | "default" | "expand";

export interface DecideTeamScaleInput {
  goal: string;
  // orchestrator.classifyTaskScale(goal) 的结果。缺省 → 保守按 "default"(不钳)。
  taskScale?: TaskScale;
  // 本 run 是否要求独立测试(orchestrator 的 runRequiresTests,来自不可变用户目标下限)。
  requiresTests?: boolean;
}

export interface TeamScaleRecommendation {
  scale: TaskScale;
  // 建议的团队(lead)数上限。undefined = 不钳(expand)。
  maxLeads?: number;
  // 建议的单团队 worker 数上限。undefined = 由 lead 自拆决定(default/expand 不钳)。
  maxWorkersPerTeam?: number;
  // 建议的最小角色集(中性名)。仅 trivial 有意义;default/expand 为空数组 = 不建议裁剪。
  roles: string[];
  // 要求测试时即便 trivial 也必须保留一个独立 verifier(与 orchestrator 的 P0 不变量对齐)。
  requireVerifier: boolean;
  // 人类可读的判定理由(供 emit/telemetry 观测,不参与控制流)。
  reason: string;
}

// goal 是否为编码型任务(复用 runCritic 的粗分类,保证与 lesson/skill 检索的 taskType 口径一致)。
function isCodingGoal(goal: string): boolean {
  return classifyTaskType(goal) === "coding";
}

// 建议团队规模。纯函数:同输入恒同输出,不读盘、不调 LLM、不碰模块状态。
export function decideTeamScale(input: DecideTeamScaleInput): TeamScaleRecommendation {
  const scale: TaskScale = input.taskScale ?? "default";
  const requiresTests = input.requiresTests === true;

  if (scale === "expand") {
    // 复杂任务:保留完整规模,不建议任何裁剪(多角色/多团队是其核心优势)。
    return {
      scale,
      maxLeads: undefined,
      maxWorkersPerTeam: undefined,
      roles: [],
      requireVerifier: requiresTests,
      reason: "expand:复杂/多组件任务,保留完整团队规模,不钳制",
    };
  }

  if (scale === "trivial") {
    const coding = isCodingGoal(input.goal);
    if (coding) {
      // 单文件纯函数这类:一个 coder 足矣;要求测试则 + 一个独立 tester(绝不砍验证边)。
      const roles = requiresTests ? ["coder", "tester"] : ["coder"];
      return {
        scale,
        maxLeads: 1,
        maxWorkersPerTeam: roles.length,
        roles,
        requireVerifier: requiresTests,
        reason: requiresTests
          ? "trivial 编码 + 要求测试:单 coder + 独立 tester(保留验证边),不铺 CEO/多 dev"
          : "trivial 编码:单 coder,不铺 CEO/Lead/多 dev",
      };
    }
    // trivial 非编码(小报告/查一条事实等):单 worker。
    return {
      scale,
      maxLeads: 1,
      maxWorkersPerTeam: 1,
      roles: ["worker"],
      requireVerifier: false,
      reason: "trivial 非编码:单 worker 直出,不开满编团队",
    };
  }

  // default:单团队(收敛多 lead → 1),团队内 worker 数仍由 lead 自拆,不额外钳。
  return {
    scale: "default",
    maxLeads: 1,
    maxWorkersPerTeam: undefined,
    roles: [],
    requireVerifier: requiresTests,
    reason: "default:收敛到单团队;团队内 worker 数由 lead 按子任务自拆",
  };
}
