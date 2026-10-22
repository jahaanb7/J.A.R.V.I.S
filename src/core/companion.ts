import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildBriefing } from './briefing';
import { COMPANION_HTML } from './companion-page';
import type { Services } from './services';

export interface CompanionOptions {
  services: Services;
  host: string;
  port: number;
  token: string;
}

export interface CompanionHandle {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const APPROVAL_ROUTE = /^\/api\/approvals\/([\w-]+)\/(approve|deny)$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function route(opts: CompanionOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://companion.local');
  const { services } = opts;

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(COMPANION_HTML);
    return;
  }

  if (!authorized(req, opts.token)) {
    sendJson(res, 401, { error: 'Unauthorized: missing or wrong pairing token' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, { paused: services.policy.isPaused(), model: services.model.name });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    sendJson(res, 200, {
      events: services.calendar.list({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      }),
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/briefing') {
    sendJson(res, 200, buildBriefing({ calendar: services.calendar, tasks: services.tasks }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    sendJson(res, 200, { tasks: services.tasks.list() });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    sendJson(res, 200, { approvals: services.tools.pendingApprovals() });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/pause') {
    services.policy.pause();
    services.bus.publish('system.paused');
    sendJson(res, 200, { paused: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/resume') {
    services.policy.resume();
    services.bus.publish('system.resumed');
    sendJson(res, 200, { paused: false });
    return;
  }

  const approvalMatch = APPROVAL_ROUTE.exec(url.pathname);
  if (req.method === 'POST' && approvalMatch) {
    const [, id, action] = approvalMatch;
    const result =
      action === 'approve' ? await services.tools.approve(id) : services.tools.deny(id);
    sendJson(res, 200, { result });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown };
    if (typeof body.text !== 'string') {
      sendJson(res, 400, { error: '"text" must be a string' });
      return;
    }
    sendJson(res, 200, await services.assistant.send(body.text));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

export function startCompanion(opts: CompanionOptions): Promise<CompanionHandle> {
  const server: Server = createServer((req, res) => {
    route(opts, req, res).catch((err: unknown) => {
      const status = typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : 500;
      if (!res.headersSent) {
        sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
