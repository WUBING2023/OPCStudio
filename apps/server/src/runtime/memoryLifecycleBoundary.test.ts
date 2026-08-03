import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(runtimeDir, '..');
const read = (file: string) => fs.readFileSync(file, 'utf-8');

describe('P2 memory lifecycle boundaries', () => {
  it('session compact cannot write long-term memory or skills', () => {
    const source = read(path.join(serverSrc, 'storage', 'chatSessionStore.ts'));
    expect(source).not.toMatch(/memoryGovernance|layeredMemory|skillStore|proposeMemory|writeLayeredMemory/);
    expect(source).toContain('not long-term memory or run evidence');
  });

  it('memory proposal lifecycle does not create or incubate skills', () => {
    const source = read(path.join(runtimeDir, 'memoryGovernance.ts'));
    expect(source).not.toMatch(/skillStore|createSkill|incubat/i);
  });

  it('skill lifecycle does not approve or curate memories', () => {
    const source = read(path.join(serverSrc, 'routes', 'skillRoutes.ts'));
    expect(source).not.toMatch(/memoryGovernance|memoryCurator|proposeMemory|writeLayeredMemory/);
  });

  it('Dream model merges terminate at a review proposal', () => {
    const source = read(path.join(runtimeDir, 'memoryCurator.ts'));
    expect(source).toContain('kind: "propose_merge"');
    expect(source).toContain('autoApprove: false');
    expect(source).not.toMatch(/topic:\s*["']curated["'][\s\S]{0,160}status:\s*["']approved["']/);
  });
});
