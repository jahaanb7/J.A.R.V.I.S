import type { DatabaseSync } from 'node:sqlite';
import type { Calendar } from './calendar';
import type { EventBus } from './events';
import type { ChatMessage, ModelAdapter, ModelReply } from './model';
import type { MemoryStore } from './memory';
import type { Tasks } from './tasks';
import type { InvokeResult, ToolRegistry } from './tools';

export interface ToolRun {
  tool: string;
  result: InvokeResult;
}

export interface ChatReply {
  reply: string;
  model: string;
  /** The first tool that ran, kept for older clients. */
  action?: ToolRun;
  actions: ToolRun[];
}

export interface StoredMessage {
  id: number;
  ts: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Caps how many tool calls one reply can trigger, so a confused model cannot loop the app. */
const MAX_TOOL_CALLS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fallback for models without native tool support: parses a reply that is only a JSON tool call,
 * optionally wrapped in a code fence. Anything else is treated as a plain-text answer.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseToolCall(text: string): ToolCall | null {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(body);
  if (fenced) body = fenced[1].trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;

  // Small local models sometimes write a stray quote (""parameters") or use name/parameters
  // instead of tool/args. Accept both so the call is not shown to the user as raw JSON.
  const parsed = tryParseJson(body) ?? tryParseJson(body.replace(/""(\w+)"/g, '"$1"'));
  if (!isRecord(parsed)) return null;
  // Some models echo the OpenAI-style wrapper: {"type":"function","function":{"name":...,"arguments":...}}.
  const call = isRecord(parsed.function) ? parsed.function : parsed;
  const tool = typeof call.tool === 'string' ? call.tool : typeof call.name === 'string' ? call.name : null;
  if (!tool) return null;
  const rawArgs = call.args ?? call.arguments ?? call.parameters;
  // Arguments may also arrive as a JSON string.
  const args = typeof rawArgs === 'string' ? tryParseJson(rawArgs) : rawArgs;
  return { tool, args: isRecord(args) ? args : {} };
}

/** True when a reply is a tool call that failed to parse, e.g. {"name":"tasks.add","parameters{"}. */
function looksLikeBrokenToolCall(text: string): boolean {
  return /^\{\s*"?(name|tool|type)/.test(text.trim());
}

export function describeResult(result: InvokeResult): string {
  switch (result.status) {
    case 'done':
      return result.output.summary;
    case 'pending':
      return `I need your approval before I can do that (approval ${result.approval.id}). Check the Approvals panel.`;
    case 'denied':
      return `I can't do that right now: ${result.reason}.`;
    case 'error':
      return `That didn't work: ${result.message}`;
  }
}

export interface AssistantOptions {
  model: ModelAdapter;
  db: DatabaseSync;
  tools: ToolRegistry;
  memory: MemoryStore;
  calendar: Calendar;
  tasks: Tasks;
  bus?: EventBus;
  now?: () => Date;
}

const CONTEXT_HISTORY = 12;
const DAY_MS = 24 * 3_600_000;

/** YYYY-MM-DD in the computer's local time zone. */
function localIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class Assistant {
  constructor(private readonly options: AssistantOptions) {}

  async send(text: string): Promise<ChatReply> {
    const userText = text.trim();
    if (!userText) throw new Error('Message is empty');

    this.store('user', userText);
    const messages = this.buildContext(userText);

    let model: ModelReply;
    try {
      model = await this.chatOnce(messages);
    } catch (err) {
      const reply = `The local model is unavailable: ${err instanceof Error ? err.message : String(err)}`;
      this.store('assistant', reply);
      return { reply, model: this.options.model.name, actions: [] };
    }

    let calls: { tool: string; args: Record<string, unknown> }[] = model.toolCalls.map((c) => ({
      tool: c.name,
      args: c.arguments,
    }));
    if (calls.length === 0) {
      const fallback = parseToolCall(model.content);
      if (fallback) calls = [fallback];
    }

    if (calls.length === 0) {
      const reply = looksLikeBrokenToolCall(model.content)
        ? "I couldn't complete that action cleanly. Please try again."
        : model.content.trim();
      this.store('assistant', reply);
      return { reply, model: this.options.model.name, actions: [] };
    }

    let actions = await this.runCalls(calls);
    // A call with missing or malformed arguments gets one corrected attempt, with the error shown to the model.
    if (actions.some((a) => a.result.status === 'error' && a.result.message.startsWith('Invalid arguments'))) {
      const retried = await this.retryAfterInvalid(messages, model, actions);
      if (retried) actions = retried;
    }
    const reply = actions.map((a) => describeResult(a.result)).join('\n');
    this.store('assistant', reply);
    return { reply, model: this.options.model.name, action: actions[0], actions };
  }

  private async runCalls(calls: ToolCall[]): Promise<ToolRun[]> {
    const runs: ToolRun[] = [];
    for (const call of calls.slice(0, MAX_TOOL_CALLS)) {
      runs.push({ tool: call.tool, result: await this.options.tools.invoke(call.tool, call.args) });
    }
    return runs;
  }

  /**
   * Sends the tool results back to the model once, so it can fix its arguments. Only applies to native
   * tool calls, which have ids the model can answer. Returns null if the retry does not produce calls.
   */
  private async retryAfterInvalid(
    messages: ChatMessage[],
    model: ModelReply,
    failed: ToolRun[],
  ): Promise<ToolRun[] | null> {
    if (model.toolCalls.length === 0) return null;
    const followUp: ChatMessage[] = [
      ...messages,
      {
        role: 'assistant',
        content: model.content,
        tool_calls: model.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
      },
      ...failed.map(
        (run): ChatMessage => ({ role: 'tool', tool_name: run.tool, content: describeResult(run.result) }),
      ),
      { role: 'user', content: 'That tool call was invalid. Call the tool again with every required argument filled in from my message.' },
    ];
    let next: ModelReply;
    try {
      next = await this.options.model.chat(followUp, { tools: this.options.tools.specs() });
    } catch {
      return null;
    }
    if (next.toolCalls.length === 0) return null;
    return this.runCalls(next.toolCalls.map((c) => ({ tool: c.name, args: c.arguments })));
  }

  /** Asks the model once. If it writes a broken tool call as text, asks again before giving up. */
  private async chatOnce(messages: ChatMessage[]): Promise<ModelReply> {
    const options = { tools: this.options.tools.specs() };
    const first = await this.options.model.chat(messages, options);
    if (first.toolCalls.length > 0 || parseToolCall(first.content) || !looksLikeBrokenToolCall(first.content)) {
      return first;
    }
    return this.options.model.chat(messages, options);
  }

  history(limit = 50): StoredMessage[] {
    const rows = this.options.db
      .prepare('SELECT id, ts, role, content FROM messages ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as StoredMessage[];
    return rows.reverse();
  }

  private store(role: 'user' | 'assistant', content: string): void {
    const ts = (this.options.now?.() ?? new Date()).toISOString();
    const result = this.options.db
      .prepare('INSERT INTO messages (ts, role, content) VALUES (?, ?, ?)')
      .run(ts, role, content);
    this.options.bus?.publish('message.added', {
      id: Number(result.lastInsertRowid),
      ts,
      role,
      content,
    });
  }

  private buildContext(userText: string): ChatMessage[] {
    const now = this.options.now?.() ?? new Date();
    const memories = this.options.memory.search(userText, 5);
    const upcoming = this.options.calendar.list({
      from: now.toISOString(),
      to: new Date(now.getTime() + DAY_MS).toISOString(),
    });
    const openTasks = this.options.tasks.list().slice(0, 5);

    const system = [
      'You are Buffy, a personal AI assistant for a single user. Be concise and helpful.',
      `Current time: ${now.toString()} (ISO ${now.toISOString()}).`,
      'Local dates for the next week (use these to resolve weekday names):',
      ...Array.from({ length: 8 }, (_, i) => {
        const day = new Date(now.getTime() + i * DAY_MS);
        const weekday = day.toLocaleDateString('en-US', { weekday: 'long' });
        return `- ${weekday} ${localIsoDate(day)}`;
      }),
      '',
      'Use the tools when the user asks to add, change, find, or remember calendar events, tasks, or facts.',
      'Pass dates and times as ISO 8601, e.g. 2026-10-15T16:00 for 4pm on October 15 in the user\'s local time.',
      'Work out the actual date from the current time before you call a tool. Do not guess a year.',
      'To change or delete an existing item, use the id shown in [id N] below, never its title.',
      'Fill in titles from what the user said. Never copy a parameter description as a value.',
      'If no tool is needed, answer in plain text.',
      '',
      'Known facts about the user:',
      ...(memories.length ? memories.map((m) => `- [id ${m.id}] ${m.content}`) : ['- (none yet)']),
      '',
      'Upcoming events (next 24 hours):',
      ...(upcoming.length
        ? upcoming.map((e) => `- [id ${e.id}] ${e.title}: ${e.startAt} to ${e.endAt}`)
        : ['- (none)']),
      '',
      'Open tasks:',
      ...(openTasks.length
        ? openTasks.map((t) => `- [id ${t.id}] ${t.title} (priority ${t.priority}${t.dueAt ? `, due ${t.dueAt}` : ''})`)
        : ['- (none)']),
    ].join('\n');

    const history = this.history(CONTEXT_HISTORY).map(
      (m): ChatMessage => ({ role: m.role, content: m.content }),
    );
    return [{ role: 'system', content: system }, ...history];
  }
}
