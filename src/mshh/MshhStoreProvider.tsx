import React, { useEffect } from 'react';
import { getDefaultStore, useAtomValue } from 'jotai';
import { Box, Text, config, toRem } from 'folds';
import { useMatrixClient } from '../app/hooks/useMatrixClient';
import { ContainerColor } from '../app/styles/ContainerColor.css';
import * as api from './api';
import {
  attachMshhEvents,
  loadProfileChats,
  mshhErrorMessage,
  profilesAtom,
  refreshModules,
  refreshProfiles,
  toastsAtom,
} from './state';
import { isMatrixProfileId } from './types';
import type { MshhToast } from './state';

const TOAST_TIMEOUT = 4000;

function ToastItem({ toast }: { toast: MshhToast }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const store = getDefaultStore();
      store.set(
        toastsAtom,
        store.get(toastsAtom).filter((t) => t.id !== toast.id)
      );
    }, TOAST_TIMEOUT);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <Box
      className={ContainerColor({ variant: 'Surface' })}
      style={{ padding: config.space.S200, borderRadius: config.radii.R300 }}
      alignItems="Center"
    >
      <Text size="T300">{toast.text}</Text>
    </Box>
  );
}

function MshhToasts() {
  const toasts = useAtomValue(toastsAtom);
  if (toasts.length === 0) return null;
  return (
    <Box
      direction="Column"
      gap="200"
      style={{
        position: 'fixed',
        bottom: config.space.S400,
        right: config.space.S400,
        zIndex: 9999,
        maxWidth: toRem(320),
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </Box>
  );
}

/**
 * Mounts the mshh store once per entry point (Home and Settings both use it).
 * The event subscription itself is refcounted in state.ts.
 */
export function MshhStoreProvider({ children }: { children: React.ReactNode }) {
  const mx = useMatrixClient();

  useEffect(() => {
    const detach = attachMshhEvents();
    let cancelled = false;

    const init = async () => {
      await refreshModules();
      await refreshProfiles(mx.getUserId() ?? undefined);
      if (cancelled) return;
      const profiles = getDefaultStore().get(profilesAtom);
      await Promise.all(
        profiles
          .filter((p) => p.enabled && !isMatrixProfileId(p.id))
          .map((p) => loadProfileChats(p.id))
      );
    };
    void init().catch((e) => {
      console.warn('[mshh] init failed:', mshhErrorMessage(e));
    });

    return () => {
      cancelled = true;
      detach();
    };
  }, [mx]);

  return (
    <>
      {children}
      <MshhToasts />
    </>
  );
}
