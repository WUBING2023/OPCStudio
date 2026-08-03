import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendChatSessionMessages,
  compactChatSession,
  createChatSession,
  forkChatSession,
  listChatSessions,
  loadChatSession,
  resumeChatSession,
} from './chatSessionStore.js';

describe('workspace-bound chat sessions', () => {
  const roots: string[] = [];
  const root = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-session-'));
    roots.push(value);
    return value;
  };
  afterEach(() => {
    for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
  });

  it('persists redacted JSONL and supports resume and fork', () => {
    const projectRoot = root();
    const meta = createChatSession(projectRoot, { companyId: 'c1', agentId: 'a1' });
    appendChatSessionMessages(projectRoot, meta.sessionId, [
      { role: 'user', content: 'use api_key=secret-value and continue' },
      { role: 'assistant', content: 'working' },
    ]);
    const loaded = resumeChatSession(projectRoot, meta.sessionId);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].content).not.toContain('secret-value');
    const forked = forkChatSession(projectRoot, meta.sessionId);
    expect(forked.meta.parentSessionId).toBe(meta.sessionId);
    expect(forked.effectiveMessages.map((message) => message.content)).toEqual(
      loaded.effectiveMessages.map((message) => message.content),
    );
    expect(listChatSessions(projectRoot, 'c1', 'a1')).toHaveLength(2);
  });

  it('refuses to load a session copied from another workspace', () => {
    const source = root();
    const target = root();
    const meta = createChatSession(source, { companyId: 'c1', agentId: 'a1' });
    const targetDir = path.join(target, '.opc', 'chat-sessions');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(
      path.join(source, '.opc', 'chat-sessions', `${meta.sessionId}.jsonl`),
      path.join(targetDir, `${meta.sessionId}.jsonl`),
    );
    expect(loadChatSession(target, meta.sessionId)).toBeNull();
  });

  it('compacts deterministically without orphaning a tool result', () => {
    const projectRoot = root();
    const meta = createChatSession(projectRoot, { companyId: 'c1', agentId: 'a1' });
    appendChatSessionMessages(projectRoot, meta.sessionId, [
      ...Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: `old requirement ${index} ${'x'.repeat(1000)}`,
      })),
      { role: 'assistant', content: 'calling tool', toolCalls: [{ id: 'call-1', name: 'read_file' }] },
      { role: 'tool', content: 'tool result', toolUseId: 'call-1' },
      ...Array.from({ length: 5 }, (_, index) => ({
        role: 'assistant' as const,
        content: `recent ${index}`,
      })),
    ]);
    const compacted = compactChatSession(projectRoot, meta.sessionId, {
      minRecentMessages: 6,
      retainTokens: 500,
    });
    expect(compacted).not.toBeNull();
    const effective = loadChatSession(projectRoot, meta.sessionId)!.effectiveMessages;
    expect(effective[0].role).toBe('system');
    expect(effective.find((message) => message.toolUseId === 'call-1')).toBeDefined();
    expect(effective.some((message) => message.toolCalls?.some((call) => call.id === 'call-1'))).toBe(true);
    expect(effective[0].content).toContain('not long-term memory');
  });
});
