// 产物验收契约（WS2 · Artifact Contract）。
// 定义"什么叫有效工件"——orchestrator 依此决定工件是否进综合，
// 不满足时按 onFailure 走 revise / drop / degrade，不自动放行。

import { Ajv, type ValidateFunction } from "ajv";

export type OnFailure = "revise" | "drop" | "degrade";

// 验收准则：discriminated union，每种 kind 对应一类检查。
export type AcceptanceCriterion =
  | { kind: "section_exists"; section: string }
  | { kind: "max_bytes"; maxBytes: number }
  | { kind: "must_include_regex"; pattern: string }
  | { kind: "blocked_regex"; pattern: string }
  // json_schema：内容必须是合法 JSON，且结构满足规则声明的 JSON Schema（ajv 校验）。
  | { kind: "json_schema"; schema: Record<string, unknown> };

export interface ArtifactContract {
  artifactType: string;
  // 期望产物匹配的文件路径模式（glob），供 readWorkerDeliverables 过滤用。
  filePattern: string;
  // 快捷：内容必须包含这些段落字符串（子串匹配）。
  requiredSections: string[];
  // 细粒度验收准则，可与 requiredSections 并列使用。
  acceptanceCriteria: AcceptanceCriterion[];
  onFailure: OnFailure;
}

export interface ValidationResult {
  passed: boolean;
  failures: string[];
}

// ── json_schema 校验支撑 ──────────────────────────────────────────────────────

// allErrors：收集全部字段错误（与"收集全部失败项"原则一致）；
// strict:false：容忍 schema 里的未知关键字，避免契约作者小笔误直接炸编译。
const ajv = new Ajv({ allErrors: true, strict: false });

// 编译结果缓存：契约 schema 是模块级常量，按引用缓存避免每次校验重复编译。
// null 表示 schema 本身编译失败（非法 schema），降级为仅 JSON 语法校验。
const compiledSchemaCache = new WeakMap<Record<string, unknown>, ValidateFunction | null>();

function getSchemaValidator(schema: Record<string, unknown>): ValidateFunction | null {
  if (compiledSchemaCache.has(schema)) {
    return compiledSchemaCache.get(schema) ?? null;
  }
  let validator: ValidateFunction | null = null;
  try {
    validator = ajv.compile(schema);
  } catch {
    validator = null;
  }
  compiledSchemaCache.set(schema, validator);
  return validator;
}

// 对 content 字符串运行 contract 的所有规则，返回统一的通过/失败结构。
// 设计原则：收集全部失败项（不提前短路），便于 orchestrator 生成完整的 failure report。
export function validateArtifact(content: string, contract: ArtifactContract): ValidationResult {
  const failures: string[] = [];

  for (const section of contract.requiredSections) {
    if (!content.includes(section)) {
      failures.push(`缺少必要段落: "${section}"`);
    }
  }

  for (const criterion of contract.acceptanceCriteria) {
    switch (criterion.kind) {
      case "section_exists": {
        if (!content.includes(criterion.section)) {
          failures.push(`段落不存在: "${criterion.section}"`);
        }
        break;
      }
      case "max_bytes": {
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > criterion.maxBytes) {
          failures.push(`内容超字节上限: ${bytes} > ${criterion.maxBytes}`);
        }
        break;
      }
      case "must_include_regex": {
        if (!new RegExp(criterion.pattern).test(content)) {
          failures.push(`未匹配必要模式: ${criterion.pattern}`);
        }
        break;
      }
      case "blocked_regex": {
        // 大小写不敏感：防止绕过（如 "PIP INSTALL"）。
        if (new RegExp(criterion.pattern, "i").test(content)) {
          failures.push(`命中禁止模式: ${criterion.pattern}`);
        }
        break;
      }
      case "json_schema": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          failures.push(`内容不是合法 JSON`);
          break;
        }
        // schema 本身非法（编译失败）时降级：只保留上面的 JSON 语法校验，不误伤工件。
        const validator = getSchemaValidator(criterion.schema);
        if (validator && !validator(parsed)) {
          const errors = validator.errors ?? [];
          if (errors.length === 0) {
            failures.push(`JSON Schema 校验失败: 未通过 schema 约束`);
          }
          for (const err of errors) {
            const path = err.instancePath || "(root)";
            failures.push(`JSON Schema 校验失败: ${path} ${err.message ?? "不满足约束"}`);
          }
        }
        break;
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── 预设契约 ──────────────────────────────────────────────────────────────────

// 研究 worker 契约：四段核心结构 + 证据引用 + 禁止建环境指令（blocked_regex 是本契约核心约束）。
export const researchContract: ArtifactContract = {
  artifactType: "research",
  filePattern: "output/*.md",
  requiredSections: [
    "## Key Findings",
    "## Evidence Table",
    "## Uncertainties",
    "## Handoff",
  ],
  acceptanceCriteria: [
    // 必须含有证据引用（脚注式 [1] 或 URL）。
    { kind: "must_include_regex", pattern: "\\[\\d+\\]|https?://" },
    // 禁止研究 worker 在报告中写出建环境指令——这是 §4 崩溃的根因之一。
    { kind: "blocked_regex", pattern: "pip install|python -m venv|npm install" },
  ],
  onFailure: "revise",
};

// 事实核查契约：必含三段核心 + 必须有判定结论 + 禁止建环境。
export const factCheckContract: ArtifactContract = {
  artifactType: "fact_check",
  filePattern: "output/*.md",
  requiredSections: ["## Claims", "## Verdict", "## Sources"],
  acceptanceCriteria: [
    { kind: "blocked_regex", pattern: "pip install|python -m venv|npm install" },
    // 核查报告必须给出明确结论。
    { kind: "must_include_regex", pattern: "True|False|Unverified|Partially" },
  ],
  onFailure: "revise",
};

// 评审契约：必含摘要/问题列表/建议，正文不超 512 KB。
export const reviewContract: ArtifactContract = {
  artifactType: "review",
  filePattern: "output/*.md",
  requiredSections: ["## Summary", "## Issues", "## Recommendation"],
  acceptanceCriteria: [
    { kind: "max_bytes", maxBytes: 512 * 1024 },
  ],
  onFailure: "revise",
};

// 最终综合契约：三段核心结构，允许较大体量（1 MB），失败走降级而非重试。
export const finalContract: ArtifactContract = {
  artifactType: "final",
  filePattern: "output/*.md",
  requiredSections: [
    "## Executive Summary",
    "## Main Findings",
    "## Conclusion",
  ],
  acceptanceCriteria: [
    { kind: "max_bytes", maxBytes: 1024 * 1024 },
  ],
  onFailure: "degrade",
};
