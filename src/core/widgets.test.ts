import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBriefing } from './briefing';
import { ScriptedModel } from './model';
import { createServices, type Services } from './services';
import { validateWidgetHtml, withSandboxPolicy, WidgetStore, type WidgetHost, type WidgetManifest } from './widgets';

const dirs: string[] = [];
let services: Services | null = null;

afterEach(() => {
  services?.close();
  services = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buffy-widget-test-'));
  dirs.push(dir);
  return dir;
}

class FakeHost implements WidgetHost {
  shown: { id: string; hideAfterSeconds: number | null }[] = [];
  hidden: (string | undefined)[] = [];
  show(manifest: WidgetManifest, hideAfterSeconds: number | null): void {
    this.shown.push({ id: manifest.id, hideAfterSeconds });
  }
  hide(id?: string): void {
    this.hidden.push(id);
  }
}

function makeServices(host = new FakeHost(), now = () => new Date(2026, 9, 12, 8, 0)): { s: Services; host: FakeHost } {
  services = createServices({
    dbPath: ':memory:',
    widgetsDir: tempDir(),
    widgetHost: host,
    model: new ScriptedModel(() => 'ok'),
    now,
  });
  return { s: services, host };
}

const SIMPLE_HTML = '<!doctype html><html><head></head><body><p>Hi</p></body></html>';

describe('widget store', () => {
  it('saves a widget as a folder with a manifest and HTML, then lists and reads it back', () => {
    const store = new WidgetStore(tempDir());
    const manifest = store.create({ name: 'Pomodoro timer', description: 'Focus timer', html: SIMPLE_HTML });
    expect(manifest.id).toMatch(/^pomodoro-timer-[0-9a-f]{6}$/);
    expect(store.list().map((m) => m.name)).toEqual(['Pomodoro timer']);
    expect(store.get(manifest.id)?.html).toBe(SIMPLE_HTML);
  });

  it('removes a widget and refuses ids that could escape the widgets folder', () => {
    const store = new WidgetStore(tempDir());
    const manifest = store.create({ name: 'Temp', html: SIMPLE_HTML });
    expect(store.remove(manifest.id)).toBe(true);
    expect(store.get(manifest.id)).toBeNull();
    expect(() => store.get('../etc')).not.toThrow();
    expect(store.get('../etc')).toBeNull();
    expect(() => store.saveData('../etc', {})).toThrow(/Invalid widget id|No widget/);
  });

  it('stores per-widget data and rejects oversized data', () => {
    const store = new WidgetStore(tempDir());
    const manifest = store.create({ name: 'Notes', html: SIMPLE_HTML });
    store.saveData(manifest.id, { text: 'buy milk' });
    expect(store.loadData(manifest.id)).toEqual({ text: 'buy milk' });
    expect(() => store.saveData(manifest.id, 'x'.repeat(70 * 1024))).toThrow(/too large/);
  });
});

describe('widget sandbox checks', () => {
  it('rejects network, Node, iframe, and external script use with a reason the model can act on', () => {
    expect(validateWidgetHtml('<script>fetch("https://x.test")</script>')).toMatch(/network/);
    expect(validateWidgetHtml('<script>require("fs")</script>')).toMatch(/Node/);
    expect(validateWidgetHtml('<iframe src="x"></iframe>')).toMatch(/iframes/);
    expect(validateWidgetHtml('<script src="https://cdn.test/a.js"></script>')).toMatch(/external scripts/);
    expect(validateWidgetHtml('')).toMatch(/required/);
  });

  it('accepts a plain inline widget', () => {
    expect(validateWidgetHtml('<div>Timer</div><script>let n = 0;</script>')).toBeNull();
  });

  it('adds a Content Security Policy that blocks network and external resources', () => {
    const html = withSandboxPolicy(SIMPLE_HTML);
    expect(html).toContain("default-src 'none'");
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<body>'));
  });
});

describe('widget tools', () => {
  it('sticky.show saves the note, shows it for the requested seconds, and keeps its text', async () => {
    const { s, host } = makeServices();
    const result = await s.tools.invoke('sticky.show', { text: 'Buy milk', seconds: 20 });
    expect(result.status).toBe('done');
    expect(host.shown).toHaveLength(1);
    expect(host.shown[0].hideAfterSeconds).toBe(20);
    const id = host.shown[0].id;
    expect(s.widgets.loadData(id)).toEqual({ text: 'Buy milk' });
    expect(s.widgets.get(id)?.html).toContain('Sticky note');
  });

  it('sticky.show uses a default of 25 seconds and clamps extremes', async () => {
    const { s, host } = makeServices();
    await s.tools.invoke('sticky.show', { text: 'a' });
    await s.tools.invoke('sticky.show', { text: 'b', seconds: 99999 });
    expect(host.shown.map((x) => x.hideAfterSeconds)).toEqual([25, 600]);
  });

  it('widgets.create rejects unsafe HTML and does not show it', async () => {
    const { s, host } = makeServices();
    const result = await s.tools.invoke('widgets.create', {
      name: 'Weather',
      html: '<script>fetch("https://weather.test")</script>',
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/widget rejected: widgets cannot use the network/);
    expect(host.shown).toEqual([]);
    expect(s.widgets.list()).toEqual([]);
  });

  it('widgets.create saves and shows a safe widget, and widgets.show re-shows it', async () => {
    const { s, host } = makeServices();
    const created = await s.tools.invoke('widgets.create', {
      name: 'Pomodoro timer',
      html: '<div id="t">25:00</div><script>document.title="pomodoro";</script>',
      hideAfterSeconds: 60,
    });
    expect(created.status).toBe('done');
    const id = host.shown[0].id;
    expect(host.shown[0].hideAfterSeconds).toBe(60);
    const shown = await s.tools.invoke('widgets.show', { id });
    expect(shown.status).toBe('done');
    expect(host.shown).toHaveLength(2);
  });

  it('widgets.delete waits for approval, then hides and removes the widget', async () => {
    const { s, host } = makeServices();
    const created = await s.tools.invoke('widgets.create', { name: 'Temp', html: SIMPLE_HTML });
    if (created.status !== 'done') throw new Error('expected widget to be created');
    const id = host.shown[0].id;
    const pending = await s.tools.invoke('widgets.delete', { id });
    expect(pending.status).toBe('pending');
    expect(s.widgets.get(id)).not.toBeNull();
    if (pending.status !== 'pending') throw new Error('expected pending approval');
    expect((await s.tools.approve(pending.approval.id)).status).toBe('done');
    expect(s.widgets.get(id)).toBeNull();
    expect(host.hidden).toContain(id);
  });

  it('widgets.hide with no id hides everything', async () => {
    const { s, host } = makeServices();
    await s.tools.invoke('widgets.hide', {});
    expect(host.hidden).toEqual([undefined]);
  });

  it('keeps only the 20 most recent sticky notes', async () => {
    const { s } = makeServices();
    for (let i = 0; i < 22; i += 1) {
      await s.tools.invoke('sticky.show', { text: `note ${i}`, seconds: 5 });
    }
    const stickies = s.widgets.list().filter((m) => m.kind === 'sticky');
    expect(stickies).toHaveLength(20);
  });
});

describe('briefing', () => {
  it("summarizes today's events, top tasks, and deadlines in the next three days", async () => {
    const now = () => new Date(2026, 9, 12, 8, 0);
    const { s } = makeServices(new FakeHost(), now);
    s.calendar.add({
      title: 'Physics review',
      startAt: new Date(2026, 9, 12, 16, 0).toISOString(),
      endAt: new Date(2026, 9, 12, 17, 0).toISOString(),
    });
    s.tasks.add({ title: 'Finish chassis', dueAt: new Date(2026, 9, 14, 18, 0).toISOString(), priority: 2 });
    s.tasks.add({ title: 'Read paper', dueAt: new Date(2026, 10, 30, 9, 0).toISOString() });

    const briefing = buildBriefing({ calendar: s.calendar, tasks: s.tasks, now });
    expect(briefing.summary).toMatch(/Today: 1 event \(Physics review at 4:00 PM\)/);
    expect(briefing.summary).toMatch(/2 open tasks, top priority: Finish chassis \(P2\)/);
    expect(briefing.summary).toMatch(/Due in the next 3 days: Finish chassis/);
    expect(briefing.deadlines.map((t) => t.title)).toEqual(['Finish chassis']);

    const result = await s.tools.invoke('briefing.today');
    expect(result.status).toBe('done');
  });
});
