import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readDocByPk, upsertDoc } from "./sqlite/docTableBackend.js";

// 对话线程持久化(用户实测:问 CEO"上个对话问了什么",CEO 答"看不到线程外历史"——根因是 chatRoutes
// 每次只把当前一句发给模型,历史既不注入也不落盘,刷新/换引擎全丢)。本 store 按 companyId+agentId
// 存一条对话线程(role/content/at),追加写,单线程双上限:最近 MAX_TURNS 条 + 总字节 MAX_BYTES,
// 超限从最旧截断。落盘 .opc/chat-threads/<companyId>__<agentId>.json,经 jsonFile 原子写。带 v 字段
// 供未来结构演进迁移。历史注入模型侧(见 selectHistoryForPrompt)与执行引擎无关,故换订阅/引擎不丢上下文。

import { appendChatSessionMessages, ensureActiveChatSession } from './chatSessionStore.js';

export const CHAT_THREAD_VERSION = 1;

// 单线程滚动上限:最近 N 条(用户要求"如最近 60 条")。
const MAX_TURNS = 60;
// 总字节上限:即便条数没到 60,单条超长也可能撑爆 prompt,故再加一层字节闸,超限从最旧截断。
const MAX_BYTES = 128 * 1024;

// 注入 prompt 的默认预算:最近 N 条 + token 预算(~4 字符/token 的粗估,与 tokenEstimate 同口径)。
const DEFAULT_HISTORY_TURNS = 12;
const DEFAULT_HISTORY_TOKEN_BUDGET = 3000;

export type ChatTurnRole = "user" | "assistant";

export interface ChatThreadTurn {
  role: ChatTurnRole;
  content: string;
  at: string; // ISO
}

interface ChatThreadFile {
  v: number;
  companyId: string;
  agentId: string;
  turns: ChatThreadTurn[];
}

const safe = (s: string) => ((s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "_");

/** 线程标识(companyId::agentId)——响应回给前端做对齐用,不参与磁盘路径拼接。 */
export function chatThreadId(companyId: string, agentId: string): string {
  return `${companyId}::${agentId}`;
}

function threadPath(root: string, companyId: string, agentId: string): string {
  return path.join(root, ".opc", "chat-threads", `${safe(companyId)}__${safe(agentId)}.json`);
}

function isValidTurn(t: unknown): t is ChatThreadTurn {
  const x = t as ChatThreadTurn;
  return !!x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string";
}

// 战役B·Phase B2a:接后端开关。每条线程 = chat_threads 表一行(threadKey = companyId::agentId,原始值)。
// 默认 json 逐字节不变;sqlite 时读走该行 doc(权威)、写【双写】(每对一 JSON 文件照写 + 单行 upsert)。
// 注意:磁盘文件名经 safe() 净化,但 threadKey/pk 用**原始** companyId/agentId(与迁移器一致)。

/** 读取整条线程(全部落盘条目;损坏/不存在→空)。 */
export function loadThread(root: string, companyId: string, agentId: string): ChatThreadTurn[] {
  const raw = isSqliteBackend(root)
    ? ((readDocByPk(openBusinessDb(root), "chat_threads", chatThreadId(companyId, agentId)) as ChatThreadFile | undefined) ?? null)
    : readJSON<ChatThreadFile | null>(threadPath(root, companyId, agentId), null);
  if (!raw || !Array.isArray(raw.turns)) return [];
  return raw.turns.filter(isValidTurn).map((t) => ({ role: t.role, content: t.content, at: typeof t.at === "string" ? t.at : "" }));
}

/** 最近 n 条(前端拉线程渲染 / 响应附最近历史用)。 */
export function getRecentTurns(root: string, companyId: string, agentId: string, n: number): ChatThreadTurn[] {
  const all = loadThread(root, companyId, agentId);
  return n > 0 ? all.slice(-n) : all;
}

function rollAndSave(root: string, companyId: string, agentId: string, turns: ChatThreadTurn[]): ChatThreadTurn[] {
  let kept = turns.slice(-MAX_TURNS);
  // 字节闸:始终至少保留 1 条(避免单条超长把线程清空成 0),从最旧逐条丢弃直到落进预算。
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), "utf-8") > MAX_BYTES) {
    kept = kept.slice(1);
  }
  const fileObj: ChatThreadFile = { v: CHAT_THREAD_VERSION, companyId, agentId, turns: kept };
  writeJSON(threadPath(root, companyId, agentId), fileObj);
  if (isSqliteBackend(root)) {
    upsertDoc(openBusinessDb(root), "chat_threads", chatThreadId(companyId, agentId), fileObj);
  }
  return kept;
}

/**
 * 追加若干条(通常是一轮 user + assistant),空白/非法条目过滤后落盘,返回滚动截断后的整条线程。
 * atIso 供测试注入固定时间戳;每条也可自带 at(优先)。
 */
export function appendTurns(
  root: string,
  companyId: string,
  agentId: string,
  newTurns: Array<{ role: ChatTurnRole; content: string; at?: string }>,
  atIso?: string,
): ChatThreadTurn[] {
  const now = atIso ?? new Date().toISOString();
  const stamped: ChatThreadTurn[] = (newTurns || [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content, at: t.at ?? now }));
  if (stamped.length === 0) return loadThread(root, companyId, agentId);
  const existing = loadThread(root, companyId, agentId);
  const saved = rollAndSave(root, companyId, agentId, [...existing, ...stamped]);
  try {
    const session = ensureActiveChatSession(root, companyId, agentId);
    appendChatSessionMessages(root, session.sessionId, stamped);
  } catch { /* compatibility storage remains available if the session journal cannot be written */ }
  return saved;
}

/**
 * 折进模型上下文的历史裁剪:最近 maxTurns 条,再按 token 预算从最旧丢弃直到落进预算——始终至少保留
 * 最后 1 条(否则等于没历史)。token 用 ~4 字符/token 粗估(与 runtime/tokenEstimate 同口径),每条
 * 额外 +4 覆盖 role/分隔开销。历史在模型侧注入,与执行引擎无关,故换订阅/换引擎上下文都连续。
 */
export function selectHistoryForPrompt(
  turns: ChatThreadTurn[],
  opts?: { maxTurns?: number; maxTokens?: number },
): ChatThreadTurn[] {
  const maxTurns = opts?.maxTurns ?? DEFAULT_HISTORY_TURNS;
  const maxTokens = opts?.maxTokens ?? DEFAULT_HISTORY_TOKEN_BUDGET;
  let recent = (turns || []).slice(-maxTurns);
  const est = (t: ChatThreadTurn) => Math.ceil((t.content?.length ?? 0) / 4) + 4;
  let total = recent.reduce((s, t) => s + est(t), 0);
  while (recent.length > 1 && total > maxTokens) {
    total -= est(recent[0]);
    recent = recent.slice(1);
  }
  return recent;
}
