import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRuntimeTaskContract,
  readRuntimeTaskContract,
  tightenRuntimeTaskContract,
  writeRuntimeTaskContract,
} from './runtimeTaskContract.js';

describe('RuntimeTaskContract', () => {
  let root = '';
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('persists a hash-verified immutable goal contract', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-task-contract-'));
    const contract = createRuntimeTaskContract({
      runId: 'run-1',
      objective: 'Create sum.js and sum.test.js and run tests',
      companyId: 'c1',
      runType: 'team',
      workRoot: root,
      baseCommit: 'abc',
    });
    expect(contract.acceptance.requiresCode).toBe(true);
    expect(contract.acceptance.requiresTests).toBe(true);
    writeRuntimeTaskContract(root, contract);
    expect(readRuntimeTaskContract(root, 'run-1')?.contractHash).toBe(contract.contractHash);
    const file = path.join(root, '.opc', 'runs', 'run-1', 'task-contract.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('sum.js', 'other.js'), 'utf-8');
    expect(readRuntimeTaskContract(root, 'run-1')).toBeNull();
  });

  it('extracts expected artifacts before English and Chinese punctuation', () => {
    const contract = createRuntimeTaskContract({
      runId: 'run-artifacts',
      objective: 'Create parser.ts, tests in parser.test.ts。Do not add unrelated files.',
      runType: 'team',
      workRoot: 'C:/workspace',
    });
    expect(contract.acceptance.expectedArtifacts).toEqual(['parser.ts', 'parser.test.ts']);
  });

  it('only tightens child requirements and respects a no-code ceiling', () => {
    const original = createRuntimeTaskContract({
      runId: 'run-2',
      objective: 'Calculate the answer. Do not create or modify files.',
      runType: 'quick',
      workRoot: 'C:/work',
    });
    const tightened = tightenRuntimeTaskContract(original, { requiresCode: true, requiresTests: true });
    expect(tightened.acceptance.requiresCode).toBe(false);
    expect(tightened.acceptance.requiresTests).toBe(true);
    expect(tightened.revision).toBe(2);
    expect(tightened.contractHash).not.toBe(original.contractHash);
  });
});
