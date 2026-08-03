// workerArtifactGate.ts — 宽松 worker 产出门控(WS2 承重层)。
// 只拦完全空产出;"建环境垃圾"由 scratch 隔离 + .md-only/大小上限在文件层处理(见下方契约注释)。
// 普通 .md 报告必须通过;宁漏不误杀;任何内部错误视为通过。
import { validateArtifact, type ArtifactContract } from "./artifactContract.js";

// 宽松工件契约:**只拦完全空产出**。
// 不再用 blocked_regex 拦 "pip install / python -m venv" —— 审查抓出那会**误杀任何提到 pip 的正常研究报告**
// (讲 Python/ML 工具、部署、复现的报告都会命中)。真正的"建环境垃圾"(Python 文件、巨型文档)已由
// scratch 隔离 + RC3 的 .md-only/500KB 上限 + 最终报告护栏在**文件/大小层**处理,不该靠正文字符串去猜。
const LOOSE_WORKER_CONTRACT: ArtifactContract = {
  artifactType: "worker_loose",
  filePattern: "*.md",
  requiredSections: [],
  acceptanceCriteria: [],
  onFailure: "revise",
};

export interface WorkerArtifactCheckResult {
  passed: boolean;
  reason: string;
}

// 检查单个 worker 的产出内容(content + 文件体的拼接字符串)。
// 返回 { passed, reason }:passed=true 正常通过,passed=false 含失败原因。
// 绝不抛异常:任何内部错误视为通过(宁漏不误杀——门控自身出错不能崩 run)。
export function checkWorkerArtifact(content: string): WorkerArtifactCheckResult {
  try {
    const trimmed = content.trim();
    if (!trimmed) {
      return { passed: false, reason: "产出为空" };
    }
    const vr = validateArtifact(trimmed, LOOSE_WORKER_CONTRACT);
    if (!vr.passed) {
      return { passed: false, reason: vr.failures[0] ?? "命中禁止模式" };
    }
    return { passed: true, reason: "" };
  } catch {
    // 容错:门控自身出错 → 视为通过(宽松原则,不因检查本身误杀)
    return { passed: true, reason: "" };
  }
}
