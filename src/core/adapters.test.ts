import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startCompanion, type CompanionHandle } from './companion';
import { OllamaModel } from './model';
import { createServices, type Services } from './services';
import { ScriptedModel } from './model';

const servers: Server[] = [];
let companion: CompanionHandle | null = null;
let services: Services | null = null;

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  if (companion) await companion.close();
  companion = null;
  services?.close();
  services = null;
});

function fakeOllama(handler: (path: string, body: string) => { status: number; body: unknown }): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const out = handler(req.url ?? '', raw);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('OllamaModel', () => {
  it('posts a non-streaming chat request and returns the assistant content', async () => {
    let seen: { model: string; stream: boolean; messages: unknown[] } | null = null;
    const baseUrl = await fakeOllama((path, body) => {
      expect(path).toBe('/api/chat');
      seen = JSON.parse(body);
      return { status: 200, body: { message: { role: 'assistant', content: 'Hi there' }, done: true } };
    });
    const model = new OllamaModel({ baseUrl, model: 'llama3.2' });
    const reply = await model.chat([{ role: 'user', content: 'hello' }]);
    expect(reply).toEqual({ content: 'Hi there', toolCalls: [] });
    expect(seen).toMatchObject({ model: 'llama3.2', stream: false });
    expect(model.name).toBe('ollama:llama3.2');
  });

  it('sends tool specs and context size, and parses native tool calls with object or string arguments', async () => {
    let seen: { tools?: { function: { name: string } }[]; options?: unknown } = {};
    const baseUrl = await fakeOllama((_path, body) => {
      seen = JSON.parse(body);
      return {
        status: 200,
        body: {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'calendar.add', arguments: { title: 'Lab', start: '2026-10-12T16:00', end: '2026-10-12T17:00' } } },
              { function: { name: 'tasks.add', arguments: '{"title":"Buy resistors"}' } },
            ],
          },
        },
      };
    });
    const model = new OllamaModel({ baseUrl, model: 'llama3.2', numCtx: 8192 });
    const reply = await model.chat([{ role: 'user', content: 'x' }], {
      tools: [
        {
          type: 'function',
          function: { name: 'calendar.add', description: 'Add', parameters: { type: 'object', properties: {}, required: [] } },
        },
      ],
    });
    expect(seen.tools?.map((t) => t.function.name)).toEqual(['calendar.add']);
    expect(seen.options).toEqual({ num_ctx: 8192 });
    expect(reply.toolCalls).toEqual([
      { name: 'calendar.add', arguments: { title: 'Lab', start: '2026-10-12T16:00', end: '2026-10-12T17:00' } },
      { name: 'tasks.add', arguments: { title: 'Buy resistors' } },
    ]);
  });

  it('retries as plain chat when the model does not support tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const baseUrl = await fakeOllama((_path, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodies.push(parsed);
      if (parsed.tools) {
        return { status: 400, body: { error: 'registry.ollama.ai/library/tiny does not support tools' } };
      }
      return { status: 200, body: { message: { role: 'assistant', content: 'plain answer' } } };
    });
    const model = new OllamaModel({ baseUrl, model: 'tiny' });
    const reply = await model.chat([{ role: 'user', content: 'x' }], {
      tools: [
        {
          type: 'function',
          function: { name: 'tasks.list', description: 'List', parameters: { type: 'object', properties: {}, required: [] } },
        },
      ],
    });
    expect(reply).toEqual({ content: 'plain answer', toolCalls: [] });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('tools');
  });

  it('throws a clear error on HTTP failure', async () => {
    const baseUrl = await fakeOllama(() => ({ status: 404, body: { error: 'model not found' } }));
    const model = new OllamaModel({ baseUrl, model: 'missing' });
    await expect(model.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 404/);
  });

  it('health() lists installed models, and reports offline when unreachable', async () => {
    const baseUrl = await fakeOllama(() => ({ status: 200, body: { models: [{ name: 'llama3.2:latest' }] } }));
    expect(await new OllamaModel({ baseUrl, model: 'x' }).health()).toEqual({
      ok: true,
      models: ['llama3.2:latest'],
    });
    const offline = await new OllamaModel({ baseUrl: 'http://127.0.0.1:1', model: 'x' }).health();
    expect(offline.ok).toBe(false);
  });
});

describe('companion API', () => {
  const TOKEN = 'test-token-123';

  async function start(): Promise<string> {
    services = createServices({
      dbPath: ':memory:',
      model: new ScriptedModel(() => 'Pong from Buffy'),
      now: () => new Date('2026-10-12T08:00:00.000Z'),
    });
    companion = await startCompanion({ services, host: '127.0.0.1', port: 0, token: TOKEN });
    return `http://127.0.0.1:${companion.port}`;
  }

  it('serves the phone page without a token but protects the API', async () => {
    const base = await start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Buffy');

    const denied = await fetch(`${base}/api/status`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('chats, reads the schedule, and pauses with a valid token', async () => {
    const base = await start();
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'ping' }) });
    expect(chat.status).toBe(200);
    expect(((await chat.json()) as { reply: string }).reply).toBe('Pong from Buffy');

    const schedule = await fetch(`${base}/api/schedule`, { headers: auth });
    expect(((await schedule.json()) as { events: unknown[] }).events).toEqual([]);

    const pause = await fetch(`${base}/api/pause`, { method: 'POST', headers: auth, body: '{}' });
    expect(((await pause.json()) as { paused: boolean }).paused).toBe(true);
    expect(services?.policy.isPaused()).toBe(true);
    await fetch(`${base}/api/resume`, { method: 'POST', headers: auth, body: '{}' });
  });

  it('rejects chat bodies that are not text', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });
    expect(res.status).toBe(400);
  });
});
