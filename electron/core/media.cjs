'use strict';
// mshh-media:// protocol: serves files that live under the app userData dir
// (module session data: avatars, downloaded media). Path is passed whole as
// the URL path, URL-encoded: mshh-media://f/<encodeURIComponent(absPath)>

const { net, protocol } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

/** Must run before app.ready (Electron requirement). */
function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'mshh-media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Runs after app.ready. */
function installMediaHandler(userDataDir) {
    protocol.handle('mshh-media', async (request) => {
      try {
        const u = new URL(request.url);
        const rel = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
        const abs = path.resolve(rel || '');
        const root = path.resolve(userDataDir);
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          return new Response('forbidden', { status: 403 });
        }
        const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        const resp = await net.fetch(pathToFileURL(abs).toString());
        return new Response(resp.body, {
          status: 200,
          headers: { 'content-type': mime, 'cache-control': 'private, max-age=86400' },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
}

/** Build renderer-safe URL for a media file path. */
function mediaUrl(filePath) {
  return `mshh-media://f/${encodeURIComponent(filePath)}`;
}

module.exports = { registerMediaScheme, installMediaHandler, mediaUrl };
