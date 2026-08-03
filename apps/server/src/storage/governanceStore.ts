import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import type { GovernanceLevel } from "../runtime/runGovernance.js";

// E3/E4 · Run Governance record store —— .opc/governance-records.json(数组,新的在前,上限 200,
// 滚动淘汰最旧的)。与 installTransactionStore.ts 同款姿势:整文件读写 + jsonFile 的原子写。
// 每 run 一条 record:判级结果 + 输入摘要 + 后续治理事件(L2 workspace 观察 / L3 审批 / kill)。

const MAX_RECORDS = 200;

export type GovernanceEventKind =
  | "file_observation"   // L2:run 期间 workspace/worktree 观察到的文件变更(复用 worker fileChanges,只记录不阻断)
  | "approval_requested" // L3:派发前标 approval_required
  | "approved"           // L3:人工批准(或 mission approve 视同批准)
  | "rejected"           // L3:人工拒绝,run 不派发
  | "dispatch_blocked"   // L3:未批时尝试派发被拦
  | "kill";              // L3:按 runId kill 已登记子进程

export interface GovernanceEvent {
  at: string;
  kind: GovernanceEventKind;
  agentId?: string;
  detail?: string;
  files?: { path: string; changeType: string }[];
  pids?: number[];
  decidedBy?: string;
}

export interface GovernanceInputsSummary {
  goalPreview: string;
  companyId?: string;
  frameworks: string[];
  writesFiles: boolean;
  involvesMcp: boolean;
  involvesAcp: boolean;
  involvesShell: boolean;
  fullHostAccess?: boolean;
  complexity?: string;
  estimatorRecommendedLevel?: number;
}

export type GovernanceApprovalStatus = "pending" | "approved" | "rejected";

// L3 gate 批准后要能真正派发:把派发参数随 record 落盘(不含任何密钥/敏感内容,goal 即用户目标原文)。
export interface GovernancePendingDispatch {
  goal: string;
  companyId?: string;
  runType?: "quick" | "team";
  teamMode?: "economy" | "balanced" | "maxQuality";
  forceSkills?: string[];
}

export interface GovernanceRecord {
  runId: string;
  level: GovernanceLevel;
  reason: string[];
  decidedAt: string;
  inputs: GovernanceInputsSummary;
  approvalRequired?: boolean;
  approval?: { status: GovernanceApprovalStatus; decidedAt?: string; decidedBy?: string };
  pendingDispatch?: GovernancePendingDispatch;
  events: GovernanceEvent[];
}

const recordsPath = (root: string) => path.join(root, ".opc", "governance-records.json");

// 战役B·Phase B2a:接后端开关。默认 json 逐字节不变;sqlite 时读走 governance_records 表(权威)、
// 写【双写】(JSON 照写 + 全量重写),整数组覆盖 + 上限 200 语义与 JSON 一致。
export function loadGovernanceRecords(root: string): GovernanceRecord[] {
  if (isSqliteBackend(root)) {
    return readAllDocs(openBusinessDb(root), "governance_records") as GovernanceRecord[];
  }
  const arr = readJSON<GovernanceRecord[]>(recordsPath(root), []);
  return Array.isArray(arr) ? arr : [];
}

function saveGovernanceRecords(root: string, records: GovernanceRecord[]): void {
  const capped = records.slice(0, MAX_RECORDS);
  writeJSON(recordsPath(root), capped);
  if (isSqliteBackend(root)) {
    replaceAllDocs(openBusinessDb(root), "governance_records", capped);
  }
}

export function getGovernanceRecord(root: string, runId: string): GovernanceRecord | undefined {
  return loadGovernanceRecords(root).find(r => r.runId === runId);
}

export function recordGovernanceDecision(
  root: string,
  record: Omit<GovernanceRecord, "decidedAt" | "events"> & { events?: GovernanceEvent[] },
): GovernanceRecord {
  const all = loadGovernanceRecords(root);
  const existing = all.find(r => r.runId === record.runId);
  if (existing) return existing; // 幂等:同 run 只判一次级(precreate 与 startRun 两个钩子都会调)
  const full: GovernanceRecord = { ...record, decidedAt: new Date().toISOString(), events: record.events ?? [] };
  all.unshift(full);
  saveGovernanceRecords(root, all);
  return full;
}

export function appendGovernanceEvent(root: string, runId: string, event: Omit<GovernanceEvent, "at">): GovernanceRecord | undefined {
  const all = loadGovernanceRecords(root);
  const idx = all.findIndex(r => r.runId === runId);
  if (idx === -1) return undefined;
  const events = [...all[idx].events, { ...event, at: new Date().toISOString() }];
  all[idx] = { ...all[idx], events };
  saveGovernanceRecords(root, all);
  return all[idx];
}

export function setGovernanceApproval(
  root: string,
  runId: string,
  status: Exclude<GovernanceApprovalStatus, "pending">,
  decidedBy: string,
): GovernanceRecord | undefined {
  const all = loadGovernanceRecords(root);
  const idx = all.findIndex(r => r.runId === runId);
  if (idx === -1) return undefined;
  const at = new Date().toISOString();
  all[idx] = {
    ...all[idx],
    approval: { status, decidedAt: at, decidedBy },
    events: [...all[idx].events, { at, kind: status, decidedBy } satisfies GovernanceEvent],
  };
  saveGovernanceRecords(root, all);
  return all[idx];
}

/** L3 gate:该 run 是否已获派发许可(非 L3 / 已批准 → true;L3 且 pending/rejected → false)。 */
export function isDispatchAllowed(record: GovernanceRecord | undefined): boolean {
  if (!record) return true; // 无 record 的旧路径不拦(governance 是加性防线,不制造新失败面)
  if (!record.approvalRequired) return true;
  return record.approval?.status === "approved";
}
