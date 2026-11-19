/* eslint-disable import/first */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { enableMapSet } from 'immer';
import '@fontsource/inter/variable.css';
import 'folds/dist/style.css';
import { configClass, varsClass } from 'folds';

enableMapSet();

import './index.css';

import { trimTrailingSlash } from './app/utils/common';
import App from './app/pages/App';

// import i18n (needs to be bundled ;))
import './app/i18n';
import { pushSessionToSW } from './sw-session';
import { getFallbackSession } from './app/state/sessions';

document.body.classList.add(configClass, varsClass);

// Register Service Worker (skipped inside MSHH/Electron — docs/CINNY_WIRING.md)
if ('serviceWorker' in navigator && !window.mshh?.desktop) {
  const swUrl =
    import.meta.env.MODE === 'production'
      ? `${trimTrailingSlash(import.meta.env.BASE_URL)}/sw.js`
      : `/dev-sw.js?dev-sw`;

  const sendSessionToSW = () => {
    const session = getFallbackSession();
    pushSessionToSW(session?.baseUrl, session?.accessToken);
  };

  navigator.serviceWorker.register(swUrl).then(sendSessionToSW);
  navigator.serviceWorker.ready.then(sendSessionToSW);

  navigator.serviceWorker.addEventListener('message', (ev) => {
    const { type } = ev.data ?? {};

    if (type === 'requestSession') {
      sendSessionToSW();
    }
  });
}

const mountApp = () => {
  const rootContainer = document.getElementById('root');

  if (rootContainer === null) {
    // eslint-disable-next-line no-console
    console.error('Root container element not found!');
    return;
  }

  // MSHH: boot the module core when running inside the Electron shell
  if (window.mshh?.desktop) {
    import('./mshh/boot').then((m) => m.bootMshh());
  }

  const root = createRoot(rootContainer);
  root.render(<App />);
};

mountApp();
