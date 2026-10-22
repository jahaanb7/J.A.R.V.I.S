import { contextBridge, ipcRenderer } from 'electron';

/** The only API the orb page can reach. Each channel is checked again in the main process. */
contextBridge.exposeInMainWorld('orb', {
  ask: (text: string): Promise<{ reply: string; spoken: string }> => ipcRenderer.invoke('orb:ask', text),
  resize: (expanded: boolean): void => ipcRenderer.send('orb:resize', expanded),
  dragStart: (): void => ipcRenderer.send('orb:dragStart'),
  dragMove: (): void => ipcRenderer.send('orb:dragMove'),
  dragEnd: (): void => ipcRenderer.send('orb:dragEnd'),
  hide: (): void => ipcRenderer.send('orb:hide'),
  openMain: (): void => ipcRenderer.send('orb:openMain'),
  onShown: (handler: () => void): void => {
    ipcRenderer.on('orb:shown', () => handler());
  },
});
