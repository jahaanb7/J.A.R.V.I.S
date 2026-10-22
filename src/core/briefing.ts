import type { Calendar, CalendarEvent } from './calendar';
import type { Task, Tasks } from './tasks';
import { objectSchema, type ToolRegistry } from './tools';

export interface BriefingDeps {
  calendar: Calendar;
  tasks: Tasks;
  now?: () => Date;
}

export interface Briefing {
  summary: string;
  events: CalendarEvent[];
  topTasks: Task[];
  deadlines: Task[];
}

const DEADLINE_DAYS = 3;
const DAY_MS = 24 * 3_600_000;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Builds the briefing in local time. "Today" runs from local midnight to the next local midnight. */
export function buildBriefing(deps: BriefingDeps): Briefing {
  const now = deps.now?.() ?? new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + DAY_MS);
  // Calendar.list needs ISO times. DST can make a day 23 or 25 hours, so use the calendar's own bounds.
  const events = deps.calendar.list({ from: startOfDay.toISOString(), to: endOfDay.toISOString() });

  const open = deps.tasks.list();
  const topTasks = open.slice(0, 3);
  const horizon = now.getTime() + DEADLINE_DAYS * DAY_MS;
  const deadlines = open.filter((t) => t.dueAt && Date.parse(t.dueAt) >= now.getTime() && Date.parse(t.dueAt) <= horizon);

  const parts: string[] = [];
  parts.push(
    events.length
      ? `Today: ${events.length} event${events.length === 1 ? '' : 's'} (${events
          .map((e) => `${e.title} at ${clock(e.startAt)}`)
          .join(', ')}).`
      : 'Today: nothing scheduled.',
  );
  parts.push(
    open.length
      ? `${open.length} open task${open.length === 1 ? '' : 's'}, top priority: ${topTasks
          .map((t) => `${t.title} (P${t.priority})`)
          .join(', ')}.`
      : 'No open tasks.',
  );
  if (deadlines.length) {
    parts.push(
      `Due in the next ${DEADLINE_DAYS} days: ${deadlines
        .map((t) => `${t.title} (${day(t.dueAt as string)})`)
        .join(', ')}.`,
    );
  }
  return { summary: parts.join(' '), events, topTasks, deadlines };
}

export function registerBriefingTool(tools: ToolRegistry, deps: BriefingDeps): void {
  tools.register({
    name: 'briefing.today',
    description: "Summarize today's schedule, open tasks, and deadlines in the next few days",
    scope: 'read',
    parameters: objectSchema({}),
    run: () => {
      const briefing = buildBriefing(deps);
      return { summary: briefing.summary, data: briefing };
    },
  });
}
