// Agent project memory (Phase 4 "differentiated brain"). Persists to
// <root>/.opc/memory/project.jsonl, shared across all agents in a project. Retrieval scores by
// tag overlap + goal-slug match, returns top-N, bumps hits.
// (formerly a 4-layer session/task/project/global scheme — session/task/global were never
// written to in production, so the layer concept was removed; only project ever held real data.)
export interface MemoryEntry {
  id: string;
  agentRole: string;          // 'dev'|'test'|'lead'|... ; '*' = all roles
  // C12-P0 · 公司硬隔离:产出该记忆的 agent 所属公司。加性可选字段——旧 JSON 无此字段照常解析(=无归属)。
  // 写侧强制写入本公司 id;检索侧当 query.companyId 设了时对 companyId!==query 与无归属条目一律不注入
  // (与 reflectionStore lessons 的硬隔离口径一致)。不同公司同角色同内容各自成条,互不覆盖、互不注入。
  companyId?: string;
  goalSlug: string;           // slug of the originating goal (task/project retrieval)
  text: string;               // one experience/fact (~<=500 chars)
  tags: string[];             // keywords for retrieval scoring
  source: {
    runId: string;
    agentId: string;
    // Legacy records omit this field and are conservatively treated as run-backed.
    type?: "run" | "manual" | "import";
  };
  createdAt: string;
  hits: number;               // times retrieved/injected — for eviction
}

export interface MemoryQuery {
  agentRole: string;
  companyId?: string;         // C12-P0:设了 → 检索侧公司硬隔离(见 memoryStore.score);未设 → 不隔离(向后兼容)
  goal: string;
  limit?: number;             // default: 5
}

// 收口作战令二.1 · 唯一 normalizeCompanyId(全仓记忆域公司归一的单一真相源)。纯函数、无 fs。
// 语义:trim 后非空 → 用它;缺省(undefined/null/空白)→ DEFAULT_COMPANY_ID。
// 用途:写入(落盘前归一,缺省=default,今后不再产生"无归属"新记录)+ 查询/去重/导入/导出/prompt 注入
// 的公司作用域归一。**注意隔离边界(令二.3)**:本函数只归一"传入的公司作用域标识",绝不用来归一
// 历史存量记录**自身**已缺失的 companyId 字段——历史无字段记录 = legacy 隔离区,读侧一律按其原始
// undefined 处理(不注入、不导出),不能因 normalize 被自动归为默认公司。
export const DEFAULT_COMPANY_ID = "default";
export function normalizeCompanyId(companyId?: string | null): string {
  return companyId?.trim() || DEFAULT_COMPANY_ID;
}
