import type { ToolSpec } from './tools';

/** A tool call as Ollama returns it inside `message.tool_calls`. */
export interface ModelToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on tool-result messages so the model can match them to the call. */
  tool_name?: string;
  tool_calls?: ModelToolCall[];
}

export interface ModelReply {
  content: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
}

export interface ChatOptions {
  tools?: ToolSpec[];
}

export interface ModelAdapter {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ModelReply>;
}

export interface OllamaOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Context window in tokens. Ollama's default is small; coding work needs more. */
  numCtx?: number;
  fetchImpl?: typeof fetch;
}

export interface OllamaHealth {
  ok: boolean;
  models: string[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ollama normally sends arguments as an object, but some models send a JSON string. */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseToolCalls(raw: unknown): ModelReply['toolCalls'] {
  if (!Array.isArray(raw)) return [];
  const calls: ModelReply['toolCalls'] = [];
  for (const item of raw) {
    if (isRecord(item) && isRecord(item.function) && typeof item.function.name === 'string') {
      calls.push({ name: item.function.name, arguments: normalizeArgs(item.function.arguments) });
    }
  }
  return calls;
}

/** Free, local model served by Ollama (http://127.0.0.1:11434 by default). */
export class OllamaModel implements ModelAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaOptions) {
    this.name = `ollama:${options.model}`;
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const payload: Record<string, unknown> = { model: this.options.model, messages, stream: false };
    if (options.tools && options.tools.length > 0) payload.tools = options.tools;
    if (this.options.numCtx) payload.options = { num_ctx: this.options.numCtx };

    let response = await this.post(payload);
    if (!response.ok && payload.tools !== undefined && response.status === 400) {
      const text = await response.text();
      if (!/tool/i.test(text)) throw new Error(`Ollama returned HTTP 400: ${text}`);
      // The model does not support native tools. Retry as plain chat; the assistant still
      // accepts a JSON tool call written in the reply text.
      delete payload.tools;
      response = await this.post(payload);
    }
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { message?: { content?: unknown; tool_calls?: unknown } };
    if (!isRecord(data.message)) throw new Error('Ollama response did not include a message');
    return {
      content: typeof data.message.content === 'string' ? data.message.content : '',
      toolCalls: parseToolCalls(data.message.tool_calls),
    };
  }

  async health(): Promise<OllamaHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return { ok: false, models: [], error: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { models?: { name?: string }[] };
      const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private post(payload: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export type ScriptedResponse = string | ModelReply;

/** Deterministic model for tests and for running without any model installed. */
export class ScriptedModel implements ModelAdapter {
  readonly name = 'scripted';
  readonly calls: ChatMessage[][] = [];
  readonly toolsSeen: ToolSpec[][] = [];

  constructor(
    private readonly respond: (
      messages: ChatMessage[],
      options: ChatOptions,
    ) => ScriptedResponse | Promise<ScriptedResponse>,
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    this.calls.push(messages);
    this.toolsSeen.push(options.tools ?? []);
    const response = await this.respond(messages, options);
    return typeof response === 'string' ? { content: response, toolCalls: [] } : response;
  }
}
