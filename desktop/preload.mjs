import { contextBridge, ipcRenderer } from 'electron';

// Exact surface from docs/mshh/MODULE_API.md → window.mshh
const api = {
  listModules: () => ipcRenderer.invoke('mshh:listModules'),
  listProfiles: () => ipcRenderer.invoke('mshh:listProfiles'),
  saveProfile: (p) => ipcRenderer.invoke('mshh:saveProfile', p),
  setProfileSecret: (id, key, value) => ipcRenderer.invoke('mshh:setProfileSecret', id, key, value),
  deleteProfile: (id) => ipcRenderer.invoke('mshh:deleteProfile', id),
  setEnabled: (id, enabled) => ipcRenderer.invoke('mshh:setEnabled', id, enabled),
  connectProfile: (id) => ipcRenderer.invoke('mshh:connect', id),
  disconnectProfile: (id) => ipcRenderer.invoke('mshh:disconnect', id),
  submitAuth: (id, value) => ipcRenderer.invoke('mshh:submitAuth', id, value),
  send: (id, chatId, text) => ipcRenderer.invoke('mshh:send', id, chatId, text),
  markRead: (id, chatId, messageId) => ipcRenderer.invoke('mshh:markRead', id, chatId, messageId),
  setTyping: (id, chatId, on) => ipcRenderer.invoke('mshh:setTyping', id, chatId, on),
  getChats: (id) => ipcRenderer.invoke('mshh:getChats', id),
  getMessages: (id, chatId) => ipcRenderer.invoke('mshh:getMessages', id, chatId),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('mshh:event', listener);
    return () => ipcRenderer.removeListener('mshh:event', listener);
  },
};

contextBridge.exposeInMainWorld('mshh', api);
