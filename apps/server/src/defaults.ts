import type { AgentNodeConfig } from "@opc/shared";

const T = { prompt: 0, completion: 0, total: 0 };

const RAW_DEFAULT_AGENTS: AgentNodeConfig[] = [
  {
    id: "ceo", name: "CEO", role: "ceo",
    childrenIds: ["product-lead", "engineering-lead", "review-lead"],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: false, deletable: false, enabled: true,
  },
  {
    id: "product-lead", name: "Product Lead", role: "lead",
    parentId: "ceo", childrenIds: ["product-researcher", "spec-writer"],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "product-researcher", name: "Product Researcher", role: "dev",
    parentId: "product-lead", childrenIds: [],
    model: "MiniMax-M3", provider: "minimax",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "spec-writer", name: "Spec Writer", role: "dev",
    parentId: "product-lead", childrenIds: [],
    model: "doubao-seed-2-0-pro-260215", provider: "doubao",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "engineering-lead", name: "Engineering Lead", role: "lead",
    parentId: "ceo", childrenIds: ["frontend-engineer", "backend-engineer", "test-engineer"],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "frontend-engineer", name: "Frontend Engineer", role: "dev",
    parentId: "engineering-lead", childrenIds: [],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "backend-engineer", name: "Backend Engineer", role: "dev",
    parentId: "engineering-lead", childrenIds: [],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "test-engineer", name: "Test Engineer", role: "test",
    parentId: "engineering-lead", childrenIds: [],
    model: "MiniMax-M3", provider: "minimax",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "review-lead", name: "Review Lead", role: "lead",
    parentId: "ceo", childrenIds: ["code-reviewer", "security-reviewer"],
    model: "deepseek-v4-pro", provider: "deepseek",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "code-reviewer", name: "Code Reviewer", role: "test",
    parentId: "review-lead", childrenIds: [],
    model: "MiniMax-M3", provider: "minimax",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
  {
    id: "security-reviewer", name: "Security Reviewer", role: "security",
    parentId: "review-lead", childrenIds: [],
    model: "MiniMax-M3", provider: "minimax",
    status: "idle", tokenUsage: { ...T }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  },
];

// Every default node runs on the "api" framework (in-process ApiEngine) until the user switches it.
export const DEFAULT_AGENTS: AgentNodeConfig[] = RAW_DEFAULT_AGENTS.map(a => ({ framework: "api", ...a }));
