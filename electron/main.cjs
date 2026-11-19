'use strict';
// MSHH — Electron entry. Hosts the module core in main; renderer is the
// Cinny build served over loopback http.

const { app, BrowserWindow, Menu, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const APP_VERSION = '0.1.0';

app.setName('MSHH');
app.setPath('userData', path.join(app.getPath('appData'), 'MSHH'));

const { Bus } = require('./core/bus.cjs');
const { ProfileStore, loadModules } = require('./core/store.cjs');
const { RunnerManager } = require('./core/runner.cjs');
const { registerIpc } = require('./core/ipc.cjs');
const { registerMediaScheme, installMediaHandler, mediaUrl } = require('./core/media.cjs');
const { ipcMain } = require('electron');

registerMediaScheme(); // must happen before app ready

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const bus = new Bus();
let win = null;
let manager = null;
let store = null;

const log = (level, msg, meta) => {
  const line = `[mshh:${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  // eslint-disable-next-line no-console
  console.log(line);
};

const DEV_URL = process.env.ELECTRON_START_URL || '';

function startStaticServer(distDir) {
  const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.elm': 'application/octet-stream',
  };
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let filePath = path.resolve(distDir, `.${path.posix.normalize(urlPath)}`);
      if (!filePath.startsWith(path.resolve(distDir))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      if (!stat || stat.isDirectory()) {
        // SPA fallback
        filePath = path.resolve(distDir, 'index.html');
        if (!fs.existsSync(filePath)) {
          res.writeHead(404).end('dist not built');
          return;
        }
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e?.message || e));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 500,
    minHeight: 500,
    title: 'MSHH',
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  void win.loadURL(url);
  if (process.env.MSHH_DEBUG === '1') win.webContents.openDevTools({ mode: 'detach' });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'quit' }])
  );

  installMediaHandler(app.getPath('userData'));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Cinny fetches homeservers of arbitrary origin; allow but sandbox ourselves.
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' mshh-media: blob: data: https:; media-src 'self' mshh-media: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss: blob:; worker-src 'self' blob:; frame-src https:; object-src 'none'",
        ],
      },
    });
  });

  const distDir = process.env.MSHH_DIST || path.join(REPO_ROOT, 'dist');
  let baseUrl;
  if (DEV_URL) {
    baseUrl = DEV_URL;
    log('info', `dev mode: ${baseUrl}`);
  } else {
    const server = await startStaticServer(distDir);
    baseUrl = `http://127.0.0.1:${server.address().port}/`;
    log('info', `serving ${distDir} at ${baseUrl}`);
  }

  const modules = await loadModules(REPO_ROOT, log);
  store = new ProfileStore(app.getPath('userData'), modules);
  manager = new RunnerManager({ store, userDataDir: app.getPath('userData'), repoRoot: REPO_ROOT, bus, log });
  manager.setModules(modules);
  registerIpc({ ipcMain, store, manager, bus, getWin: () => win, appVersion: APP_VERSION, log });

  log(
    'info',
    `modules: ${modules.map((m) => m.manifest.id).join(', ') || '—'}; profiles: ${store.list().length}`
  );

  createWindow(baseUrl);
  bus.attach(win);

  win.webContents.once('did-finish-load', () => {
    void manager.startAll();
  });

  void mediaUrl; // exported for renderer parity; not used in main
});

app.on('before-quit', () => {
  void manager?.stopAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
