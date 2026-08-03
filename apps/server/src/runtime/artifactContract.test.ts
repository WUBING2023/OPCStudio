import { describe, it, expect } from "vitest";
import {
  validateArtifact,
  researchContract,
  factCheckContract,
  reviewContract,
  finalContract,
} from "./artifactContract.js";
import type { ArtifactContract } from "./artifactContract.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeResearch(overrides?: Partial<{
  keyFindings: string;
  evidenceTable: string;
  uncertainties: string;
  handoff: string;
  extra: string;
}>): string {
  const o = overrides ?? {};
  return [
    o.keyFindings  ?? "## Key Findings\n量子纠缠研究摘要",
    o.evidenceTable ?? "## Evidence Table\n[1] https://example.com/paper1",
    o.uncertainties ?? "## Uncertainties\n样本量尚小",
    o.handoff       ?? "## Handoff\n下一步交 fact_check",
    o.extra         ?? "",
  ].join("\n\n");
}

// ── validateArtifact 核心逻辑 ─────────────────────────────────────────────────

describe("validateArtifact — requiredSections", () => {
  it("所有必要段落存在时通过", () => {
    const r = validateArtifact(makeResearch(), researchContract);
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("缺少一个段落时失败，且 failures 列出该段落", () => {
    const content = makeResearch({ keyFindings: "" }); // 去掉 ## Key Findings
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => f.includes("Key Findings"))).toBe(true);
  });

  it("同时缺少多个段落时全部列出（不提前短路）", () => {
    const bare = "只有一行正文，什么段落都没有。";
    const r = validateArtifact(bare, researchContract);
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(4); // 4 个必要段落均缺失
  });
});

describe("validateArtifact — blocked_regex", () => {
  it("包含 'pip install' 时命中禁止模式", () => {
    const content = makeResearch({ extra: "建议先 pip install requests 以复现实验" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => f.includes("禁止模式"))).toBe(true);
  });

  it("包含 'python -m venv' 时命中禁止模式", () => {
    const content = makeResearch({ extra: "python -m venv .env && source .env/bin/activate" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
  });

  it("包含 'npm install' 时命中禁止模式", () => {
    const content = makeResearch({ extra: "npm install lodash" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
  });

  it("大写 'PIP INSTALL' 也被 blocked（大小写不敏感）", () => {
    const content = makeResearch({ extra: "PIP INSTALL numpy" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
  });

  it("正常研究内容不含禁止模式时通过", () => {
    const content = makeResearch();
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(true);
  });
});

describe("validateArtifact — must_include_regex", () => {
  it("含有脚注式引用 [1] 时通过", () => {
    const content = makeResearch({ evidenceTable: "## Evidence Table\n见[1]的分析结论" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(true);
  });

  it("含有 URL 时通过", () => {
    const content = makeResearch({ evidenceTable: "## Evidence Table\nhttps://arxiv.org/abs/1234.5678" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(true);
  });

  it("没有任何引用时失败", () => {
    const content = makeResearch({ evidenceTable: "## Evidence Table\n暂无具体来源。" });
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => f.includes("必要模式"))).toBe(true);
  });
});

describe("validateArtifact — max_bytes", () => {
  it("内容在字节上限内通过", () => {
    const contract: ArtifactContract = {
      artifactType: "test",
      filePattern: "output/*.md",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "max_bytes", maxBytes: 100 }],
      onFailure: "drop",
    };
    const r = validateArtifact("short content", contract);
    expect(r.passed).toBe(true);
  });

  it("内容超字节上限时失败，failures 包含具体字节数", () => {
    const contract: ArtifactContract = {
      artifactType: "test",
      filePattern: "output/*.md",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "max_bytes", maxBytes: 5 }],
      onFailure: "drop",
    };
    const r = validateArtifact("this is more than 5 bytes", contract);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/超字节上限/);
  });
});

describe("validateArtifact — section_exists（criterion 级）", () => {
  it("指定段落存在时通过", () => {
    const contract: ArtifactContract = {
      artifactType: "test",
      filePattern: "output/*.md",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "section_exists", section: "### Detail" }],
      onFailure: "revise",
    };
    const r = validateArtifact("## Overview\n### Detail\ncontent", contract);
    expect(r.passed).toBe(true);
  });

  it("指定段落不存在时失败", () => {
    const contract: ArtifactContract = {
      artifactType: "test",
      filePattern: "output/*.md",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "section_exists", section: "### Missing" }],
      onFailure: "revise",
    };
    const r = validateArtifact("## Overview\ncontent", contract);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/段落不存在/);
  });
});

describe("validateArtifact — json_schema", () => {
  it("合法 JSON 时通过", () => {
    const contract: ArtifactContract = {
      artifactType: "evidence_table",
      filePattern: "output/evidence_table.json",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "json_schema", schema: {} }],
      onFailure: "revise",
    };
    const r = validateArtifact(JSON.stringify({ sources: [] }), contract);
    expect(r.passed).toBe(true);
  });

  it("非法 JSON 时失败", () => {
    const contract: ArtifactContract = {
      artifactType: "evidence_table",
      filePattern: "output/evidence_table.json",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "json_schema", schema: {} }],
      onFailure: "revise",
    };
    const r = validateArtifact("{ sources: [}", contract);
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/合法 JSON/);
  });
});

describe("validateArtifact — json_schema 结构校验（ajv）", () => {
  const evidenceSchema = {
    type: "object",
    required: ["sources", "summary"],
    properties: {
      sources: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string" } },
        },
      },
      summary: { type: "string", minLength: 5 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };

  function makeContract(schema: Record<string, unknown>): ArtifactContract {
    return {
      artifactType: "evidence_table",
      filePattern: "output/evidence_table.json",
      requiredSections: [],
      acceptanceCriteria: [{ kind: "json_schema", schema }],
      onFailure: "revise",
    };
  }

  it("数据满足 schema 时通过", () => {
    const content = JSON.stringify({
      sources: [{ url: "https://example.com/paper1" }],
      summary: "量子纠缠研究摘要",
      confidence: 0.8,
    });
    const r = validateArtifact(content, makeContract(evidenceSchema));
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("缺必填字段时失败，错误信息点名缺失字段", () => {
    const content = JSON.stringify({ sources: [{ url: "https://example.com" }] });
    const r = validateArtifact(content, makeContract(evidenceSchema));
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => f.includes("JSON Schema 校验失败") && f.includes("summary"))).toBe(true);
  });

  it("字段类型/取值违规时失败，错误信息带具体字段路径与约束", () => {
    const content = JSON.stringify({
      sources: [{ url: 123 }],
      summary: "ok了",
      confidence: 2,
    });
    const r = validateArtifact(content, makeContract(evidenceSchema));
    expect(r.passed).toBe(false);
    // url 类型错：路径指向具体数组元素字段
    expect(r.failures.some(f => f.includes("/sources/0/url") && f.includes("string"))).toBe(true);
    // confidence 超上限：约束值出现在信息里
    expect(r.failures.some(f => f.includes("/confidence") && f.includes("1"))).toBe(true);
    // summary 长度不足
    expect(r.failures.some(f => f.includes("/summary"))).toBe(true);
  });

  it("allErrors：多个字段违规时全部列出（不提前短路）", () => {
    const content = JSON.stringify({ sources: [], summary: "短" });
    const r = validateArtifact(content, makeContract(evidenceSchema));
    expect(r.passed).toBe(false);
    // sources.minItems + summary.minLength 两条都在
    expect(r.failures.filter(f => f.includes("JSON Schema 校验失败")).length).toBeGreaterThanOrEqual(2);
  });

  it("schema 本身非法时降级：合法 JSON 通过（仅保留语法校验）", () => {
    const brokenSchema = { type: "nonsense" };
    const r = validateArtifact(JSON.stringify({ anything: true }), makeContract(brokenSchema));
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("schema 本身非法时降级：非法 JSON 仍然失败", () => {
    const brokenSchema = { type: "nonsense" };
    const r = validateArtifact("{ not json", makeContract(brokenSchema));
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/合法 JSON/);
  });

  it("同一 schema 对象复用（缓存路径）时校验结果稳定", () => {
    const contract = makeContract(evidenceSchema);
    const good = JSON.stringify({ sources: [{ url: "https://a.com" }], summary: "足够长的摘要" });
    const bad = JSON.stringify({ summary: "足够长的摘要" });
    expect(validateArtifact(good, contract).passed).toBe(true);
    expect(validateArtifact(bad, contract).passed).toBe(false);
    expect(validateArtifact(good, contract).passed).toBe(true);
  });

  it("json_schema 失败与其他规则失败在 failures 中聚合", () => {
    const contract: ArtifactContract = {
      artifactType: "evidence_table",
      filePattern: "output/evidence_table.json",
      requiredSections: [],
      acceptanceCriteria: [
        { kind: "json_schema", schema: evidenceSchema },
        { kind: "must_include_regex", pattern: "https?://" },
      ],
      onFailure: "revise",
    };
    const r = validateArtifact(JSON.stringify({ summary: "足够长的摘要" }), contract);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => f.includes("JSON Schema 校验失败"))).toBe(true);
    expect(r.failures.some(f => f.includes("必要模式"))).toBe(true);
  });
});

// ── 多项失败并发返回 ──────────────────────────────────────────────────────────

describe("validateArtifact — 多失败并发", () => {
  it("缺段落 + blocked_regex 同时命中时 failures 全部列出", () => {
    const content = "## Key Findings\n只有一段，加上 pip install numpy。";
    const r = validateArtifact(content, researchContract);
    expect(r.passed).toBe(false);
    // 缺 Evidence Table / Uncertainties / Handoff + 无引用 + 命中 blocked
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
  });
});

// ── 预设契约快捷验证 ──────────────────────────────────────────────────────────

describe("预设契约 — factCheckContract", () => {
  it("含三段核心 + 结论词时通过", () => {
    const content = "## Claims\n声明1\n\n## Verdict\nTrue\n\n## Sources\nhttps://example.com";
    const r = validateArtifact(content, factCheckContract);
    expect(r.passed).toBe(true);
  });

  it("缺 Verdict 时失败", () => {
    const content = "## Claims\n声明1\n\n## Sources\nhttps://example.com";
    const r = validateArtifact(content, factCheckContract);
    expect(r.passed).toBe(false);
  });
});

describe("预设契约 — reviewContract", () => {
  it("含三段核心且不超 512 KB 时通过", () => {
    const content = "## Summary\n摘要\n\n## Issues\n问题\n\n## Recommendation\n建议";
    const r = validateArtifact(content, reviewContract);
    expect(r.passed).toBe(true);
  });
});

describe("预设契约 — finalContract", () => {
  it("含三段核心时通过，onFailure 为 degrade", () => {
    const content = [
      "## Executive Summary\n执行摘要",
      "## Main Findings\n主要发现",
      "## Conclusion\n结论",
    ].join("\n\n");
    const r = validateArtifact(content, finalContract);
    expect(r.passed).toBe(true);
    expect(finalContract.onFailure).toBe("degrade");
  });
});

describe("预设契约 — onFailure 字段", () => {
  it("research/factCheck/review 失败时走 revise", () => {
    expect(researchContract.onFailure).toBe("revise");
    expect(factCheckContract.onFailure).toBe("revise");
    expect(reviewContract.onFailure).toBe("revise");
  });

  it("final 失败时走 degrade（不重试，直接降级）", () => {
    expect(finalContract.onFailure).toBe("degrade");
  });
});
