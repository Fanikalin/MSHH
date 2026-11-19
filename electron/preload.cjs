'use strict';
// Preload: minimal, sandbox-safe bridge. Renderer gets window.mshh.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mshh', {
  desktop: true,
  invoke: (channel, payload) => ipcRenderer.invoke(`mshh:${channel}`, payload),
  onEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('mshh:event', listener);
    return () => ipcRenderer.removeListener('mshh:event', listener);
  },
  onProfilesChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('mshh:profiles-changed', listener);
    return () => ipcRenderer.removeListener('mshh:profiles-changed', listener);
  },
});
