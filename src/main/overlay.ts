import { BrowserWindow, ipcMain, screen, session } from 'electron';
import { withSandboxPolicy, type WidgetHost, type WidgetManifest, type WidgetStore } from '../core/widgets';

interface ShownWidget {
  window: BrowserWindow;
  manifest: WidgetManifest;
  timer: NodeJS.Timeout | null;
}

/**
 * Draws widgets as small transparent windows that float above every app, including full-screen ones.
 * Each widget runs in a sandbox: no Node.js, no network, and a bridge that can only hide the widget,
 * keep it open, and read or write its own data.
 */
export class WidgetOverlay implements WidgetHost {
  private store: WidgetStore | null = null;
  private readonly shown = new Map<string, ShownWidget>();
  private readonly idByWebContents = new Map<number, string>();
  private lastShownId: string | null = null;
  private readonly sandbox = session.fromPartition('widgets-sandbox', { cache: false });

  constructor(private readonly preloadPath: string) {
    // Only widget windows use these channels. Calls from any other sender are rejected.
    this.sandbox.webRequest.onBeforeRequest((details, callback) => {
      // Widgets are self-contained: the only URLs they may load are their own data: page.
      callback({ cancel: !details.url.startsWith('data:') });
    });
    ipcMain.handle('widget:load', (event) => this.widgetStore().loadData(this.idFor(event.sender.id)));
    ipcMain.handle('widget:save', (event, data: unknown) =>
      this.widgetStore().saveData(this.idFor(event.sender.id), data),
    );
    ipcMain.on('widget:hide', (event) => this.hideFromWidget(event.sender.id));
    ipcMain.on('widget:pin', (event) => this.pinFromWidget(event.sender.id));
  }

  attach(store: WidgetStore): void {
    this.store = store;
  }

  show(manifest: WidgetManifest, hideAfterSeconds: number | null): void {
    let entry = this.shown.get(manifest.id);
    if (!entry) {
      entry = this.create(manifest);
      this.shown.set(manifest.id, entry);
    }
    this.lastShownId = manifest.id;
    this.arm(manifest.id, hideAfterSeconds);
    entry.window.show();
    entry.window.focus();
    console.log(`widget shown: ${manifest.id} (hides after ${hideAfterSeconds ?? 'never'} s)`);
  }

  hide(id?: string): void {
    const ids = id ? [id] : [...this.shown.keys()];
    for (const widgetId of ids) {
      const entry = this.shown.get(widgetId);
      if (!entry) continue;
      this.disarm(widgetId);
      entry.window.hide();
    }
  }

  /** Global hotkey: hide everything if anything is visible, otherwise show the last widget used. */
  toggleLatest(): void {
    const anyVisible = [...this.shown.values()].some((entry) => entry.window.isVisible());
    if (anyVisible) {
      this.hide();
      return;
    }
    const store = this.store;
    const last = this.lastShownId && store ? store.get(this.lastShownId) : null;
    if (last) this.show(last.manifest, last.manifest.hideAfterSeconds);
  }

  closeAll(): void {
    for (const id of [...this.shown.keys()]) {
      this.disarm(id);
      this.shown.get(id)?.window.destroy();
    }
    this.shown.clear();
  }

  private widgetStore(): WidgetStore {
    if (!this.store) throw new Error('Widget store is not ready');
    return this.store;
  }

  private idFor(webContentsId: number): string {
    const id = this.idByWebContents.get(webContentsId);
    if (!id) throw new Error('Not a widget window');
    return id;
  }

  private hideFromWidget(webContentsId: number): void {
    // Only a known widget window may hide itself. An unknown sender must never hide every widget.
    const id = this.idByWebContents.get(webContentsId);
    if (id) this.hide(id);
  }

  private pinFromWidget(webContentsId: number): void {
    const id = this.idByWebContents.get(webContentsId);
    if (id) this.disarm(id);
  }

  private arm(id: string, seconds: number | null): void {
    this.disarm(id);
    if (!seconds) return;
    const entry = this.shown.get(id);
    if (!entry) return;
    entry.timer = setTimeout(() => this.hide(id), seconds * 1000);
  }

  private disarm(id: string): void {
    const entry = this.shown.get(id);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private create(manifest: WidgetManifest): ShownWidget {
    const record = this.widgetStore().get(manifest.id);
    if (!record) throw new Error(`No widget with id ${manifest.id}`);

    const area = screen.getPrimaryDisplay().workArea;
    const offset = Math.min(this.shown.size, 6) * 24;
    const window = new BrowserWindow({
      width: manifest.width,
      height: manifest.height,
      x: area.x + area.width - manifest.width - 24 - offset,
      y: area.y + 40 + offset,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: manifest.name,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: this.sandbox,
      },
    });
    // 'screen-saver' sits above full-screen apps. Visible on every Space, including full-screen ones.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const webContentsId = window.webContents.id;
    this.idByWebContents.set(webContentsId, manifest.id);
    window.on('closed', () => {
      this.idByWebContents.delete(webContentsId);
      this.disarm(manifest.id);
      this.shown.delete(manifest.id);
    });

    const page = withSandboxPolicy(record.html);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    return { window, manifest, timer: null };
  }
}
