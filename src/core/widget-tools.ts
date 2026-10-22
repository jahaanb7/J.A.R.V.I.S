import type { EventBus } from './events';
import { objectSchema, textParam, wholeParam, type ToolRegistry } from './tools';
import { STICKY_HTML, WidgetStore, type WidgetHost, type WidgetManifest } from './widgets';

export interface WidgetToolDeps {
  store: WidgetStore;
  host: WidgetHost;
  bus?: EventBus;
}

/** Keeps the widget folder from growing without limit when many sticky notes are made. */
const MAX_STICKY_NOTES = 20;
const DEFAULT_STICKY_SECONDS = 25;

function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" is required`);
  return value.trim();
}

function optionalInt(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function registerWidgetTools(tools: ToolRegistry, deps: WidgetToolDeps): void {
  const { store, host, bus } = deps;

  const changed = () => bus?.publish('widgets.changed', store.list());

  const pruneStickyNotes = () => {
    const stickies = store.list().filter((m) => m.kind === 'sticky');
    for (const old of stickies.slice(0, Math.max(0, stickies.length - MAX_STICKY_NOTES))) {
      host.hide(old.id);
      store.remove(old.id);
    }
  };

  tools.register({
    name: 'sticky.show',
    description: 'Show a sticky note on the screen over any app. It hides by itself after a few seconds',
    scope: 'local_write',
    parameters: objectSchema(
      {
        text: textParam('What the note says'),
        seconds: wholeParam('How long to show it, in seconds. Defaults to 25'),
      },
      ['text'],
    ),
    run: (args) => {
      const text = requireText(args, 'text');
      const seconds = clamp(optionalInt(args, 'seconds') ?? DEFAULT_STICKY_SECONDS, 3, 600);
      const manifest = store.create({
        name: 'Sticky note',
        description: text.slice(0, 80),
        kind: 'sticky',
        html: STICKY_HTML,
        width: 260,
        height: 240,
        hideAfterSeconds: seconds,
      });
      store.saveData(manifest.id, { text });
      pruneStickyNotes();
      host.show(manifest, seconds);
      changed();
      return { summary: `Showing a sticky note for ${seconds} seconds: "${text}"`, data: manifest };
    },
  });

  tools.register({
    name: 'widgets.create',
    description:
      'Create a new widget from HTML, CSS, and JavaScript written inline, then show it on screen. Any interactive behavior (timers, buttons, counters, clocks) needs working JavaScript in a <script> tag. Widgets run in a sandbox with no network access and no access to files or Node.js',
    scope: 'local_write',
    parameters: objectSchema(
      {
        name: textParam('Short widget name, e.g. "Pomodoro timer"'),
        description: textParam('What the widget does'),
        html: textParam('A complete HTML page with inline <style> and <script>. No external files or network calls'),
        hideAfterSeconds: wholeParam('Only if the user asks for it to hide by itself. Leave out otherwise, so it stays until hidden'),
      },
      ['name', 'html'],
    ),
    run: (args) => {
      const manifest = store.create({
        name: requireText(args, 'name'),
        description: typeof args.description === 'string' ? args.description : '',
        html: requireText(args, 'html'),
        hideAfterSeconds: optionalInt(args, 'hideAfterSeconds') ?? null,
      });
      host.show(manifest, manifest.hideAfterSeconds);
      changed();
      return { summary: `Created and showed widget "${manifest.name}" (id ${manifest.id}).`, data: manifest };
    },
  });

  tools.register({
    name: 'widgets.show',
    description: 'Show a saved widget on screen',
    scope: 'local_write',
    parameters: objectSchema(
      {
        id: textParam('Widget id from widgets.list'),
        seconds: wholeParam('Hide after this many seconds. Leave out to keep it until hidden'),
      },
      ['id'],
    ),
    run: (args) => {
      const id = requireText(args, 'id');
      const record = store.get(id);
      if (!record) throw new Error(`No widget with id ${id}`);
      const seconds = optionalInt(args, 'seconds') ?? record.manifest.hideAfterSeconds;
      host.show(record.manifest, seconds);
      return { summary: `Showing "${record.manifest.name}".`, data: record.manifest };
    },
  });

  tools.register({
    name: 'widgets.hide',
    description: 'Hide one widget, or every widget when no id is given',
    scope: 'local_write',
    parameters: objectSchema({ id: textParam('Widget id. Leave out to hide everything') }),
    run: (args) => {
      const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
      host.hide(id);
      return { summary: id ? `Hid widget ${id}.` : 'Hid all widgets.' };
    },
  });

  tools.register({
    name: 'widgets.list',
    description: 'List saved widgets and sticky notes',
    scope: 'read',
    parameters: objectSchema({}),
    run: () => {
      const manifests: WidgetManifest[] = store.list();
      const summary = manifests.length
        ? manifests.map((m) => `${m.name} (id ${m.id})`).join('; ')
        : 'No widgets yet.';
      return { summary, data: manifests };
    },
  });

  tools.register({
    name: 'widgets.delete',
    description: 'Delete a saved widget permanently',
    scope: 'destructive',
    parameters: objectSchema({ id: textParam('Widget id from widgets.list') }, ['id']),
    run: (args) => {
      const id = requireText(args, 'id');
      host.hide(id);
      if (!store.remove(id)) throw new Error(`No widget with id ${id}`);
      changed();
      return { summary: `Deleted widget ${id}.` };
    },
  });
}
