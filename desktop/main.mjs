import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleHost } from './moduleHost.mjs';
import { ProfilesStore, profilesFileFor } from './profilesStore.mjs';
import { registerIpc } from './ipc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const DEV_URL = process.env.MSHH_DEV_URL ?? 'http://localhost:5173';
const USE_DEV_SERVER = !app.isPackaged && process.env.MSHH_DEV !== '0';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

function boot() {
  // userData dir name "mshh" (independent of productName)
  app.setName('mshh');
  app.setPath('userData', path.join(app.getPath('appData'), 'mshh'));

  /** @type {BrowserWindow | undefined} */
  let mainWindow;
  /** @type {ModuleHost | undefined} */
  let host;
  /** @type {ProfilesStore | undefined} */
  let store;
  let quitting = false;

  const log = (level, msg) => {
    const line = `[mshh:${level}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  const broadcast = (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('mshh:event', payload);
    }
  };

  const createWindow = () => {
    mainWindow = new BrowserWindow({
      title: 'Mshh',
      width: 1280,
      height: 800,
      minWidth: 1000,
      minHeight: 700,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(here, 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // ESM preload scripts require the sandbox to be disabled.
        sandbox: false,
      },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      const allowed = USE_DEV_SERVER && url.startsWith(DEV_URL);
      if (!allowed) event.preventDefault();
    });

    const loadDist = () => {
      const indexHtml = path.join(appDir, 'dist', 'index.html');
      if (fs.existsSync(indexHtml)) return mainWindow.loadFile(indexHtml);
      log('error', `dist/index.html not found at ${indexHtml} — run "npm run build"`);
      return Promise.resolve();
    };

    if (USE_DEV_SERVER) {
      // vite dev server; fall back to the built renderer when it isn't running
      mainWindow.loadURL(DEV_URL).catch(loadDist);
      mainWindow.webContents.on('did-fail-load', (_e, _code, _desc, url, isMainFrame) => {
        if (isMainFrame && url.startsWith('http')) loadDist().catch(() => {});
      });
    } else {
      loadDist();
    }

    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  };

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.whenReady().then(async () => {
    store = new ProfilesStore({ file: profilesFileFor(app.getPath('userData')) });
    await store.load();
    host = new ModuleHost({ appDir, userDataDir: app.getPath('userData'), store, log });
    registerIpc({ ipcMain, host, store, pushEvent: broadcast });

    createWindow();

    // Connect every enabled profile from previous runs.
    const enabled = (await store.list()).filter((p) => p.enabled);
    log('info', `auto-connecting ${enabled.length} enabled profile(s)`);
    await Promise.allSettled(enabled.map((p) => host.connectProfile(p)));
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting || !host) return;
    quitting = true;
    event.preventDefault();
    const ids = host.listConnected();
    log('info', `disconnecting ${ids.length} profile(s) before quit`);
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
    Promise.race([host.disconnectAll(), timeout])
      .catch(() => {})
      .then(() => app.quit());
  });
}
