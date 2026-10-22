import type { Calendar, CalendarEvent } from './calendar';
import type { MemoryStore } from './memory';
import type { Tasks } from './tasks';
import { isBlank, type ParamSchema, type ToolParameters, type ToolOutput, type ToolRegistry } from './tools';

export interface BuiltinDeps {
  calendar: Calendar;
  tasks: Tasks;
  memory: MemoryStore;
  now?: () => Date;
}

const text = (description: string): ParamSchema => ({ type: 'string', description });
const whole = (description: string): ParamSchema => ({ type: 'integer', description });

function schema(properties: Record<string, ParamSchema>, required: string[] = []): ToolParameters {
  return { type: 'object', properties, required };
}

const WHEN_LOCAL = 'ISO 8601 date-time, e.g. 2026-10-15T16:00 (local time) or 2026-10-15T16:00:00-04:00';

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && !isBlank(value) ? value : undefined;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const raw = args[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a number`);
  return value;
}

/** Optional numbers that are missing or not numeric ("N/A") are treated as not given. */
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const raw = args[key];
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function describeSchedule(
  prefix: string,
  event: CalendarEvent,
  conflicts: CalendarEvent[],
  suggestion: { startAt: string; endAt: string } | null,
): ToolOutput {
  let summary = `${prefix} "${event.title}" (${formatTime(event.startAt)} to ${formatTime(event.endAt)}).`;
  if (conflicts.length > 0) {
    summary += ` Conflicts with: ${conflicts.map((c) => `"${c.title}"`).join(', ')}.`;
    if (suggestion) summary += ` Suggested free slot: ${formatTime(suggestion.startAt)}.`;
  }
  return { summary };
}

export function registerBuiltinTools(tools: ToolRegistry, deps: BuiltinDeps): void {
  const { calendar, tasks, memory, now = () => new Date() } = deps;

  tools.register({
    name: 'calendar.add',
    description: 'Add an event to the calendar and report any conflicts',
    scope: 'local_write',
    parameters: schema(
      {
        title: text("What the event is called, in the user's own words"),
        start: text(`Start. ${WHEN_LOCAL}`),
        end: text(`End. ${WHEN_LOCAL}. Must be after start`),
        location: text('Optional location'),
        notes: text('Optional notes'),
      },
      ['title', 'start', 'end'],
    ),
    run: (args) => {
      const result = calendar.add({
        title: requireString(args, 'title'),
        startAt: requireString(args, 'start'),
        endAt: requireString(args, 'end'),
        location: optionalString(args, 'location'),
        notes: optionalString(args, 'notes'),
      });
      return { ...describeSchedule('Added', result.event, result.conflicts, result.suggestion), data: result };
    },
  });

  tools.register({
    name: 'calendar.update',
    description: 'Change an existing calendar event (move, rename, or edit it)',
    scope: 'local_write',
    parameters: schema(
      {
        id: whole('Event id from calendar.list'),
        title: text('New title'),
        start: text(`New start. ${WHEN_LOCAL}`),
        end: text(`New end. ${WHEN_LOCAL}`),
        location: text('New location'),
        notes: text('New notes'),
      },
      ['id'],
    ),
    run: (args) => {
      const id = requireNumber(args, 'id');
      const result = calendar.update(id, {
        title: optionalString(args, 'title'),
        startAt: optionalString(args, 'start'),
        endAt: optionalString(args, 'end'),
        location: optionalString(args, 'location'),
        notes: optionalString(args, 'notes'),
      });
      return { ...describeSchedule('Updated', result.event, result.conflicts, result.suggestion), data: result };
    },
  });

  tools.register({
    name: 'calendar.remove',
    description: 'Delete a calendar event permanently',
    scope: 'destructive',
    parameters: schema({ id: whole('Event id from calendar.list') }, ['id']),
    run: (args) => {
      const id = requireNumber(args, 'id');
      const removed = calendar.remove(id);
      if (!removed) throw new Error(`No event with id ${id}`);
      return { summary: `Deleted event ${id}.` };
    },
  });

  tools.register({
    name: 'calendar.list',
    description: 'List calendar events, optionally within a time range',
    scope: 'read',
    parameters: schema({
      from: text(`Range start. ${WHEN_LOCAL}`),
      to: text(`Range end. ${WHEN_LOCAL}`),
    }),
    run: (args) => {
      const events = calendar.list({ from: optionalString(args, 'from'), to: optionalString(args, 'to') });
      const summary = events.length
        ? events.map((e) => `${e.title} (${formatTime(e.startAt)})`).join('; ')
        : 'No events in that range.';
      return { summary, data: events };
    },
  });

  tools.register({
    name: 'calendar.suggest_slot',
    description: 'Find the first free time block of a given length',
    scope: 'read',
    parameters: schema(
      {
        durationMinutes: whole('Length of the free block in minutes'),
        after: text(`Search from this time. ${WHEN_LOCAL}. Defaults to now`),
      },
      ['durationMinutes'],
    ),
    run: (args) => {
      const slot = calendar.suggestSlot(
        requireNumber(args, 'durationMinutes'),
        optionalString(args, 'after') ?? now().toISOString(),
      );
      if (!slot) return { summary: 'No free slot found in the next 7 days.' };
      return { summary: `Free slot: ${formatTime(slot.startAt)} to ${formatTime(slot.endAt)}.`, data: slot };
    },
  });

  tools.register({
    name: 'tasks.add',
    description: 'Add a task or to-do item',
    scope: 'local_write',
    parameters: schema(
      {
        title: text("What the task is, in the user's own words"),
        dueAt: text(`Due date. ${WHEN_LOCAL}`),
        priority: whole('1 (highest) to 5 (lowest). Defaults to 3'),
        estimateMinutes: whole('Estimated length in minutes. Omit if unknown'),
      },
      ['title'],
    ),
    run: (args) => {
      // Models often send 0 to mean "no estimate"; treat non-positive values as unknown.
      const estimate = optionalNumber(args, 'estimateMinutes');
      const task = tasks.add({
        title: requireString(args, 'title'),
        dueAt: optionalString(args, 'dueAt') ?? null,
        priority: optionalNumber(args, 'priority'),
        estimateMinutes: estimate !== undefined && estimate > 0 ? estimate : null,
      });
      return { summary: `Added task "${task.title}".`, data: task };
    },
  });

  tools.register({
    name: 'tasks.list',
    description: 'List open tasks in priority order',
    scope: 'read',
    parameters: schema({}),
    run: () => {
      const open = tasks.list();
      const summary = open.length ? open.map((t) => `${t.title} (P${t.priority})`).join('; ') : 'No open tasks.';
      return { summary, data: open };
    },
  });

  tools.register({
    name: 'tasks.complete',
    description: 'Mark a task as done',
    scope: 'local_write',
    parameters: schema({ id: whole('Task id from tasks.list') }, ['id']),
    run: (args) => {
      const task = tasks.complete(requireNumber(args, 'id'));
      return { summary: `Completed "${task.title}".`, data: task };
    },
  });

  tools.register({
    name: 'memory.remember',
    description: 'Save a fact, preference, or goal about the user for later recall',
    scope: 'local_write',
    parameters: schema(
      {
        content: text('What to remember, as one clear sentence'),
        kind: { type: 'string', enum: ['fact', 'preference', 'goal', 'project', 'person'], description: 'Kind of memory. Defaults to fact' },
      },
      ['content'],
    ),
    run: (args) => {
      const entry = memory.add(requireString(args, 'content'), optionalString(args, 'kind') ?? 'fact');
      return { summary: `Remembered: ${entry.content}`, data: entry };
    },
  });

  tools.register({
    name: 'memory.forget',
    description: 'Delete a saved memory permanently',
    scope: 'destructive',
    parameters: schema({ id: whole('Memory id') }, ['id']),
    run: (args) => {
      const id = requireNumber(args, 'id');
      if (!memory.forget(id)) throw new Error(`No memory with id ${id}`);
      return { summary: `Forgot memory ${id}.` };
    },
  });

  tools.register({
    name: 'memory.recall',
    description: 'Search saved memories about the user',
    scope: 'read',
    parameters: schema({ query: text('Words to search for') }, ['query']),
    run: (args) => {
      const found = memory.search(requireString(args, 'query'));
      const summary = found.length ? found.map((m) => m.content).join('; ') : 'Nothing saved on that topic.';
      return { summary, data: found };
    },
  });
}
