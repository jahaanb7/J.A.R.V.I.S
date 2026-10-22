import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { objectSchema, textParam, wholeParam, type ToolRegistry } from './tools';

export interface CodeToolDeps {
  /** The only folder the coding agent may touch. */
  projectRoot: string;
}

const MAX_READ_BYTES = 200_000;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_HITS = 100;
const COMMAND_TIMEOUT_MS = 120_000;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.freebuff']);

/** Resolves a relative path and refuses anything that escapes the project folder. */
export function resolveInside(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the project folder: ${relative}`);
  }
  return absolute;
}

function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" is required`);
  return value;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, root);
    else if (entry.isFile()) yield path.relative(root, full);
  }
}

function isTextFile(file: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|sqlite|db|wasm|woff2?)$/i.test(file);
}

export function registerCodeTools(tools: ToolRegistry, deps: CodeToolDeps): void {
  const root = path.resolve(deps.projectRoot);

  tools.register({
    name: 'code.list',
    description: 'List files in the project folder, skipping node_modules, .git, and dist',
    scope: 'read',
    parameters: objectSchema({ dir: textParam('Folder inside the project. Leave out for the top level') }),
    run: (args) => {
      const dir = typeof args.dir === 'string' && args.dir.trim() ? resolveInside(root, args.dir) : root;
      const files = [...walk(dir, root)].slice(0, MAX_LIST_ENTRIES);
      return { summary: files.length ? files.join('\n') : 'No files found.', data: files };
    },
  });

  tools.register({
    name: 'code.read',
    description: 'Read a text file in the project folder',
    scope: 'read',
    parameters: objectSchema({ path: textParam('File path relative to the project folder') }, ['path']),
    run: (args) => {
      const file = resolveInside(root, requireText(args, 'path'));
      if (statSync(file).size > MAX_READ_BYTES) throw new Error('File is too large to read in one go');
      const content = readFileSync(file, 'utf8');
      return { summary: content, data: { path: path.relative(root, file) } };
    },
  });

  tools.register({
    name: 'code.search',
    description: 'Search text in project files and return matching lines with file and line number',
    scope: 'read',
    parameters: objectSchema({ query: textParam('Text to search for, case-insensitive') }, ['query']),
    run: (args) => {
      const query = requireText(args, 'query').toLowerCase();
      const hits: string[] = [];
      for (const rel of walk(root, root)) {
        if (!isTextFile(rel)) continue;
        const lines = readFileSync(path.join(root, rel), 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (hits.length < MAX_SEARCH_HITS && line.toLowerCase().includes(query)) {
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
        if (hits.length >= MAX_SEARCH_HITS) break;
      }
      return { summary: hits.length ? hits.join('\n') : 'No matches.', data: hits };
    },
  });

  // Writes need approval because the scope is destructive: a rewrite can lose work.
  tools.register({
    name: 'code.write',
    description: 'Create or overwrite a text file in the project folder. Shows up in Approvals before it runs',
    scope: 'destructive',
    parameters: objectSchema(
      {
        path: textParam('File path relative to the project folder'),
        content: textParam('The complete new file content'),
      },
      ['path', 'content'],
    ),
    run: (args) => {
      const file = resolveInside(root, requireText(args, 'path'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, requireText(args, 'content'), 'utf8');
      return { summary: `Wrote ${path.relative(root, file)}.` };
    },
  });

  // Commands are system-level and always wait for approval.
  tools.register({
    name: 'code.run',
    description: 'Run a shell command in the project folder, such as npm test or npm run build. Returns its output',
    scope: 'system',
    parameters: objectSchema(
      {
        command: textParam('The command to run, e.g. "npm test"'),
        timeoutSeconds: wholeParam('Give up after this many seconds. Defaults to 120'),
      },
      ['command'],
    ),
    run: (args) => {
      const command = requireText(args, 'command');
      const timeout = Math.min(Number(args.timeoutSeconds) || COMMAND_TIMEOUT_MS / 1000, 600) * 1000;
      return new Promise((resolve) => {
        execFile('/bin/sh', ['-c', command], { cwd: root, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`.slice(-8000);
          const code = err && 'code' in err ? err.code : 0;
          resolve({
            summary: `Exit ${code ?? 'signal'}:\n${output}`,
            data: { exitCode: code ?? null },
          });
        });
      });
    },
  });
}
