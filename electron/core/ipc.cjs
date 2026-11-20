'use strict';
// IPC surface. Renderer sees window.mshh.invoke('<channel>', payload).
// Every handler returns an envelope: { ok:true, data } | { ok:false, error }.

const { dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function registerIpc({ ipcMain, store, manager, bus, getWin, appVersion, log }) {
  const wrap = (fn) => async (_event, payload) => {
    try {
      return { ok: true, data: (await fn(payload)) ?? null };
    } catch (e) {
      const userError = e?.name === 'MshhUserError';
      return { ok: false, error: e?.message || String(e), userError };
    }
  };

  const runnerFor = (profileId) => {
    const runner = manager.runnerFor(profileId);
    if (!runner) throw new Error('Профиль не запущен');
    return runner;
  };

  const profileState = (p) => {
    const runner = manager.runnerFor(p.id);
    return {
      ...p,
      status: runner?.status || (p.enabled ? 'offline' : 'disabled'),
      lastError: runner?.lastError || null,
      runtime: manager.moduleById(p.moduleId)?.manifest.runtime || 'main',
      moduleName: manager.moduleById(p.moduleId)?.manifest.name || p.moduleId,
      pendingPrompt: !!runner?.prompts.size,
    };
  };

  ipcMain.handle('mshh:getState', wrap(async () => ({
    appVersion,
    platform: process.platform,
    profiles: store.list().map(profileState),
    modules: manager.modules.map((m) => m.manifest),
    moduleDefaults: Object.fromEntries(
      manager.modules.filter((m) => m.defaults).map((m) => [m.manifest.id, m.defaults])
    ),
  })));

  ipcMain.handle('mshh:profiles.create', wrap(async ({ moduleId, name, config, adoptPreview }) => {
    const profile = store.create({ moduleId, name, config, enabled: true });
    if (adoptPreview) {
      // усыновление QR-сессии из формы: каталог сессии переезжает в профиль,
      // при старте раннера сессия восстанавливается мгновенно (без нового QR)
      const previewId = `preview_${moduleId}`;
      const old = manager.runnerFor(previewId);
      if (old) {
        await manager.stopRunner(previewId, { silent: true });
        manager.runners.delete(previewId);
      }
      bus.removeProfilePrompts(previewId);
      const previewDir = manager.dataDirFor(previewId);
      const targetDir = manager.dataDirFor(profile.id);
      if (fs.existsSync(previewDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(previewDir, targetDir);
      }
    }
    // подключение — в фоне: connect() может висеть на QR/код-промпте до минуты,
    // IPC не должен блокироваться; статус и промпты уходят событиями
    if (profile.enabled) manager.ensureRunner(profile).catch(() => {});
    bus.emitStateDirty();
    return profileState(profile);
  }));

  ipcMain.handle('mshh:profiles.update', wrap(async ({ id, patch }) => {
    const prev = store.get(id);
    const profile = store.update(id, patch);
    const runner = manager.runnerFor(id);
    const configChanged = patch.config !== undefined;
    const module_ = manager.moduleById(profile.moduleId);
    if (!profile.enabled) {
      if (runner) await manager.stopRunner(id);
    } else if (configChanged && runner && !runner.rendererDriven) {
      runner.restart().catch(() => {});
    } else if (!runner || (!runner.rendererDriven && runner.status === 'error')) {
      manager.ensureRunner(profile).catch(() => {});
    }
    bus.emitStateDirty();
    void module_;
    void prev;
    return profileState(profile);
  }));

  ipcMain.handle('mshh:profiles.delete', wrap(async ({ id }) => {
    await manager.removeRunner(id);
    bus.removeProfilePrompts(id);
    store.delete(id);
    bus.emitStateDirty();
    return null;
  }));

  ipcMain.handle('mshh:profiles.connect', wrap(async ({ id }) => {
    const profile = store.get(id);
    if (!profile) throw new Error('Профиль не найден');
    const module_ = manager.moduleById(profile.moduleId);
    if (!module_) throw new Error(`Модуль «${profile.moduleId}» не установлен`);
    if (module_.manifest.runtime === 'renderer') return { renderer: true };
    const runner = manager.runnerFor(id);
    // не ждём connect(): он может висеть на QR/код-промпте; статус придёт событием
    manager.ensureRunner(profile).catch(() => {});
    return { status: runner?.status || 'connecting', lastError: runner?.lastError || null };
  }));

  ipcMain.handle('mshh:profiles.disconnect', wrap(async ({ id }) => {
    const profile = store.get(id);
    const module_ = manager.moduleById(profile?.moduleId);
    if (module_?.manifest.runtime === 'renderer') return { renderer: true };
    await manager.stopRunner(id);
    return null;
  }));

  ipcMain.handle('mshh:profiles.respond', wrap(async ({ profileId, promptId, value }) => {
    const runner = manager.runnerFor(profileId);
    if (!runner) throw new Error('Профиль не запущен');
    return { delivered: runner.respond(promptId, value) };
  }));

  ipcMain.handle('mshh:profiles.setAvatar', wrap(async ({ id, srcPath }) => {
    const profile = store.get(id);
    if (!profile) throw new Error('Профиль не найден');
    if (typeof srcPath !== 'string' || !fs.existsSync(srcPath)) throw new Error('Файл не найден');
    const dir = manager.dataDirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(srcPath).toLowerCase();
    const dest = path.join(dir, `avatar${ext || '.bin'}`);
    fs.copyFileSync(srcPath, dest);
    const updated = store.update(id, { meta: { avatarPath: dest } });
    bus.emitStateDirty();
    return profileState(updated);
  }));

  ipcMain.handle('mshh:app.setZoom', wrap(async ({ zoom }) => {
    const factor = Number(zoom);
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) {
      throw new Error('Недопустимый масштаб');
    }
    const win_ = getWin();
    if (!win_ || win_.isDestroyed()) throw new Error('no window');
    win_.webContents.setZoomFactor(factor);
    return null;
  }));

  ipcMain.handle('mshh:chats.list', wrap(async () => manager.allChats()));

  // Карточка профиля чата: fields/порядок целиком задаёт модуль
  ipcMain.handle('mshh:chats.peerProfile', wrap(async ({ profileId, chatId }) => {
    const runner = runnerFor(profileId);
    if (!runner.api?.getPeerProfile) throw new Error('Модуль не поддерживает просмотр профиля');
    return runner.api.getPeerProfile(chatId);
  }));


  ipcMain.handle('mshh:chats.history', wrap(async ({ profileId, chatId, beforeTs, limit }) => {
    const runner = runnerFor(profileId);
    if (!beforeTs) return runner.recentMessages(chatId);
    if (!runner.api?.loadHistory) return [];
    const messages = await runner.api.loadHistory(chatId, { beforeTs, limit: limit || 50 });
    return messages.map((m) => ({ ...m, profileId }));
  }));

  ipcMain.handle('mshh:chats.send', wrap(async ({ profileId, chatId, text, files }) => {
    const runner = runnerFor(profileId);
    if (runner.rendererDriven) throw new Error('Этот профиль управляется интерфейсом');
    const message = await runner.api.sendMessage(chatId, { text, files: files || [] });
    return { ...message, profileId, chatId };
  }));

  ipcMain.handle('mshh:chats.open', wrap(async ({ profileId, chatId }) => {
    const runner = manager.runnerFor(profileId);
    if (!runner || runner.rendererDriven) return null;
    runner.markOpened(chatId);
    const chat = runner.chats.get(chatId);
    if (chat?.unread) {
      chat.unread = 0;
      bus.emitModuleEvent(profileId, 'chat', { ...chat });
    }
    return null;
  }));

  ipcMain.handle('mshh:chats.markRead', wrap(async ({ profileId, chatId }) => {
    const runner = manager.runnerFor(profileId);
    if (!runner || runner.rendererDriven) return null;
    const chat = runner.chats.get(chatId);
    if (chat?.unread) {
      chat.unread = 0;
      bus.emitModuleEvent(profileId, 'chat', { ...chat });
    }
    if (runner.api?.markRead) {
      try {
        await runner.api.markRead(chatId);
      } catch (e) {
        runner.log('warn', `markRead failed: ${e?.message}`);
      }
    }
    return null;
  }));

  ipcMain.handle('mshh:chats.typing', wrap(async ({ profileId, chatId }) => {
    const runner = manager.runnerFor(profileId);
    if (runner?.api?.sendTyping) {
      try {
        await runner.api.sendTyping(chatId);
      } catch {
        /* best effort */
      }
    }
    return null;
  }));

  ipcMain.handle('mshh:dialog.pickFiles', wrap(async () => {
    const win = getWin();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  }));

  ipcMain.handle('mshh:formPreview.start', wrap(async ({ moduleId, config }) => {
    const module_ = manager.moduleById(moduleId);
    if (!module_ || module_.manifest.runtime !== 'main') throw new Error('Модуль не поддерживает QR-превью');
    const previewId = `preview_${moduleId}`;
    const old = manager.runnerFor(previewId);
    if (old) await manager.stopRunner(previewId, { silent: true });
    bus.removeProfilePrompts(previewId);
    const previewDir = manager.dataDirFor(previewId);
    fs.rmSync(previewDir, { recursive: true, force: true }); // каждая форма — свежая QR-сессия
    fs.mkdirSync(previewDir, { recursive: true });
    const previewProfile = {
      id: previewId,
      moduleId,
      name: `preview ${moduleId}`,
      enabled: true,
      config: config && typeof config === 'object' ? { ...config } : {},
      createdAt: Date.now(),
    };
    const { ProfileRunner } = require('./runner.cjs');
    const runner = new ProfileRunner({
      profile: previewProfile,
      module_,
      dataDir: previewDir,
      bus,
      log,
    });
    // авторизованная preview-сессия (скан QR) → автоматически создать профиль
    runner.previewAdopt = async (previewRunner) => {
      const previewId = previewRunner.profile.id;
      const realProfile = store.create({
        moduleId,
        name: moduleId === 'telegram' ? 'Telegram' : moduleId,
        config: previewRunner.profile.config,
        enabled: true,
      });
      const old = manager.runnerFor(previewId);
      if (old) {
        await manager.stopRunner(previewId, { silent: true });
        manager.runners.delete(previewId);
      }
      bus.removeProfilePrompts(previewId);
      const previewDir = manager.dataDirFor(previewId);
      const targetDir = manager.dataDirFor(realProfile.id);
      if (fs.existsSync(previewDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(previewDir, targetDir);
      }
      log('info', `QR-вход завершён — профиль создан (${realProfile.name})`);
      await manager.ensureRunner(realProfile).catch(() => {});
      bus.emitStateDirty();
    };
    manager.runners.set(previewId, runner);
    runner.start().catch(() => {}); // ошибки видны статусом промпта в форме
    return { previewId };
  }));

  ipcMain.handle('mshh:formPreview.stop', wrap(async ({ moduleId }) => {
    const previewId = `preview_${moduleId}`;
    const old = manager.runnerFor(previewId);
    if (old) await manager.stopRunner(previewId, { silent: true });
    bus.removeProfilePrompts(previewId);
    manager.runners.delete(previewId);
    return null;
  }));

  ipcMain.handle('mshh:getPendingPrompts', wrap(async () => bus.getPendingPrompts()));

  ipcMain.handle('mshh:shell.openExternal', wrap(async ({ url }) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
    return null;
  }));

  // Debug-only visual proof channel (MSHH_DEBUG=1): renderer-composited frame.
  ipcMain.handle('mshh:debug.screenshot', wrap(async () => {
    if (process.env.MSHH_DEBUG !== '1') throw new Error('disabled');
    const win_ = getWin();
    if (!win_ || win_.isDestroyed()) throw new Error('no window');
    win_.show();
    win_.moveTop();
    const image = await win_.webContents.capturePage();
    return image.toPNG().toString('base64');
  }));
}

module.exports = { registerIpc };
