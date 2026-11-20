import { api, mshhDesktop } from './api';
import { startMshhCore } from './state';

/** localStorage key of the persisted UI zoom factor. */
const ZOOM_KEY = 'mshh_zoom';

/** Restore the saved interface zoom (see MshhSettings). No-op without a saved value. */
function applySavedZoom() {
  try {
    const zoom = Number(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) {
      api.setZoom(zoom).catch(() => {
        /* zoom is cosmetic — ignore IPC failures */
      });
    }
  } catch {
    /* no localStorage — skip */
  }
}

/**
 * Boots the MSHH core in the renderer: profile/chat state sync with the
 * Electron main process + renderer-runtime bridges (Matrix).
 * No-op outside Electron (plain Cinny web app).
 */
export function bootMshh() {
  if (!mshhDesktop) return;
  document.title = 'MSHH';
  applySavedZoom();
  // drop any service worker left from a previous browser use of this origin
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => {
        reg.unregister();
      });
    });
  }
  startMshhCore()
    .then(() => import('./bridges/matrix'))
    .then((m) => m.startMatrixBridges())
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[mshh] boot failed', e);
    });
}
