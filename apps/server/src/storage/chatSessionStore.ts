import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJSON, writeJSON } from './jsonFile.js';
import { redactSecrets } from '../security/redact.js';

export const CHAT_SESSION_VERSION = 1;
export type ChatSessionRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatSessionMessage {
  type: 'message';
  id: string;
  role: ChatSessionRole;
  content: string;
  at: string;
  toolCalls?: Array<{ id: string; name: string }>;
  toolUseId?: string;
  sourceMessageId?: string;
}

export interface ChatSessionMeta {
  type: 'meta';
  version: typeof CHAT_SESSION_VERSION;
  sessionId: string;
  companyId: string;
  agentId: string;
  workspaceRoot: string;
  workspaceFingerprint: string;
  createdAt: string;
  parentSessionId?: string;
}

export interface ChatSessionCompaction {
  type: 'compact';
  id: string;
  at: string;
  summary: string;
  retainedMessageIds: string[];
  replacedThroughMessageId?: string;
}

type ChatSessionEvent = ChatSessionMeta | ChatSessionMessage | ChatSessionCompaction;
export interface LoadedChatSession {
  meta: ChatSessionMeta;
  messages: ChatSessionMessage[];
  effectiveMessages: ChatSessionMessage[];
  lastCompaction?: ChatSessionCompaction;
}

interface ActiveSessionIndex { version: 1; active: Record<string, string> }
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
const pairKey = (companyId: string, agentId: string) => `${companyId}::${agentId}`;
const sessionsDir = (root: string) => path.join(root, '.opc', 'chat-sessions');
const indexPath = (root: string) => path.join(sessionsDir(root), 'active.json');
const sessionPath = (root: string, sessionId: string) => path.join(sessionsDir(root), `${safe(sessionId)}.jsonl`);

function canonicalWorkspace(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

export function workspaceFingerprint(root: string): string {
  const canonical = canonicalWorkspace(root).replaceAll('\\', '/').toLowerCase();
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

function appendEvent(root: string, sessionId: string, event: ChatSessionEvent): void {
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  fs.appendFileSync(sessionPath(root, sessionId), JSON.stringify(event) + '\n', 'utf-8');
}

function loadEvents(root: string, sessionId: string): ChatSessionEvent[] {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) return [];
  let raw = '';
  try { raw = fs.readFileSync(sessionPath(root, sessionId), 'utf-8'); } catch { return []; }
  const events: ChatSessionEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as ChatSessionEvent;
      if (event?.type === 'meta' || event?.type === 'message' || event?.type === 'compact') events.push(event);
    } catch { /* keep all valid events before a torn final line */ }
  }
  return events;
}

function readActive(root: string): ActiveSessionIndex {
  const raw = readJSON<ActiveSessionIndex>(indexPath(root), { version: 1, active: {} });
  return raw?.version === 1 && raw.active && typeof raw.active === 'object' ? raw : { version: 1, active: {} };
}

function setActive(root: string, companyId: string, agentId: string, sessionId: string): void {
  const index = readActive(root);
  index.active[pairKey(companyId, agentId)] = sessionId;
  writeJSON(indexPath(root), index);
}

export function createChatSession(
  root: string,
  input: { companyId: string; agentId: string; parentSessionId?: string; sessionId?: string },
): ChatSessionMeta {
  const sessionId = input.sessionId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) throw new Error('invalid session id');
  if (fs.existsSync(sessionPath(root, sessionId))) throw new Error('session already exists');
  const meta: ChatSessionMeta = {
    type: 'meta', version: CHAT_SESSION_VERSION, sessionId,
    companyId: input.companyId, agentId: input.agentId,
    workspaceRoot: canonicalWorkspace(root),
    workspaceFingerprint: workspaceFingerprint(root),
    createdAt: new Date().toISOString(),
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  };
  appendEvent(root, sessionId, meta);
  setActive(root, input.companyId, input.agentId, sessionId);
  return meta;
}

export function loadChatSession(root: string, sessionId: string): LoadedChatSession | null {
  const events = loadEvents(root, sessionId);
  const meta = events.find((event): event is ChatSessionMeta => event.type === 'meta');
  if (!meta || meta.workspaceFingerprint !== workspaceFingerprint(root)) return null;
  const messages = events.filter((event): event is ChatSessionMessage => event.type === 'message');
  const compactions = events.filter((event): event is ChatSessionCompaction => event.type === 'compact');
  const lastCompaction = compactions.at(-1);
  if (!lastCompaction) return { meta, messages, effectiveMessages: messages };
  const retained = new Set(lastCompaction.retainedMessageIds);
  const effectiveMessages: ChatSessionMessage[] = [{
    type: 'message', id: `summary-${lastCompaction.id}`, role: 'system',
    content: lastCompaction.summary, at: lastCompaction.at,
  }, ...messages.filter((message) => retained.has(message.id))];
  return { meta, messages, effectiveMessages, lastCompaction };
}

export function ensureActiveChatSession(root: string, companyId: string, agentId: string): ChatSessionMeta {
  const current = readActive(root).active[pairKey(companyId, agentId)];
  const loaded = current ? loadChatSession(root, current) : null;
  if (loaded && loaded.meta.companyId === companyId && loaded.meta.agentId === agentId) return loaded.meta;
  return createChatSession(root, { companyId, agentId });
}

export function appendChatSessionMessages(
  root: string,
  sessionId: string,
  messages: Array<Omit<ChatSessionMessage, 'type' | 'id' | 'at'> & { id?: string; at?: string }>,
): ChatSessionMessage[] {
  if (!loadChatSession(root, sessionId)) throw new Error('session not found or workspace mismatch');
  const appended: ChatSessionMessage[] = [];
  for (const input of messages) {
    if (!input?.content?.trim()) continue;
    const message: ChatSessionMessage = {
      type: 'message', id: input.id ?? randomUUID(), role: input.role,
      content: redactSecrets(input.content).slice(0, 512 * 1024),
      at: input.at ?? new Date().toISOString(),
      ...(input.toolCalls?.length ? { toolCalls: input.toolCalls.slice(0, 64).map((call) => ({
        id: safe(call.id), name: redactSecrets(call.name).slice(0, 120),
      })) } : {}),
      ...(input.toolUseId ? { toolUseId: safe(input.toolUseId) } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: safe(input.sourceMessageId) } : {}),
    };
    appendEvent(root, sessionId, message);
    appended.push(message);
  }
  return appended;
}

export function resumeChatSession(root: string, sessionId: string): LoadedChatSession {
  const loaded = loadChatSession(root, sessionId);
  if (!loaded) throw new Error('session not found or workspace mismatch');
  setActive(root, loaded.meta.companyId, loaded.meta.agentId, sessionId);
  return loaded;
}

export function forkChatSession(root: string, sourceSessionId: string): LoadedChatSession {
  const source = loadChatSession(root, sourceSessionId);
  if (!source) throw new Error('session not found or workspace mismatch');
  const meta = createChatSession(root, {
    companyId: source.meta.companyId, agentId: source.meta.agentId, parentSessionId: sourceSessionId,
  });
  appendChatSessionMessages(root, meta.sessionId, source.effectiveMessages.map((message) => ({
    role: message.role, content: message.content, toolCalls: message.toolCalls,
    toolUseId: message.toolUseId, sourceMessageId: message.id, at: message.at,
  })));
  return loadChatSession(root, meta.sessionId)!;
}

const estimateTokens = (message: ChatSessionMessage) => Math.ceil(message.content.length / 4) + 8;
function adjustForToolPairs(messages: ChatSessionMessage[], start: number): number {
  let adjusted = start;
  while (adjusted > 0) {
    const first = messages[adjusted];
    if (first.role !== 'tool' || !first.toolUseId) break;
    let producer = -1;
    for (let index = adjusted - 1; index >= 0; index--) {
      if (messages[index].toolCalls?.some((call) => call.id === first.toolUseId)) {
        producer = index;
        break;
      }
    }
    if (producer < 0) break;
    adjusted = producer;
  }
  return adjusted;
}

function deterministicSummary(messages: ChatSessionMessage[]): string {
  const requirements = messages.filter((message) => message.role === 'user')
    .slice(-3).map((message) => message.content.slice(0, 500));
  const pending = messages.filter((message) =>
    /(todo|pending|not finished|unresolved|待办|未完成|尚未|下一步)/i.test(message.content))
    .slice(-4).map((message) => message.content.slice(0, 300));
  const files = [...new Set(messages.flatMap((message) =>
    message.content.match(/(?:[a-zA-Z]:[\\/]|\.\.?[\\/])?[^\s'<>|]+\.[a-zA-Z0-9]{1,12}/g) ?? []))].slice(-12);
  return [
    '## Session compact summary',
    'This deterministic summary is not long-term memory or run evidence.',
    requirements.length ? `Latest user requirements:\n- ${requirements.join('\n- ')}` : '',
    pending.length ? `Unfinished work:\n- ${pending.join('\n- ')}` : '',
    files.length ? `Key files:\n- ${files.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 12_000);
}

export function compactChatSession(
  root: string,
  sessionId: string,
  opts: { retainTokens?: number; minRecentMessages?: number } = {},
): ChatSessionCompaction | null {
  const loaded = loadChatSession(root, sessionId);
  if (!loaded) throw new Error('session not found or workspace mismatch');
  const messages = loaded.effectiveMessages.filter((message) => !message.id.startsWith('summary-'));
  const minRecent = Math.min(Math.max(opts.minRecentMessages ?? 8, 2), 40);
  const budget = Math.min(Math.max(opts.retainTokens ?? 8_000, 500), 50_000);
  let start = Math.max(0, messages.length - minRecent);
  let tokens = messages.slice(start).reduce((sum, message) => sum + estimateTokens(message), 0);
  while (start > 0 && tokens + estimateTokens(messages[start - 1]) <= budget) {
    start--;
    tokens += estimateTokens(messages[start]);
  }
  start = adjustForToolPairs(messages, start);
  if (start <= 0) return null;
  const event: ChatSessionCompaction = {
    type: 'compact', id: randomUUID(), at: new Date().toISOString(),
    summary: deterministicSummary(messages.slice(0, start)),
    retainedMessageIds: messages.slice(start).map((message) => message.id),
    replacedThroughMessageId: messages[start - 1]?.id,
  };
  appendEvent(root, sessionId, event);
  return event;
}

export function listChatSessions(root: string, companyId?: string, agentId?: string): ChatSessionMeta[] {
  let names: string[] = [];
  try { names = fs.readdirSync(sessionsDir(root)); } catch { return []; }
  return names.filter((name) => name.endsWith('.jsonl'))
    .map((name) => loadChatSession(root, name.slice(0, -6))?.meta)
    .filter((meta): meta is ChatSessionMeta => !!meta)
    .filter((meta) => !companyId || meta.companyId === companyId)
    .filter((meta) => !agentId || meta.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
