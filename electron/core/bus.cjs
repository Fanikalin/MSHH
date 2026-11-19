'use strict';
// Event bus: main → renderer event fan-out with buffering until window ready.

const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.queue = [];
    // последний активный промпт каждого профиля: renderer может запросить
    // replay при загрузке (события, ушедшие до подписки, иначе теряются)
    this.lastPrompts = new Map();
  }

  attach(win) {
    this.win = win;
    for (const item of this.queue.splice(0)) {
      this.send(item.channel, item.payload);
    }
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
      return true;
    }
    if (this.queue.length < 1000) this.queue.push({ channel, payload });
    return false;
  }

  /** Module-runner normalized event → renderer. */
  emitModuleEvent(profileId, type, payload) {
    if (type === 'prompt') {
      this.lastPrompts.set(profileId, { profileId, type, payload });
    }
    this.send('mshh:event', { profileId, type, payload });
  }

  clearLastPrompt(profileId, promptId) {
    const current = this.lastPrompts.get(profileId);
    if (current && current.payload.promptId === promptId) this.lastPrompts.delete(profileId);
  }

  removeProfilePrompts(profileId) {
    this.lastPrompts.delete(profileId);
  }

  getPendingPrompts() {
    return [...this.lastPrompts.values()];
  }

  emitStateDirty() {
    this.send('mshh:profiles-changed', {});
  }
}

module.exports = { Bus };
