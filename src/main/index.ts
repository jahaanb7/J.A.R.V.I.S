import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, Tray } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompanion, type CompanionHandle } from '../core/companion';
import { AnthropicModel } from '../core/anthropic';
import { OllamaModel, type ModelAdapter } from '../core/model';
import { buildBriefing } from '../core/briefing';
import { createServices, type Services } from '../core/services';
import { toSpeech } from '../core/speech';
import type { Scope } from '../core/permissions';
import { AssistantOrb } from './orb';
import { WidgetOverlay } from './overlay';

type Handler = (args: unknown) => unknown | Promise<unknown>;

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function lanAddress(): string {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

function buildMethods(services: Services, companion: () => CompanionHandle | null, token: string): Map<string, Handler> {
  const methods = new Map<string, Handler>();
  const add = (name: string, handler: Handler) => methods.set(name, handler);

  add('chat.send', (args) => services.assistant.send(String(asRecord(args).text ?? '')));
  add('chat.history', () => services.assistant.history(100));
  add('tools.list', () => services.tools.list());
  add('tools.invoke', (args) => {
    const a = asRecord(args);
    return services.tools.invoke(String(a.name ?? ''), asRecord(a.args));
  });
  add('calendar.list', (args) => services.calendar.list(asRecord(args) as { from?: string; to?: string }));
  add('tasks.list', () => services.tasks.list({ includeDone: false }));
  add('widgets.list', () => services.widgets.list());
  add('briefing.get', () => buildBriefing({ calendar: services.calendar, tasks: services.tasks }));
  add('memory.list', () => services.memory.list(100));
  add('approvals.list', () => services.tools.pendingApprovals());
  add('approvals.approve', (args) => services.tools.approve(String(asRecord(args).id ?? '')));
  add('approvals.deny', (args) => services.tools.deny(String(asRecord(args).id ?? '')));
  add('audit.list', (args) => services.audit.list(Number(asRecord(args).limit ?? 100)));
  add('system.pause', () => {
    services.policy.pause();
    services.bus.publish('system.paused');
    return { paused: true };
  });
  add('system.resume', () => {
    services.policy.resume();
    services.bus.publish('system.resumed');
    return { paused: false };
  });
  add('policy.get', () => services.policy.snapshot());
  add('policy.set', (args) => {
    const a = asRecord(args);
    services.policy.setRule(String(a.scope) as Scope, String(a.decision) as 'allow' | 'ask' | 'deny');
    return services.policy.snapshot();
  });
  add('app.info', async () => {
    const handle = companion();
    const model = services.model;
    const health = model instanceof OllamaModel ? await model.health() : { ok: true, models: [] };
    return {
      model: model.name,
      modelHealth: health,
      paused: services.policy.isPaused(),
      companionUrl: handle ? `http://${lanAddress()}:${handle.port}` : null,
      companionToken: token,
      companionError: handle ? null : 'Companion server is not running (port in use?)',
    };
  });
  return methods;
}

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let companion: CompanionHandle | null = null;
let overlay: WidgetOverlay | null = null;
let orb: AssistantOrb | null = null;
let tray: Tray | null = null;

function openMainWindow(): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Buffy',
    // Native macOS look: the sidebar runs under the traffic lights instead of a grey title bar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0e1015',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Picks the model from the environment. A cloud key (ANTHROPIC_API_KEY) wins; otherwise
 * Buffy uses a local Ollama model, which is free and keeps data on this machine.
 */
function chooseModel(): ModelAdapter {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return new AnthropicModel({
      apiKey,
      model: process.env.JARVIS_CLOUD_MODEL ?? 'claude-sonnet-4-5',
    });
  }
  return new OllamaModel({
    baseUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: process.env.JARVIS_MODEL ?? 'llama3.2',
    numCtx: process.env.JARVIS_NUM_CTX ? Number(process.env.JARVIS_NUM_CTX) : undefined,
  });
}

async function boot(): Promise<void> {
  const userData = app.getPath('userData');
  const model = chooseModel();
  // The coding agent only sees the folder named here. Unset means no file or command access.
  const projectRoot = process.env.JARVIS_PROJECT_DIR?.trim() || undefined;
  overlay = new WidgetOverlay(path.join(__dirname, 'widget-preload.js'));
  services = createServices({
    dbPath: path.join(userData, 'jarvis.db'),
    widgetsDir: path.join(userData, 'widgets'),
    widgetHost: overlay,
    projectRoot,
    model,
  });
  overlay.attach(services.widgets);
  // Global hotkey: works while any other app is in front.
  const registered = globalShortcut.register('CommandOrControl+Shift+S', () => overlay?.toggleLatest());
  if (!registered) console.error('Could not register the sticky-note hotkey (Cmd+Shift+S)');

  const orbHtml = path.join(__dirname, '..', '..', 'src', 'renderer', 'orb.html');
  orb = new AssistantOrb({
    preloadPath: path.join(__dirname, 'orb-preload.js'),
    htmlPath: orbHtml,
    ask: async (text) => {
      if (!services) throw new Error('Buffy is still starting');
      const result = await services.assistant.send(text);
      return { reply: result.reply, spoken: toSpeech(result.reply) };
    },
    openMainWindow,
  });
  // Only the orb page may use the microphone. The main window never asks for it.
  const orbUrl = pathToFileURL(orbHtml).href;
  const isOrbPage = (url: string) => url.startsWith(orbUrl);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isOrbPage(webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' && webContents !== null && isOrbPage(webContents.getURL());
  });
  if (!globalShortcut.register('Alt+Space', () => orb?.toggle())) {
    console.error('Could not register the orb hotkey (Option+Space); another app may own it');
  }

  const token = loadOrCreateToken(path.join(userData, 'companion-token'));
  try {
    companion = await startCompanion({
      services,
      host: '0.0.0.0',
      port: Number(process.env.JARVIS_COMPANION_PORT ?? 7777),
      token,
    });
    console.log(`companion listening on port ${companion.port}`);
  } catch (err) {
    console.error('companion server failed to start', err);
  }

  const methods = buildMethods(services, () => companion, token);
  ipcMain.handle('jarvis:call', async (_event, method: unknown, args: unknown) => {
    if (typeof method !== 'string') throw new Error('Method name must be a string');
    const handler = methods.get(method);
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler(args);
  });

  services.bus.subscribe((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('jarvis:event', event);
    }
  });

  createWindow();
  createTray();
  orb?.show();
}

/** Menu bar item: a text label, since Buffy has no icon file yet. */
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Buffy');
  if (process.platform === 'darwin') tray.setTitle('Buffy');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show or hide the orb', click: () => orb?.toggle() },
      { label: 'Open Buffy', click: openMainWindow },
      { type: 'separator' },
      { label: 'Quit Buffy', role: 'quit' },
    ]),
  );
}

app.whenReady().then(boot).catch((err: unknown) => {
  console.error('Buffy failed to start', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && services) createWindow();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  orb?.close();
  tray?.destroy();
  overlay?.closeAll();
  void companion?.close();
  services?.close();
});
