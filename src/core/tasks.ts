import type { DatabaseSync } from 'node:sqlite';
import { parseDateTime } from './datetime';
import type { EventBus } from './events';

export interface Task {
  id: number;
  title: string;
  dueAt: string | null;
  priority: number;
  estimateMinutes: number | null;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface TaskInput {
  title: string;
  dueAt?: string | null;
  priority?: number;
  estimateMinutes?: number | null;
}

interface TaskRow {
  id: number;
  title: string;
  due_at: string | null;
  priority: number;
  estimate_minutes: number | null;
  done: number;
  created_at: string;
  completed_at: string | null;
}

const TASK_COLUMNS = 'id, title, due_at, priority, estimate_minutes, done, created_at, completed_at';

function toTask(row: TaskRow): Task {
  return {
    id: Number(row.id),
    title: row.title,
    dueAt: row.due_at,
    priority: Number(row.priority),
    estimateMinutes: row.estimate_minutes === null ? null : Number(row.estimate_minutes),
    done: Number(row.done) === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class Tasks {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus?: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(input: TaskInput): Task {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('Task title is required');
    const priority = input.priority ?? 3;
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw new Error('priority must be an integer from 1 (highest) to 5 (lowest)');
    }
    const estimate = input.estimateMinutes ?? null;
    if (estimate !== null && (!Number.isInteger(estimate) || estimate <= 0)) {
      throw new Error('estimateMinutes must be a positive whole number');
    }
    const dueAt = input.dueAt ? parseDateTime(input.dueAt, 'dueAt') : null;
    const result = this.db
      .prepare(
        'INSERT INTO tasks (title, due_at, priority, estimate_minutes, done, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      )
      .run(title, dueAt, priority, estimate, this.now().toISOString());
    const task = this.get(Number(result.lastInsertRowid));
    if (!task) throw new Error('Failed to read back new task');
    this.bus?.publish('tasks.changed', task);
    return task;
  }

  get(id: number): Task | null {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as unknown;
    return row ? toTask(row as TaskRow) : null;
  }

  list(options: { includeDone?: boolean } = {}): Task[] {
    const where = options.includeDone ? '' : 'WHERE done = 0';
    const rows = this.db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY done ASC, priority ASC, COALESCE(due_at, '9999') ASC, id ASC`,
      )
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  complete(id: number): Task {
    const task = this.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    if (task.done) return task;
    this.db
      .prepare('UPDATE tasks SET done = 1, completed_at = ? WHERE id = ?')
      .run(this.now().toISOString(), id);
    const updated = this.get(id);
    if (!updated) throw new Error(`Task ${id} disappeared during completion`);
    this.bus?.publish('tasks.changed', updated);
    return updated;
  }

  remove(id: number): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    const removed = Number(result.changes) > 0;
    if (removed) this.bus?.publish('tasks.changed', { removedId: id });
    return removed;
  }
}
