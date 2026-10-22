import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type WidgetKind = 'sticky' | 'custom';

export interface WidgetManifest {
  id: string;
  name: string;
  description: string;
  kind: WidgetKind;
  width: number;
  height: number;
  hideAfterSeconds: number | null;
  createdAt: string;
}

export interface WidgetRecord {
  manifest: WidgetManifest;
  html: string;
}

/** What the desktop host needs to draw a widget. Implemented in the Electron main process. */
export interface WidgetHost {
  show(manifest: WidgetManifest, hideAfterSeconds: number | null): void;
  hide(id?: string): void;
}

export const MAX_WIDGET_BYTES = 200 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Content Security Policy every widget runs under: no network, no external resources. */
export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * Static checks that give the model a clear reason when it writes a widget the sandbox would block.
 * The CSP and the restricted window enforce the same rules at runtime, so this is not the only guard.
 */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /<iframe\b/i, reason: 'iframes are not allowed' },
  { pattern: /<(object|embed|base|frame|frameset)\b/i, reason: 'object, embed, base, and frame tags are not allowed' },
  { pattern: /<script[^>]*\bsrc\s*=/i, reason: 'external scripts are not allowed; put the code inline' },
  {
    pattern: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b|\bimport\s*\(/,
    reason: 'widgets cannot use the network',
  },
  { pattern: /\brequire\s*\(|\bprocess\.|\bchild_process\b/, reason: 'widgets cannot use Node.js' },
];

/** Returns a problem description for a widget's HTML, or null when it passes the static checks. */
export function validateWidgetHtml(html: string): string | null {
  if (!html.trim()) return 'html is required';
  if (Buffer.byteLength(html, 'utf8') > MAX_WIDGET_BYTES) {
    return `html is larger than ${MAX_WIDGET_BYTES / 1024} KB`;
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(html)) return rule.reason;
  }
  return null;
}

/** Adds the sandbox Content Security Policy to a widget page. A page can tighten this but never loosen it. */
export function withSandboxPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => `${match}${meta}`)
    : `${meta}${html}`;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'widget';
}

/** One sticky-note page is shared by every note; each note stores its own text in data.json. */
export const STICKY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Sticky note</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; font-family: -apple-system, system-ui, sans-serif; }
  .note { height: 100%; display: flex; flex-direction: column; background: #fde68a; border-radius: 14px;
    box-shadow: 0 12px 30px rgba(0,0,0,.28); overflow: hidden; }
  .bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px;
    -webkit-app-region: drag; color: #78350f; font-size: 12px; font-weight: 600; letter-spacing: .02em; }
  .close { -webkit-app-region: no-drag; border: 0; background: rgba(120,53,15,.12); color: #78350f;
    width: 22px; height: 22px; border-radius: 11px; cursor: pointer; font-size: 14px; line-height: 1; }
  textarea { flex: 1; margin: 0 10px 10px; border: 0; resize: none; background: transparent; color: #422006;
    font: 15px/1.4 -apple-system, system-ui, sans-serif; outline: none; }
</style>
</head>
<body>
<div class="note">
  <div class="bar"><span>Sticky note</span><button class="close" id="close" title="Hide (Esc)">×</button></div>
  <textarea id="text" placeholder="Type here…"></textarea>
</div>
<script>
  var text = document.getElementById('text');
  var saveTimer = null;
  function pin() { if (window.buffy) window.buffy.pin(); }
  function hide() { if (window.buffy) window.buffy.hide(); }
  document.getElementById('close').onclick = hide;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  text.addEventListener('focus', pin);
  text.addEventListener('input', function () {
    pin();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { if (window.buffy) window.buffy.save({ text: text.value }); }, 300);
  });
  if (window.buffy) {
    window.buffy.load().then(function (data) { if (data && typeof data.text === 'string') text.value = data.text; });
  }
  text.focus();
</script>
</body>
</html>
`;

export class WidgetStore {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(root, { recursive: true });
  }

  create(input: {
    name: string;
    description?: string;
    html: string;
    kind?: WidgetKind;
    width?: number;
    height?: number;
    hideAfterSeconds?: number | null;
  }): WidgetManifest {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    if (!name) throw new Error('name is required');
    const problem = validateWidgetHtml(input.html);
    if (problem) throw new Error(`widget rejected: ${problem}`);

    const id = `${slugify(name)}-${randomBytes(3).toString('hex')}`;
    const manifest: WidgetManifest = {
      id,
      name,
      description: (input.description ?? '').trim().slice(0, 200),
      kind: input.kind ?? 'custom',
      width: clampSize(input.width, 280),
      height: clampSize(input.height, 220),
      hideAfterSeconds: input.hideAfterSeconds ?? null,
      createdAt: this.now().toISOString(),
    };
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(dir, 'index.html'), input.html);
    return manifest;
  }

  list(): WidgetManifest[] {
    const manifests: WidgetManifest[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const file = path.join(this.root, entry.name, 'manifest.json');
      if (!existsSync(file)) continue;
      try {
        manifests.push(JSON.parse(readFileSync(file, 'utf8')) as WidgetManifest);
      } catch {
        // A damaged manifest is skipped rather than breaking the whole list.
      }
    }
    return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): WidgetRecord | null {
    if (!ID_PATTERN.test(id)) return null;
    const dir = this.dirFor(id);
    const manifestFile = path.join(dir, 'manifest.json');
    const htmlFile = path.join(dir, 'index.html');
    if (!existsSync(manifestFile) || !existsSync(htmlFile)) return null;
    return {
      manifest: JSON.parse(readFileSync(manifestFile, 'utf8')) as WidgetManifest,
      html: readFileSync(htmlFile, 'utf8'),
    };
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(this.dirFor(id), { recursive: true, force: true });
    return true;
  }

  loadData(id: string): unknown {
    if (!this.get(id)) throw new Error(`No widget with id ${id}`);
    const file = path.join(this.dirFor(id), 'data.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  saveData(id: string, data: unknown): void {
    if (!this.get(id)) throw new Error(`No widget with id ${id}`);
    const json = JSON.stringify(data ?? null);
    if (Buffer.byteLength(json, 'utf8') > MAX_DATA_BYTES) throw new Error('widget data is too large');
    writeFileSync(path.join(this.dirFor(id), 'data.json'), json);
  }

  private dirFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid widget id: ${id}`);
    return path.join(this.root, id);
  }
}

function clampSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(640, Math.max(160, Math.round(value)));
}
