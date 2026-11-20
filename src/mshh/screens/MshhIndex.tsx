import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Provider, getDefaultStore, useAtomValue } from 'jotai';
import { Box, Spinner, Text, config, toRem } from 'folds';
import { coreErrorAtom, coreReadyAtom, establishedProfiles, profilesAtom } from '../state';
import { getMshhPath, getMshhProfilesPath } from '../../app/pages/pathUtils';
import { Welcome } from './Welcome';
import { PromptDialog } from './PromptDialog';
import { MshhPrefsScope } from '../prefs';

/**
 * state.ts ingests IPC events through jotai's default store, while the Cinny app
 * wraps the router in its own <Provider>. Re-expose the default store to the MSHH
 * subtree so hooks like useAtomValue see the same state the bridges write.
 */
const mshhStore = getDefaultStore();

function MshhGate() {
  const profiles = useAtomValue(profilesAtom);
  const coreReady = useAtomValue(coreReadyAtom);
  const coreError = useAtomValue(coreErrorAtom);
  const location = useLocation();
  // Ошибочные/ещё не авторизованные профили поверхность чатов не открывают
  const established = establishedProfiles(profiles);
  // Площадки без собственного PromptDialog (чат и форма профиля рендерят свой):
  // список чатов, менеджер профилей, настройки. Здесь авторизационный код/QR,
  // пришедший от модуля, должен быть виден в любом месте приложения.
  const path = location.pathname;
  const surfaceRendersOwnDialog =
    path.startsWith(`${getMshhPath()}/chat/`) || path.startsWith(`${getMshhProfilesPath()}/`);

  if (!coreReady) {
    return (
      <Box grow="Yes" alignItems="Center" justifyContent="Center">
        <Spinner size="400" variant="Secondary" fill="Soft" />
      </Box>
    );
  }

  if (coreError) {
    return (
      <Box
        grow="Yes"
        direction="Column"
        alignItems="Center"
        justifyContent="Center"
        gap="200"
        style={{ padding: config.space.S500 }}
      >
        <Text size="H4">MSHH недоступен</Text>
        <Text size="T300" priority="300" align="Center" style={{ maxWidth: toRem(480) }}>
          {coreError}
        </Text>
      </Box>
    );
  }

  // Нет ни одного рабочего профиля → заглушка-приветствие. Формы добавления
  // и менеджер профилей остаются доступны, чтобы профиль можно было создать.
  if (established.length === 0 && location.pathname.startsWith(getMshhProfilesPath())) {
    return <Outlet />;
  }
  if (established.length === 0) {
    return <Welcome />;
  }

  return (
    <>
      {!surfaceRendersOwnDialog && <PromptDialog />}
      <Outlet />
    </>
  );
}

/** Root of the MSHH route subtree: gates on core readiness and profile count. */
export function MshhIndex() {
  return (
    <Provider store={mshhStore}>
      <MshhPrefsScope>
        <MshhGate />
      </MshhPrefsScope>
    </Provider>
  );
}
