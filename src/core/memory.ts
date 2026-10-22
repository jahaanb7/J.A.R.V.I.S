import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from './events';

export interface Memory {
  id: number;
  ts: string;
  kind: string;
  content: string;
  source: string;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'when', 'your', 'you',
  'are', 'was', 'have', 'from', 'about', 'tell', 'me', 'my', 'is', 'it', 'to',
  'of', 'in', 'on', 'a', 'an', 'do', 'does', 'how', 'who', 'where', 'which',
]);

export class MemoryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bus?: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(content: string, kind = 'fact', source = 'user'): Memory {
    const text = content.trim();
    if (!text) throw new Error('Memory content is empty');
    const ts = this.now().toISOString();
    const result = this.db
      .prepare('INSERT INTO memories (ts, kind, content, source) VALUES (?, ?, ?, ?)')
      .run(ts, kind, text, source);
    const memory: Memory = { id: Number(result.lastInsertRowid), ts, kind, content: text, source };
    this.bus?.publish('memory.added', memory);
    return memory;
  }

  list(limit = 50): Memory[] {
    return this.db
      .prepare('SELECT id, ts, kind, content, source FROM memories ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as Memory[];
  }

  /**
   * Keyword recall: ranks memories by how many query terms they contain.
   * Semantic (embedding) recall is planned once a local embedding model is wired in.
   */
  search(query: string, limit = 5): Memory[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
    if (terms.length === 0) return this.list(limit);

    const scored: { memory: Memory; score: number }[] = [];
    for (const memory of this.list(1000)) {
      const haystack = memory.content.toLowerCase();
      const score = terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0);
      if (score > 0) scored.push({ memory, score });
    }
    scored.sort((a, b) => b.score - a.score || b.memory.id - a.memory.id);
    return scored.slice(0, limit).map((s) => s.memory);
  }

  forget(id: number): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    const removed = Number(result.changes) > 0;
    if (removed) this.bus?.publish('memory.added', { id, forgotten: true });
    return removed;
  }
}
