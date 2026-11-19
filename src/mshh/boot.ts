import { mshhDesktop } from './api';
import { startMshhCore } from './state';

/**
 * Boots the MSHH core in the renderer: profile/chat state sync with the
 * Electron main process + renderer-runtime bridges (Matrix).
 * No-op outside Electron (plain Cinny web app).
 */
export function bootMshh() {
  if (!mshhDesktop) return;
  document.title = 'MSHH';
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
