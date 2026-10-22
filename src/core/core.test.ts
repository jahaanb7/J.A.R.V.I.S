import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from './db';
import { parseToolCall } from './assistant';
import { parseDateTime } from './datetime';
import { ScriptedModel } from './model';
import { createServices, type Services } from './services';

const T = (hhmm: string) => `2026-10-12T${hhmm}:00.000Z`;

let services: Services | null = null;
const dirs: string[] = [];

function makeServices(model = new ScriptedModel(() => 'hello')): Services {
  services = createServices({
    dbPath: ':memory:',
    model,
    now: () => new Date('2026-10-12T08:00:00.000Z'),
  });
  return services;
}

afterEach(() => {
  services?.close();
  services = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('applies migrations once and is idempotent on reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buffy-db-'));
    dirs.push(dir);
    const file = path.join(dir, 'test.db');
    const first = openDatabase(file);
    const versions = first.prepare('SELECT version FROM schema_migrations').all() as unknown as { version: number }[];
    expect(versions.map((v) => Number(v.version))).toEqual([1]);
    expect(runMigrations(first)).toEqual([]);
    first.close();

    const reopened = openDatabase(file);
    expect(runMigrations(reopened)).toEqual([]);
    reopened.close();
  });
});

describe('calendar', () => {
  it('adds events and reports overlapping conflicts with a suggested free slot', () => {
    const s = makeServices();
    s.calendar.add({ title: 'Physics review', startAt: T('14:00'), endAt: T('15:00') });
    const result = s.calendar.add({ title: 'Robotics', startAt: T('14:30'), endAt: T('15:30') });

    expect(result.conflicts.map((c) => c.title)).toEqual(['Physics review']);
    expect(result.suggestion).toEqual({ startAt: T('15:00'), endAt: T('16:00') });
  });

  it('reports no conflict for back-to-back events', () => {
    const s = makeServices();
    s.calendar.add({ title: 'A', startAt: T('09:00'), endAt: T('10:00') });
    const result = s.calendar.add({ title: 'B', startAt: T('10:00'), endAt: T('11:00') });
    expect(result.conflicts).toEqual([]);
    expect(result.suggestion).toBeNull();
  });

  it('moving an event re-runs conflict detection and excludes itself', () => {
    const s = makeServices();
    const a = s.calendar.add({ title: 'A', startAt: T('09:00'), endAt: T('10:00') }).event;
    s.calendar.add({ title: 'B', startAt: T('11:00'), endAt: T('12:00') });
    const moved = s.calendar.update(a.id, { startAt: T('11:30'), endAt: T('12:30') });
    expect(moved.event.title).toBe('A');
    expect(moved.conflicts.map((c) => c.title)).toEqual(['B']);
    expect(moved.suggestion).toEqual({ startAt: T('12:00'), endAt: T('13:00') });
  });

  it('rejects end-before-start, missing titles, and invalid dates', () => {
    const s = makeServices();
    expect(() => s.calendar.add({ title: 'X', startAt: T('10:00'), endAt: T('09:00') })).toThrow(/after its start/);
    expect(() => s.calendar.add({ title: '  ', startAt: T('09:00'), endAt: T('10:00') })).toThrow(/title is required/);
    expect(() => s.calendar.add({ title: 'X', startAt: 'not a date', endAt: T('10:00') })).toThrow(/must look like/);
  });

  it('lists events overlapping a range in start order', () => {
    const s = makeServices();
    s.calendar.add({ title: 'Late', startAt: T('18:00'), endAt: T('19:00') });
    s.calendar.add({ title: 'Early', startAt: T('08:00'), endAt: T('09:00') });
    s.calendar.add({ title: 'Outside', startAt: '2026-10-20T08:00:00.000Z', endAt: '2026-10-20T09:00:00.000Z' });
    const titles = s.calendar.list({ from: T('00:00'), to: T('23:59') }).map((e) => e.title);
    expect(titles).toEqual(['Early', 'Late']);
  });

  it('suggestSlot skips over multiple back-to-back events', () => {
    const s = makeServices();
    s.calendar.add({ title: 'A', startAt: T('09:00'), endAt: T('10:00') });
    s.calendar.add({ title: 'B', startAt: T('10:00'), endAt: T('11:30') });
    expect(s.calendar.suggestSlot(30, T('09:00'))).toEqual({ startAt: T('11:30'), endAt: T('12:00') });
  });
});

describe('tasks and memory', () => {
  it('orders open tasks by priority and completes them', () => {
    const s = makeServices();
    s.tasks.add({ title: 'Low', priority: 5 });
    const high = s.tasks.add({ title: 'High', priority: 1 });
    expect(s.tasks.list().map((t) => t.title)).toEqual(['High', 'Low']);
    s.tasks.complete(high.id);
    expect(s.tasks.list().map((t) => t.title)).toEqual(['Low']);
  });

  it('validates task priority', () => {
    const s = makeServices();
    expect(() => s.tasks.add({ title: 'x', priority: 9 })).toThrow(/priority/);
  });

  it('recalls memories by keyword and forgets them', () => {
    const s = makeServices();
    const physics = s.memory.add('Studying for the physics olympiad in March', 'goal');
    s.memory.add('Prefers morning study sessions', 'preference');
    expect(s.memory.search('what about physics?').map((m) => m.id)).toEqual([physics.id]);
    expect(s.memory.forget(physics.id)).toBe(true);
    expect(s.memory.search('physics')).toEqual([]);
  });
});

describe('permission gate and approvals', () => {
  it('auto-allows reads and local writes', async () => {
    const s = makeServices();
    const result = await s.tools.invoke('tasks.add', { title: 'Read chapter 4' });
    expect(result.status).toBe('done');
  });

  it('never auto-allows external actions, even after a rule change attempt', async () => {
    const s = makeServices();
    expect(() => s.policy.setRule('external', 'allow')).toThrow(/always require approval/);
    s.tools.register({
      name: 'mail.send',
      description: 'Send an email',
      scope: 'external',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => ({ summary: 'sent' }),
    });
    const result = await s.tools.invoke('mail.send', {});
    expect(result.status).toBe('pending');
  });

  it('runs a tool only after approval, and never after denial', async () => {
    const s = makeServices();
    let runs = 0;
    s.tools.register({
      name: 'files.wipe',
      description: 'Wipe a folder',
      scope: 'destructive',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => {
        runs += 1;
        return { summary: 'wiped' };
      },
    });

    const denied = await s.tools.invoke('files.wipe', { path: '/tmp/x' });
    if (denied.status !== 'pending') throw new Error('expected pending approval');
    expect(s.tools.deny(denied.approval.id).status).toBe('denied');
    expect(runs).toBe(0);

    const second = await s.tools.invoke('files.wipe', {});
    if (second.status !== 'pending') throw new Error('expected pending approval');
    const approved = await s.tools.approve(second.approval.id);
    expect(approved.status).toBe('done');
    expect(runs).toBe(1);
  });

  it('kill switch denies everything, including reads, until resumed', async () => {
    const s = makeServices();
    s.policy.pause();
    const blocked = await s.tools.invoke('tasks.list');
    expect(blocked.status).toBe('denied');
    s.policy.resume();
    expect((await s.tools.invoke('tasks.list')).status).toBe('done');
  });

  it('writes an audit entry for every decision', async () => {
    const s = makeServices();
    await s.tools.invoke('tasks.add', { title: 'Audit me' });
    const actions = s.audit.list().map((e) => `${e.action}:${e.status}`);
    expect(actions).toContain('tasks.add:done');
  });

  it('turns tool errors into error results instead of throwing', async () => {
    const s = makeServices();
    const result = await s.tools.invoke('calendar.update', { id: 9999, title: 'ghost' });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/No event with id 9999/);
  });
});

describe('assistant', () => {
  it('parses plain JSON and fenced JSON tool calls, and ignores normal text', () => {
    expect(parseToolCall('{"tool":"tasks.list","args":{}}')).toEqual({ tool: 'tasks.list', args: {} });
    expect(parseToolCall('```json\n{"tool": "memory.recall", "args": {"query": "x"}}\n```')?.tool).toBe(
      'memory.recall',
    );
    expect(parseToolCall('Sure, your physics review is at 4pm.')).toBeNull();
    expect(parseToolCall('{not json}')).toBeNull();
  });

  it('turns a model tool call into a calendar event and reports the result', async () => {
    const model = new ScriptedModel(() =>
      JSON.stringify({
        tool: 'calendar.add',
        args: { title: 'Physics review', start: T('16:00'), end: T('17:00') },
      }),
    );
    const s = makeServices(model);
    const reply = await s.assistant.send('add physics review at 4pm');
    expect(reply.action?.tool).toBe('calendar.add');
    expect(reply.reply).toMatch(/Added "Physics review"/);
    expect(s.calendar.list().map((e) => e.title)).toEqual(['Physics review']);
    expect(s.assistant.history().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('puts relevant memories and upcoming events into the model context', async () => {
    const model = new ScriptedModel(() => 'Here you go.');
    const s = makeServices(model);
    s.memory.add('Applying to Ivy League schools next year', 'goal');
    s.calendar.add({ title: 'Robotics club', startAt: T('09:30'), endAt: T('10:30') });
    await s.assistant.send('what about my ivy applications?');
    const system = model.calls[0][0].content;
    expect(system).toContain('Applying to Ivy League schools next year');
    expect(system).toContain('Robotics club');
  });

  it('reports an unavailable model without crashing', async () => {
    const model = new ScriptedModel(() => {
      throw new Error('connection refused');
    });
    const s = makeServices(model);
    const reply = await s.assistant.send('hi');
    expect(reply.reply).toMatch(/local model is unavailable: connection refused/);
  });
});

describe('destructive actions', () => {
  it('deleting a calendar event waits for approval instead of running', async () => {
    const s = makeServices();
    const added = s.calendar.add({ title: 'Keep me', startAt: T('09:00'), endAt: T('10:00') });
    const pending = await s.tools.invoke('calendar.remove', { id: added.event.id });
    expect(pending.status).toBe('pending');
    expect(s.calendar.get(added.event.id)).not.toBeNull();
  });
});

describe('tolerant tool-call parsing and ids', () => {
  it('accepts the name/parameters shape small models write, including a stray quote', () => {
    expect(parseToolCall('{"name":"memory.remember",""parameters":{"content":"Applying to Ivy"}}')).toEqual({
      tool: 'memory.remember',
      args: { content: 'Applying to Ivy' },
    });
    expect(parseToolCall('{"tool":"tasks.list","arguments":{}}')).toEqual({ tool: 'tasks.list', args: {} });
  });

  it('accepts the OpenAI-style wrapper and JSON-string arguments that models echo as text', () => {
    expect(
      parseToolCall('{"type":"function","function":{"name":"widgets.create","arguments":{"name":"Clock","html":"<p>x</p>"}}}'),
    ).toEqual({ tool: 'widgets.create', args: { name: 'Clock', html: '<p>x</p>' } });
    expect(parseToolCall('{"name":"tasks.add","arguments":"{\\"title\\":\\"Milk\\"}"}')?.args).toEqual({ title: 'Milk' });
  });

  it('treats an estimate of 0, "N/A", or an empty optional field as not set', async () => {
    const s = makeServices();
    const zero = await s.tools.invoke('tasks.add', { title: 'Buy resistors', estimateMinutes: 0 });
    const empty = await s.tools.invoke('tasks.add', { title: 'Sort parts', estimateMinutes: '', dueAt: '' });
    const words = await s.tools.invoke('tasks.add', { title: 'Label bins', estimateMinutes: 'N/A' });
    expect([zero.status, empty.status, words.status]).toEqual(['done', 'done', 'done']);
    expect(s.tasks.list().map((t) => t.estimateMinutes)).toEqual([null, null, null]);
  });

  it('treats a due date of "null" as no due date, but still rejects a bad real date', async () => {
    const s = makeServices();
    const none = await s.tools.invoke('tasks.add', { title: 'Check dates', dueAt: 'null' });
    expect(none.status).toBe('done');
    expect(s.tasks.list()[0].dueAt).toBeNull();
    const bad = await s.tools.invoke('tasks.add', { title: 'Bad date', dueAt: 'sometime friday' });
    expect(bad.status).toBe('error');
  });

  it('still rejects non-numeric values for required numbers', async () => {
    const s = makeServices();
    const added = s.calendar.add({ title: 'Keep', startAt: T('09:00'), endAt: T('10:00') });
    const result = await s.tools.invoke('calendar.update', { id: 'abc' });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/"id" must be a number/);
    expect(s.calendar.get(added.event.id)).not.toBeNull();
  });

  it('keeps the system prompt free of placeholder wording the model could copy as a value', async () => {
    const model = new ScriptedModel(() => 'ok');
    const s = makeServices(model);
    await s.assistant.send('hello');
    expect(model.toolsSeen[0].find((t) => t.function.name === 'tasks.add')?.function.parameters.properties.title.description).toMatch(/own words/);
    expect(model.calls[0][0].content).toMatch(/Never copy a parameter description/);
  });

  it('gives the model the local dates for the next week so weekday names resolve correctly', async () => {
    // 2026-10-12 is a Monday in local time, so Friday is 2026-10-16.
    const model = new ScriptedModel(() => 'ok');
    const s = makeServices(model);
    await s.assistant.send('hello');
    expect(model.calls[0][0].content).toContain('Friday 2026-10-16');
  });

  it('shows event and task ids to the model so it can change or delete them', async () => {
    const model = new ScriptedModel(() => 'ok');
    const s = makeServices(model);
    const added = s.calendar.add({ title: 'Robotics club', startAt: T('09:30'), endAt: T('10:30') });
    await s.assistant.send('hello');
    expect(model.calls[0][0].content).toContain(`[id ${added.event.id}] Robotics club`);
  });
});

describe('date-times', () => {
  it('reads times without an offset as local time and normalizes offsets', () => {
    expect(parseDateTime('2026-10-15T16:00', 'start')).toBe(new Date(2026, 9, 15, 16, 0).toISOString());
    expect(parseDateTime('2026-10-15T16:00:00+0400', 'start')).toBe('2026-10-15T12:00:00.000Z');
    expect(parseDateTime('2026-10-15T16:00:00Z', 'start')).toBe('2026-10-15T16:00:00.000Z');
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(() => parseDateTime('2026-02-30T10:00', 'start')).toThrow(/not a real calendar date/);
    expect(() => parseDateTime('2026-10-15T25:00', 'start')).toThrow(/invalid time/);
    expect(() => parseDateTime('tomorrow at 4pm', 'start')).toThrow(/must look like/);
  });
});

describe('native tool calls', () => {
  it('runs a native tool call with local-time arguments and sends tool specs to the model', async () => {
    const model = new ScriptedModel(() => ({
      content: '',
      toolCalls: [
        {
          name: 'calendar.add',
          arguments: { title: 'Physics review', start: '2026-10-12T16:00', end: '2026-10-12T17:00' },
        },
      ],
    }));
    const s = makeServices(model);
    const reply = await s.assistant.send('add physics review at 4pm today');
    expect(reply.actions.map((a) => a.tool)).toEqual(['calendar.add']);
    expect(reply.reply).toMatch(/Added "Physics review"/);
    expect(s.calendar.list()[0].startAt).toBe(new Date(2026, 9, 12, 16, 0).toISOString());
    const spec = model.toolsSeen[0].find((t) => t.function.name === 'calendar.add');
    expect(spec?.function.parameters.required).toEqual(['title', 'start', 'end']);
  });

  it('runs several tool calls in order and caps them at five', async () => {
    const model = new ScriptedModel(() => ({
      content: '',
      toolCalls: Array.from({ length: 7 }, (_, i) => ({ name: 'tasks.add', arguments: { title: `Task ${i + 1}` } })),
    }));
    const s = makeServices(model);
    const reply = await s.assistant.send('make seven tasks');
    expect(reply.actions).toHaveLength(5);
    expect(s.tasks.list().map((t) => t.title)).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);
  });

  it('retries once when the model writes a broken tool call, and succeeds on the retry', async () => {
    let calls = 0;
    const model = new ScriptedModel(() => {
      calls += 1;
      return calls === 1 ? '{"name":"tasks.add","parameters{"}' : '{"tool":"tasks.add","args":{"title":"Retry works"}}';
    });
    const s = makeServices(model);
    await s.assistant.send('add a task');
    expect(calls).toBe(2);
    expect(s.tasks.list().map((t) => t.title)).toEqual(['Retry works']);
  });

  it('gives a plain message, not raw JSON, when the broken tool call repeats', async () => {
    const model = new ScriptedModel(() => '{"name":"tasks.add","parameters{"}');
    const s = makeServices(model);
    const reply = await s.assistant.send('add a task');
    expect(model.calls).toHaveLength(2);
    expect(reply.reply).toMatch(/couldn't complete that action cleanly/);
    expect(reply.reply).not.toMatch(/parameters/);
  });

  it('gives the model one corrected attempt after invalid arguments', async () => {
    let calls = 0;
    const model = new ScriptedModel(() => {
      calls += 1;
      return calls === 1
        ? { content: '', toolCalls: [{ name: 'tasks.add', arguments: {} }] }
        : { content: '', toolCalls: [{ name: 'tasks.add', arguments: { title: 'Fixed on retry' } }] };
    });
    const s = makeServices(model);
    const reply = await s.assistant.send('add the task');
    expect(calls).toBe(2);
    expect(reply.reply).toMatch(/Added task "Fixed on retry"/);
    expect(s.tasks.list().map((t) => t.title)).toEqual(['Fixed on retry']);
    const retryMessages = model.calls[1];
    expect(retryMessages.some((m) => m.role === 'tool' && /Invalid arguments for tasks\.add/.test(m.content))).toBe(true);
  });

  it('tells the model about missing arguments without asking the user for approval', async () => {
    const model = new ScriptedModel(() => ({
      content: '',
      toolCalls: [{ name: 'calendar.remove', arguments: {} }],
    }));
    const s = makeServices(model);
    const reply = await s.assistant.send('delete my event');
    expect(reply.reply).toMatch(/Invalid arguments for calendar\.remove: "id" is required/);
    expect(s.tools.pendingApprovals()).toEqual([]);
  });

  it('returns a fixable message when the model sends a date it cannot parse', async () => {
    const model = new ScriptedModel(() => ({
      content: '',
      toolCalls: [{ name: 'calendar.add', arguments: { title: 'X', start: 'tomorrow 4pm', end: '2026-10-12T17:00' } }],
    }));
    const s = makeServices(model);
    const reply = await s.assistant.send('add x tomorrow at 4');
    expect(reply.reply).toMatch(/start must look like/);
    expect(s.calendar.list()).toEqual([]);
  });
});
