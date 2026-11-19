import React from 'react';
import { Box, Scroll, Text, config, toRem } from 'folds';
import { useNavigate } from 'react-router-dom';

import { Page, PageContent } from '../../app/components/page';
import { getLoginPath } from '../../app/pages/pathUtils';
import { Profiles } from '../../app/features/settings/profiles';
import { MshhStoreProvider } from '../MshhStoreProvider';
import { UnifiedChats } from './UnifiedChats';
import { MshhChatView } from './MshhChatView';
import CinnySVG from '../../../public/res/svg/cinny.svg';

function LaunchContent() {
  const navigate = useNavigate();

  return (
    <Page>
      <Box
        shrink="No"
        direction="Column"
        alignItems="Center"
        gap="200"
        style={{ padding: `${config.space.S600} ${config.space.S400} ${config.space.S400}` }}
      >
        <img
          src={CinnySVG}
          alt="Mshh"
          style={{ width: toRem(56), height: toRem(56) }}
        />
        <Text size="H3">Mshh</Text>
        <Text size="T300" priority="300" align="Center" style={{ maxWidth: toRem(480) }}>
          Мультипротокольный мессенджер. Добавьте профиль — Telegram, WhatsApp или
          Matrix — и общайтесь. Matrix-аккаунт не обязателен.
        </Text>
      </Box>
      <Box grow="Yes">
        <Scroll hideTrack visibility="Hover">
          <PageContent>
            <Box direction="Column" gap="600">
              <Profiles onMatrixLogin={() => navigate(getLoginPath())} />
              <UnifiedChats sortedRoomIds={[]} />
              <Box direction="Column" gap="100" alignItems="Center" style={{ paddingBottom: config.space.S600 }}>
                <Text size="T200" priority="300">
                  Модули устанавливаются в папку mshh_modules —{' '}
                  <a href="https://github.com/Fanikalin/MSHH/blob/main/docs/mshh/MODULE_API.md" target="_blank" rel="noreferrer noopener">
                    как написать свой
                  </a>
                  .
                </Text>
              </Box>
            </Box>
          </PageContent>
        </Scroll>
      </Box>
      <MshhChatView />
    </Page>
  );
}

export function MshhLaunch() {
  return (
    <MshhStoreProvider>
      <LaunchContent />
    </MshhStoreProvider>
  );
}
