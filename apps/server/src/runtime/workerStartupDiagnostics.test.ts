import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendWorkerStartupDiagnostic,
  buildWorkerStartupDiagnostic,
} from './workerStartupDiagnostics.js';

const base = {
  runId: 'run-startup',
  agentId: 'agent-1',
  taskId: 'task-1',
  attempt: 1,
  framework: 'codex',
} as const;

describe('worker startup diagnostics', () => {
  it('classifies transport, trust, permission and prompt failures', () => {
    expect(buildWorkerStartupDiagnostic({ ...base, error: 'WebSocket handshake failed' }).classification).toBe('transport');
    expect(buildWorkerStartupDiagnostic({ ...base, error: 'Trust this workspace before continuing' }).classification).toBe('trust_prompt');
    expect(buildWorkerStartupDiagnostic({ ...base, error: '需要确认工作区信任' }).classification).toBe('trust_prompt');
    expect(buildWorkerStartupDiagnostic({ ...base, error: 'Write tool ok=false: permission denied' }).classification).toBe('tool_permission');
    expect(buildWorkerStartupDiagnostic({ ...base, error: '文件工具拒绝访问' }).classification).toBe('tool_permission');
    expect(buildWorkerStartupDiagnostic({ ...base, error: 'prompt acceptance timed out' }).classification).toBe('prompt_acceptance_timeout');
    expect(buildWorkerStartupDiagnostic({ ...base, error: 'provider 配置缺失' }).classification).toBe('configuration');
  });

  it('redacts secrets and appends one JSONL record', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-worker-startup-'));
    const diagnostic = appendWorkerStartupDiagnostic({
      projectRoot: root,
      ...base,
      error: 'invalid api_key=sk-secret123456789',
    });
    expect(diagnostic.message).not.toContain('sk-secret');
    const file = path.join(root, '.opc', 'runs', base.runId, 'worker-startup-diagnostics.jsonl');
    const rows = fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].classification).toBe('configuration');
    expect(rows[0].suggestedAction).toContain('深度体检');
  });
});
