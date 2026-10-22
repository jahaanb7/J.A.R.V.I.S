import type { ChatMessage, ChatOptions, ModelAdapter, ModelReply } from './model';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts assistant-side tool calls and tool results into plain text turns.
 * Our tool calls have no ids, so they cannot be matched to Anthropic tool_use blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: string }[] } {
  const systemParts: string[] = [];
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: `Tool result from ${m.tool_name ?? 'tool'}: ${m.content}` });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => `call ${c.function.name} ${JSON.stringify(c.function.arguments)}`);
      out.push({ role: 'assistant', content: [m.content, ...calls].filter(Boolean).join('\n') });
    } else {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

/** Cloud model via the Anthropic Messages API. Needs ANTHROPIC_API_KEY; the key stays in the main process. */
export class AnthropicModel implements ModelAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.name = `anthropic:${options.model}`;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.maxTokens = options.maxTokens ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const converted = toAnthropicMessages(messages);
    const payload: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.maxTokens,
      system: converted.system,
      messages: converted.messages,
    };
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Anthropic returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { content?: unknown };
    if (!Array.isArray(data.content)) throw new Error('Anthropic response did not include content');

    let content = '';
    const toolCalls: ModelReply['toolCalls'] = [];
    for (const block of data.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') content += block.text;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        toolCalls.push({ name: block.name, arguments: isRecord(block.input) ? block.input : {} });
      }
    }
    return { content, toolCalls };
  }
}
