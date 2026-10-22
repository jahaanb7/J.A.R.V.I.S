import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jarvis', {
  call: (method: string, args?: unknown): Promise<unknown> => ipcRenderer.invoke('jarvis:call', method, args),
  onEvent: (handler: (event: unknown) => void): void => {
    ipcRenderer.on('jarvis:event', (_event, payload: unknown) => handler(payload));
  },
});
