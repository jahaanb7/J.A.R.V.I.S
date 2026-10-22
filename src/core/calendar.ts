import type { DatabaseSync } from 'node:sqlite';
import { parseDateTime } from './datetime';
import type { EventBus } from './events';

export interface CalendarEvent {
  id: number;
  title: string;
  startAt: string;
  endAt: string;
  location: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface EventInput {
  title: string;
  startAt: string;
  endAt: string;
  location?: string;
  notes?: string;
}

export interface SlotSuggestion {
  startAt: string;
  endAt: string;
}

export interface ScheduleResult {
  event: CalendarEvent;
  conflicts: CalendarEvent[];
  suggestion: SlotSuggestion | null;
}

interface EventRow {
  id: number;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

const EVENT_COLUMNS = 'id, title, start_at, end_at, location, notes, created_at, updated_at';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function toEvent(row: EventRow): CalendarEvent {
  return {
    id: Number(row.id),
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    location: row.location,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIso(value: string, field: string): string {
  return parseDateTime(value, field);
}

export class Calendar {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus?: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(input: EventInput): ScheduleResult {
    const clean = this.normalize(input);
    const ts = this.now().toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO events (title, start_at, end_at, location, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(clean.title, clean.startAt, clean.endAt, clean.location, clean.notes, ts, ts);
    const event = this.get(Number(result.lastInsertRowid));
    if (!event) throw new Error('Failed to read back new event');
    return this.finish(event);
  }

  update(id: number, patch: Partial<EventInput>): ScheduleResult {
    const current = this.get(id);
    if (!current) throw new Error(`No event with id ${id}`);
    const clean = this.normalize({
      title: patch.title ?? current.title,
      startAt: patch.startAt ?? current.startAt,
      endAt: patch.endAt ?? current.endAt,
      location: patch.location ?? current.location,
      notes: patch.notes ?? current.notes,
    });
    this.db
      .prepare(
        'UPDATE events SET title = ?, start_at = ?, end_at = ?, location = ?, notes = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        clean.title,
        clean.startAt,
        clean.endAt,
        clean.location,
        clean.notes,
        this.now().toISOString(),
        id,
      );
    const event = this.get(id);
    if (!event) throw new Error(`Event ${id} disappeared during update`);
    return this.finish(event);
  }

  remove(id: number): boolean {
    const result = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    const removed = Number(result.changes) > 0;
    if (removed) this.bus?.publish('calendar.changed', { removedId: id, conflicts: [] });
    return removed;
  }

  get(id: number): CalendarEvent | null {
    const row = this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`).get(id) as
      | unknown
      | undefined;
    return row ? toEvent(row as EventRow) : null;
  }

  /** Events overlapping [from, to). With no range, returns every event in start order. */
  list(range: { from?: string; to?: string } = {}): CalendarEvent[] {
    if (range.from && range.to) {
      const from = toIso(range.from, 'from');
      const to = toIso(range.to, 'to');
      return (
        this.db
          .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE end_at > ? AND start_at < ? ORDER BY start_at`)
          .all(from, to) as unknown as EventRow[]
      ).map(toEvent);
    }
    return (
      this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY start_at`).all() as unknown as EventRow[]
    ).map(toEvent);
  }

  conflictsFor(startAt: string, endAt: string, excludeId = -1): CalendarEvent[] {
    return (
      this.db
        .prepare(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE start_at < ? AND end_at > ? AND id != ? ORDER BY start_at`,
        )
        .all(endAt, startAt, excludeId) as unknown as EventRow[]
    ).map(toEvent);
  }

  /** First free gap of `durationMinutes` at or after `afterIso`, searched up to `horizonDays` ahead. */
  suggestSlot(durationMinutes: number, afterIso: string, horizonDays = 7, excludeId = -1): SlotSuggestion | null {
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new Error('durationMinutes must be a positive number');
    }
    const durationMs = durationMinutes * 60_000;
    const start = Date.parse(toIso(afterIso, 'after'));
    const horizon = start + horizonDays * DAY_MS;
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE end_at > ? AND start_at < ? AND id != ? ORDER BY start_at`,
      )
      .all(new Date(start).toISOString(), new Date(horizon).toISOString(), excludeId) as unknown as EventRow[];

    let cursor = start;
    for (const row of rows) {
      if (Date.parse(row.start_at) >= cursor + durationMs) break;
      cursor = Math.max(cursor, Date.parse(row.end_at));
    }
    if (cursor + durationMs > horizon) return null;
    return {
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(cursor + durationMs).toISOString(),
    };
  }

  private finish(event: CalendarEvent): ScheduleResult {
    const conflicts = this.conflictsFor(event.startAt, event.endAt, event.id);
    const durationMinutes = (Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000;
    const suggestion =
      conflicts.length > 0 ? this.suggestSlot(durationMinutes, event.startAt, 7, event.id) : null;
    const result: ScheduleResult = { event, conflicts, suggestion };
    this.bus?.publish('calendar.changed', result);
    return result;
  }

  private normalize(input: EventInput): Required<EventInput> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('Event title is required');
    const startAt = toIso(input.startAt, 'start');
    const endAt = toIso(input.endAt, 'end');
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      throw new Error('Event end must be after its start');
    }
    return {
      title,
      startAt,
      endAt,
      location: input.location?.trim() ?? '',
      notes: input.notes?.trim() ?? '',
    };
  }
}
