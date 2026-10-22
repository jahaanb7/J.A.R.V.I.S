import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from './events';

export interface AuditEntry {
  id: number;
  ts: string;
  action: string;
  scope: string;
  status: string;
  detail: string;
}

export class AuditLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus?: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(action: string, scope: string, status: string, detail = ''): AuditEntry {
    const ts = this.now().toISOString();
    const result = this.db
      .prepare('INSERT INTO audit_log (ts, action, scope, status, detail) VALUES (?, ?, ?, ?, ?)')
      .run(ts, action, scope, status, detail);
    const entry: AuditEntry = { id: Number(result.lastInsertRowid), ts, action, scope, status, detail };
    this.bus?.publish('audit.recorded', entry);
    return entry;
  }

  list(limit = 100): AuditEntry[] {
    return this.db
      .prepare('SELECT id, ts, action, scope, status, detail FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as AuditEntry[];
  }
}
