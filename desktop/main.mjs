import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleHost } from './moduleHost.mjs';
import { ProfilesStore, profilesFileFor } from './profilesStore.mjs';
import { registerIpc } from './ipc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

// The built renderer references assets with absolute paths ("/assets/…"), which
// break under file:// loading. Serve dist/ over a custom standard scheme instead.
const APP_SCHEME = 'app';
const APP_ORIGIN = 'app://mshh';
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

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
      const allowed =
        (USE_DEV_SERVER && url.startsWith(DEV_URL)) || url.startsWith(APP_ORIGIN);
      if (!allowed) event.preventDefault();
    });

    const loadDist = () => {
      const indexHtml = path.join(appDir, 'dist', 'index.html');
      if (fs.existsSync(indexHtml)) return mainWindow.loadURL(APP_ORIGIN);
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
    // SPA server for the built renderer: app://mshh/<path> → <appDir>/dist/<path>
    const distDir = path.join(appDir, 'dist');
    const MIME = {
      '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
      '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain',
      '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
    };
    protocol.handle(APP_SCHEME, (request) => {
      const { pathname } = new URL(request.url);
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      let filePath = path.normalize(path.join(distDir, rel));
      if (!filePath.startsWith(distDir)) return new Response('forbidden', { status: 403 });
      let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : undefined;
      if (!stat || stat.isDirectory()) {
        // SPA fallback: route paths without an extension get index.html
        if (!path.extname(rel)) filePath = path.join(distDir, 'index.html');
        else return new Response('not found', { status: 404 });
        if (!fs.existsSync(filePath)) return new Response('not found', { status: 404 });
      }
      const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(fs.readFileSync(filePath), {
        headers: { 'content-type': type, 'cache-control': 'no-cache' },
      });
    });

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
