// 归档前端共用小工具:哪些 run 状态算"已结束、可归档"(与服务端 archiveStore 的
// ACTIVE_RUN_STATUSES 互补口径——服务端仍是最终裁决,这里只用于预筛与计数展示)。
export const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "accepted", "blocked", "cancelled"]);

export interface ArchivableRunRow {
  id: string;
  status: string;
  companyId?: string;
}

// "一键归档 default 公司的历史 run":default 公司(含未标记公司的旧 run)里所有已结束的 run。
export function pickDefaultHistoryRunIds(rows: ArchivableRunRow[]): string[] {
  return (rows || [])
    .filter((r) => (r.companyId ?? "default") === "default" && TERMINAL_RUN_STATUSES.has(r.status))
    .map((r) => r.id);
}
