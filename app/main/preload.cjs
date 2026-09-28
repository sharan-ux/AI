const { contextBridge, ipcRenderer } = require('electron');

// The only surface the face page gets. No Node, no filesystem, no shell.
contextBridge.exposeInMainWorld('jarvis', {
  config: () => ipcRenderer.invoke('jarvis:config'),
  command: (text) => ipcRenderer.invoke('jarvis:command', String(text)),
  answer: (id, value) => ipcRenderer.send('jarvis:answer', String(id),
    value === true ? true : value === false ? false : typeof value === 'string' ? value.slice(0, 500) : null),
  transcribe: (pcm) => ipcRenderer.invoke('jarvis:transcribe', pcm),
  speak: (text) => ipcRenderer.invoke('jarvis:speak', String(text)),
  onEvent: (cb) => { ipcRenderer.on('jarvis:event', (_e, evt) => cb(evt)); },
  ready: () => ipcRenderer.send('jarvis:renderer-ready'),
});
