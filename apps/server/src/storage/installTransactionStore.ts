import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import type { MergeDecision, PreMergeCompanyFields } from "../runtime/installMerge.js";
import type { SafeInstallStrippedItem, InstallDangerSurface } from "../runtime/install.js";
import type { MemoryImportRecordIds } from "../runtime/memoryBundle.js";
import type { AgentNodeConfig, A2AChannelSpec, McpRequirementSpec } from "@opc/shared";

// D6(V0 必需)· Install transaction + rollback(指南「7月6日重构指南-现状对照与落地计划.md」§7 D6 +
// 「7月6日第一个大重构指南.md」11.17 Install Rollback)。.opc/install-transactions.json(数组,新的在前,
// 上限 50,滚动淘汰最旧的)——与 taskGraphStore.ts 同款姿势:整文件读写 + jsonFile 的原子写。
//
// 只有**真实安装**(new-company 或 merge)落一条记录;preview 是纯读不落任何状态,不产生 transaction
// (路由层在写入完成后才调 recordInstallTransaction,preview 分支根本不会走到这里)。

const MAX_TRANSACTIONS = 50;

export interface InstallTransactionCreated {
  agentIds: string[];
  companyIds: string[];
  presetChannelKeys: string[]; // `${from}=>${to}` 形式,与 installMerge.ts mergeChannels 的 key 同构
  skillIds: string[];
}

// 回滚前置检查用的最小快照——只存"用户是否事后手动改过"判定必需的三个字段,不是全量 agent 快照
// (指南给的 created 字段形状里没有这项;这是为 rollback 的"已变更,仍删除,不静默"要求额外加的,
// 与 created 平级而不是塞进 created 里,不改变指南原定的 created 形状)。
export interface InstallTransactionAgentSnapshot {
  id: string;
  name: string;
  parentId?: string;
  companyId: string;
}

// 对抗验收缺口①②修复:merge 模式下写目标公司的三类"覆盖式"改动——manifestMcpRequirements 整份被
// 并集后的新值取代、agentId:overwrite 原地覆盖既有员工、a2aRule union/overwrite 改写既有边的
// purpose——事后都不可从 created(只记"新增了什么")反推出来,必须在合并前额外拍一份快照,rollback
// 才能把目标公司原有资产真正恢复,而不是"只删新增、留下被污染的旧资产"。
// 只有 merge 模式的 transaction 才会带这个字段(new-company 没有"目标公司"概念,整公司回滚即可);
// 老的 transaction(本字段上线前落盘的)没有 preMerge,rollback 对它们保持原有行为(不碰这三类状态)。
export interface InstallTransactionPreMerge {
  manifestMcpRequirements?: McpRequirementSpec[]; // 合并前目标公司的整份值(而非增量);merge 模式恒记,哪怕是 undefined(代表原本没有)
  overwrittenAgents?: AgentNodeConfig[]; // agentId:overwrite 真正生效时,被覆盖前的完整员工对象;没有发生覆盖则缺省
  // 令四.6 · adopt-template-org 改挂时受影响节点(被改挂员工 + 新旧父)的合并前整值快照。回滚用
  // restoreAgentsInPlace 原地整值恢复(保序,不像 overwrittenAgents 走 delete+re-add 挪到尾部)。与
  // overwrittenAgents 互斥(同一 id 只走一种处置);没有 adopt 改挂则缺省。老 tx 无此字段,回滚不碰。
  orgParentRestores?: AgentNodeConfig[];
  modifiedChannels?: A2AChannelSpec[]; // a2aRule:union/overwrite 真正改写了 purpose 的既有边(改写前的完整边);没有改写则缺省
  // 收口②:公司级四字段(visibilityPolicy/defaultTasks/manifestToolRequirements/workflow)合并前整值
  // 快照。**companyFields 键的存在与否语义重大**:键存在(哪怕内部四项全 undefined,JSON 序列化成 {})
  // 代表这次 merge 由"保守合并合同"实现落盘,rollback 要对四字段做整值恢复(undefined=恢复为「无」);
  // 老 transaction(本字段上线前)没有 companyFields,老实现从不写这四字段,rollback 不碰——否则会把
  // 用户在这四字段上的既有值误抹成 undefined。
  companyFields?: PreMergeCompanyFields;
}

export interface InstallTransaction {
  txId: string;
  at: string;
  mode: "new-company" | "merge";
  source: string; // 模板 id(社区库模板 / 直接 JSON 导入的模板自带 id)
  companyId: string; // 本次安装落地/合并进的公司 id
  created: InstallTransactionCreated;
  agentSnapshots: InstallTransactionAgentSnapshot[];
  conflictDecisions: MergeDecision[]; // new-company 模式恒为 []( 没有冲突决策可言 )
  safeInstallStripped: SafeInstallStrippedItem[];
  preMerge?: InstallTransactionPreMerge;
  // #9(指南 11.17 Rollback 应撤销「新增 memory」):D5 记忆导入真实写入的记录 id。记忆 id 在写入时
  // 才生成,无法在 tx-first(状态写之前落 transaction)时预知,故由 attachInstallTransactionMemory
  // 在导入完成后补挂——transaction 本体仍先于一切状态写落盘。老 transaction 没有本字段,rollback
  // 对它们维持原行为(不碰记忆)。
  memory?: MemoryImportRecordIds;
  rolledBack?: boolean;
  rolledBackAt?: string;
  // 最小状态枚举:记录时乐观标 completed(tx-first,状态写在后);安装 catch 分支改 failed,
  // 回滚改 rolled_back。本字段上线前的老 transaction 没有 status,消费方按 completed 兜底。
  status?: InstallTransactionStatus;
}

export type InstallTransactionStatus = "completed" | "rolled_back" | "failed";

const txPath = (root: string) => path.join(root, ".opc", "install-transactions.json");

// 战役B·Phase B2c:JSON 数组 IO 原语接后端开关(同 governanceStore/taskGraphStore 的 B2a 姿势)。
// 只换底层读写:load 走 install_transactions 表(读权威)、save 双写(照写 install-transactions.json + 全量重写表)。
// C 的 rollback 引用检查逻辑(在 memoryBundle/routes)全程只经 load*/get*/mark* 这些接口,一字不改;
// 新的在前 + 上限 50 的滚动语义在 save 里裁剪后全量重写,rowid 序 = 数组序 = 新在前,readAllDocs 读回同序。
export function loadInstallTransactions(root: string): InstallTransaction[] {
  if (isSqliteBackend(root)) {
    return readAllDocs(openBusinessDb(root), "install_transactions") as InstallTransaction[];
  }
  const arr = readJSON<InstallTransaction[]>(txPath(root), []);
  return Array.isArray(arr) ? arr : [];
}

function saveInstallTransactions(root: string, txs: InstallTransaction[]): void {
  const capped = txs.slice(0, MAX_TRANSACTIONS);
  writeJSON(txPath(root), capped);
  if (isSqliteBackend(root)) {
    replaceAllDocs(openBusinessDb(root), "install_transactions", capped);
  }
}

export function recordInstallTransaction(
  root: string,
  tx: Omit<InstallTransaction, "txId" | "at" | "rolledBack" | "rolledBackAt" | "status">,
): InstallTransaction {
  const all = loadInstallTransactions(root);
  const full: InstallTransaction = { ...tx, txId: randomUUID(), at: new Date().toISOString(), status: "completed" };
  all.unshift(full);
  saveInstallTransactions(root, all);
  return full;
}

export function getInstallTransaction(root: string, txId: string): InstallTransaction | undefined {
  return loadInstallTransactions(root).find(t => t.txId === txId);
}

export function attachInstallTransactionMemory(root: string, txId: string, memory: MemoryImportRecordIds): InstallTransaction | undefined {
  const all = loadInstallTransactions(root);
  const idx = all.findIndex(t => t.txId === txId);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], memory };
  saveInstallTransactions(root, all);
  return all[idx];
}

export function markInstallTransactionRolledBack(root: string, txId: string): InstallTransaction | undefined {
  const all = loadInstallTransactions(root);
  const idx = all.findIndex(t => t.txId === txId);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], rolledBack: true, rolledBackAt: new Date().toISOString(), status: "rolled_back" };
  saveInstallTransactions(root, all);
  return all[idx];
}

export function markInstallTransactionFailed(root: string, txId: string): InstallTransaction | undefined {
  const all = loadInstallTransactions(root);
  const idx = all.findIndex(t => t.txId === txId);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], status: "failed" };
  saveInstallTransactions(root, all);
  return all[idx];
}

// ══ 令四.1 · 一次性安装确认 token(unsafe/community 安装的**后端签发**确认凭据)══════════════════
//
// 替代旧的【客户端布尔 unsafeAcknowledged:true】——发布证据红线要求"客户端布尔不算确认,后端签发的
// 一次性 token 才算"。两步流:preview 分支后端签发 token(绑危险面快照,10 分钟过期,内存登记);真装
// 分支必须携带该 token 才启用 unsafe 保留(不带 token 恒走 Safe Install 剥离)。一次性消费:消费即失效,
// 重放 → 409;过期 → 410;模板/危险面在预览后被换(templateHash 或六元不符)→ 409;都是 4xx 拒绝并要求重新预览。
//
// 内存登记(非持久):token 生命周期 10 分钟,重启即失效属预期(重启后本就该重新预览确认),不落盘。

const INSTALL_TOKEN_TTL_MS = 10 * 60 * 1000;

interface StoredInstallToken {
  binding: InstallDangerSurface;
  scope: string;      // Endpoint scope is part of the authorization boundary.
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
  consumedAt?: number;
}

// 进程内单例注册表(所有 projectRoot 共用同一进程内存;token 本身是 uuid,跨 root 不会碰撞)。
const installTokenRegistry = new Map<string, StoredInstallToken>();

function pruneExpiredInstallTokens(now: number): void {
  for (const [k, v] of installTokenRegistry) {
    // 已消费或已过期超过一个 TTL 的条目清掉(消费态仍短暂保留,好让重放命中"已使用"而非"未知")。
    if (v.expiresAt + INSTALL_TOKEN_TTL_MS < now) installTokenRegistry.delete(k);
  }
}

export interface IssuedInstallToken {
  installConfirmationToken: string;
  expiresAt: string; // ISO
  binding: InstallDangerSurface;
}

export function issueInstallConfirmationToken(
  binding: InstallDangerSurface,
  opts: { scope?: string; now?: number } = {},
): IssuedInstallToken {
  const now = opts.now ?? Date.now();
  pruneExpiredInstallTokens(now);
  const token = randomUUID();
  const expiresAt = now + INSTALL_TOKEN_TTL_MS;
  installTokenRegistry.set(token, { binding, scope: opts.scope ?? "", issuedAt: now, expiresAt, consumed: false });
  return { installConfirmationToken: token, expiresAt: new Date(expiresAt).toISOString(), binding };
}

export type ConsumeInstallTokenResult =
  | { ok: true; binding: InstallDangerSurface }
  | { ok: false; status: number; reason: string };

function sameSurface(a: InstallDangerSurface, b: InstallDangerSurface): boolean {
  const eqArr = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return a.templateHash === b.templateHash
    && a.trustLevel === b.trustLevel
    && a.fileWrite === b.fileWrite
    && eqArr(a.dangerFlags, b.dangerFlags)
    && eqArr(a.mcp, b.mcp)
    && eqArr(a.cli, b.cli);
}

// 校验 + **一次性消费**(校验通过即标 consumed;失败不消费,以便区分重放与首用)。
export function consumeInstallConfirmationToken(
  token: string,
  presentSurface: InstallDangerSurface,
  opts: { now?: number; scope?: string } = {},
): ConsumeInstallTokenResult {
  const now = opts.now ?? Date.now();
  const stored = installTokenRegistry.get(token);
  if (!stored) return { ok: false, status: 401, reason: "安装确认 token 无效或未知,请重新预览获取" };
  if (stored.expiresAt < now) {
    installTokenRegistry.delete(token);
    return { ok: false, status: 410, reason: "安装确认 token 已过期(超过 10 分钟),请重新预览" };
  }
  if (stored.consumed) return { ok: false, status: 409, reason: "安装确认 token 已被使用(一次性),请重新预览" };
  if (opts.scope !== undefined && stored.scope !== opts.scope) {
    return { ok: false, status: 403, reason: "安装确认 token 的使用入口与签发入口不一致,请在当前入口重新预览" };
  }
  if (stored.binding.templateHash !== presentSurface.templateHash) {
    return { ok: false, status: 409, reason: "模板已变更(templateHash 与预览时不符),预览后模板被替换,请重新预览确认" };
  }
  if (!sameSurface(stored.binding, presentSurface)) {
    return { ok: false, status: 409, reason: "危险授权面(dangerFlags/MCP/CLI/file-write/trustLevel)与预览时不符,请重新预览确认" };
  }
  stored.consumed = true;
  stored.consumedAt = now;
  return { ok: true, binding: stored.binding };
}

// 测试/维护用:清空注册表(单测隔离)。
export function _resetInstallConfirmationTokens(): void {
  installTokenRegistry.clear();
}
