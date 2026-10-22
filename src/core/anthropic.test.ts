import { describe, expect, it } from 'vitest';
import { AnthropicModel } from './anthropic';

function fakeFetch(respond: (url: string, body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(input), headers, body });
    const out = respond(String(input), body);
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('AnthropicModel', () => {
  it('sends the key, system prompt, and tools, and returns text', async () => {
    const { impl, calls } = fakeFetch(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: 'Hello' }] },
    }));
    const model = new AnthropicModel({ apiKey: 'k-123', model: 'claude-sonnet-4-5', fetchImpl: impl });
    const reply = await model.chat(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      {
        tools: [
          {
            type: 'function',
            function: { name: 'code.read', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } },
          },
        ],
      },
    );
    expect(reply).toEqual({ content: 'Hello', toolCalls: [] });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('k-123');
    expect(calls[0].body).toMatchObject({ system: 'be brief', model: 'claude-sonnet-4-5' });
    expect(calls[0].body.tools).toEqual([
      { name: 'code.read', description: 'Read', input_schema: { type: 'object', properties: {}, required: [] } },
    ]);
  });

  it('parses tool_use blocks into tool calls', async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      body: {
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'x', name: 'code.read', input: { path: 'a.ts' } },
        ],
      },
    }));
    const model = new AnthropicModel({ apiKey: 'k', model: 'm', fetchImpl: impl });
    const reply = await model.chat([{ role: 'user', content: 'read a' }]);
    expect(reply).toEqual({ content: 'Reading it.', toolCalls: [{ name: 'code.read', arguments: { path: 'a.ts' } }] });
  });

  it('throws a clear error on HTTP failure', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, body: { error: 'invalid x-api-key' } }));
    const model = new AnthropicModel({ apiKey: 'bad', model: 'm', fetchImpl: impl });
    await expect(model.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 401/);
  });
});
