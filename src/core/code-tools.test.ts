import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServices, type Services } from './services';
import { ScriptedModel } from './model';

let root: string;
let services: Services;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'buffy-project-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const hello = 1;\nconst needle = true;\n');
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules', 'skip.js'), 'needle');
  services = createServices({
    dbPath: ':memory:',
    model: new ScriptedModel(() => 'ok'),
    projectRoot: root,
  });
});

afterEach(() => services.close());

describe('code tools', () => {
  it('lists project files and skips node_modules', async () => {
    const result = await services.tools.invoke('code.list');
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    expect(result.output.data).toEqual([path.join('src', 'app.ts')]);
  });

  it('reads a file inside the project', async () => {
    const result = await services.tools.invoke('code.read', { path: 'src/app.ts' });
    expect(result.status === 'done' && result.output.summary).toContain('hello');
  });

  it('refuses paths that escape the project folder', async () => {
    const result = await services.tools.invoke('code.read', { path: '../../etc/passwd' });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/outside the project/);
  });

  it('searches text and ignores node_modules', async () => {
    const result = await services.tools.invoke('code.search', { query: 'NEEDLE' });
    expect(result.status === 'done' && result.output.summary).toBe('src/app.ts:2: const needle = true;');
  });

  it('asks for approval before writing a file, and writes only after approval', async () => {
    const pending = await services.tools.invoke('code.write', { path: 'notes.md', content: 'hi' });
    expect(pending.status).toBe('pending');
    expect(() => readFileSync(path.join(root, 'notes.md'))).toThrow();
    if (pending.status !== 'pending') return;
    const done = await services.tools.approve(pending.approval.id);
    expect(done.status).toBe('done');
    expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('hi');
  });

  it('asks for approval before running a command', async () => {
    const pending = await services.tools.invoke('code.run', { command: 'echo hi' });
    expect(pending.status).toBe('pending');
  });

  it('runs an approved command in the project folder', async () => {
    const pending = await services.tools.invoke('code.run', { command: 'pwd' });
    if (pending.status !== 'pending') throw new Error('expected approval');
    const done = await services.tools.approve(pending.approval.id);
    expect(done.status === 'done' && done.output.summary).toContain(root);
  });

  it('blocks everything while the kill switch is on', async () => {
    services.policy.pause();
    const result = await services.tools.invoke('code.read', { path: 'src/app.ts' });
    expect(result.status).toBe('denied');
  });
});
