import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only API a widget page can reach. It can hide itself, keep itself open while the user
 * interacts with it, and read or write its own data. Nothing else is exposed.
 */
contextBridge.exposeInMainWorld('buffy', {
  hide: (): void => ipcRenderer.send('widget:hide'),
  pin: (): void => ipcRenderer.send('widget:pin'),
  load: (): Promise<unknown> => ipcRenderer.invoke('widget:load'),
  save: (data: unknown): Promise<void> => ipcRenderer.invoke('widget:save', data),
});
