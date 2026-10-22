import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';

export interface OrbOptions {
  preloadPath: string;
  htmlPath: string;
  /** Sends a question to the assistant. `reply` is shown on screen; `spoken` is cleaned for text-to-speech. */
  ask: (text: string) => Promise<{ reply: string; spoken: string }>;
  /** Brings up the full Buffy window. */
  openMainWindow: () => void;
}

const COLLAPSED = { width: 104, height: 104 };
const EXPANDED = { width: 380, height: 520 };
const MARGIN = 24;

/**
 * A small always-on-top orb that floats over every app. Click it to open a compact panel for typing or
 * talking to Buffy. Only this window's sender may use the orb channels, and it can only ask questions,
 * move itself, resize itself, hide, or open the main window. It cannot reach any other API.
 */
export class AssistantOrb {
  private window: BrowserWindow | null = null;
  private expanded = false;
  private dragOffset: { x: number; y: number } | null = null;

  constructor(private readonly options: OrbOptions) {
    ipcMain.handle('orb:ask', (event: IpcMainInvokeEvent, text: unknown) => {
      this.assertOrb(event);
      const question = typeof text === 'string' ? text.trim() : '';
      if (!question) throw new Error('Say or type something first');
      return this.options.ask(question);
    });
    ipcMain.on('orb:resize', (event: IpcMainEvent, expanded: unknown) => {
      if (!this.isOrbSender(event)) return;
      this.setExpanded(expanded === true);
    });
    ipcMain.on('orb:dragStart', (event: IpcMainEvent) => {
      if (!this.isOrbSender(event) || !this.window) return;
      const cursor = screen.getCursorScreenPoint();
      const [x, y] = this.window.getPosition();
      this.dragOffset = { x: cursor.x - x, y: cursor.y - y };
    });
    ipcMain.on('orb:dragMove', (event: IpcMainEvent) => {
      if (!this.isOrbSender(event) || !this.window || !this.dragOffset) return;
      const cursor = screen.getCursorScreenPoint();
      const { width, height } = this.window.getBounds();
      this.placeAt(cursor.x - this.dragOffset.x, cursor.y - this.dragOffset.y, width, height);
    });
    ipcMain.on('orb:dragEnd', (event: IpcMainEvent) => {
      if (this.isOrbSender(event)) this.dragOffset = null;
    });
    ipcMain.on('orb:hide', (event: IpcMainEvent) => {
      if (this.isOrbSender(event)) this.hide();
    });
    ipcMain.on('orb:openMain', (event: IpcMainEvent) => {
      if (this.isOrbSender(event)) this.options.openMainWindow();
    });
  }

  isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible();
  }

  toggle(): void {
    if (this.isVisible()) this.hide();
    else this.show();
  }

  show(): void {
    const win = this.ensureWindow();
    win.show();
    win.focus();
    // A freshly created window may still be loading; tell it once the page is ready.
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send('orb:shown'));
    else win.webContents.send('orb:shown');
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private isOrbSender(event: { sender: { id: number } }): boolean {
    return this.window !== null && !this.window.isDestroyed() && event.sender.id === this.window.webContents.id;
  }

  private assertOrb(event: { sender: { id: number } }): void {
    if (!this.isOrbSender(event)) throw new Error('Only the assistant orb can use this');
  }

  private setExpanded(expanded: boolean): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.expanded = expanded;
    const size = expanded ? EXPANDED : COLLAPSED;
    const [x, y] = this.window.getPosition();
    // Keep the orb's corner where it is and grow toward the free side of the screen.
    this.placeAt(x, y, size.width, size.height);
  }

  /** Moves and resizes the window, clamped so the whole window stays inside the screen's work area. */
  private placeAt(x: number, y: number, width: number, height: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    const area = this.workAreaFor(x, y);
    const bounds: Rectangle = {
      width,
      height,
      x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - width),
      y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - height),
    };
    this.window.setBounds(bounds);
  }

  private workAreaFor(x: number, y: number): Rectangle {
    return screen.getDisplayNearestPoint({ x, y }).workArea;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const area = screen.getPrimaryDisplay().workArea;
    const size = this.expanded ? EXPANDED : COLLAPSED;
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: area.x + area.width - COLLAPSED.width - MARGIN,
      y: area.y + area.height - COLLAPSED.height - MARGIN,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'Buffy',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('closed', () => {
      this.window = null;
      this.dragOffset = null;
    });
    void win.loadFile(this.options.htmlPath);
    this.window = win;
    return win;
  }
}
