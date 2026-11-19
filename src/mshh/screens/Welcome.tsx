import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Icon, Icons, Text, config, toRem } from 'folds';
import { Page, PageHero, PageHeroSection } from '../../app/components/page';
import { getMshhProfileNewPath, getMshhProfilesPath } from '../../app/pages/pathUtils';

/** Zero-profiles screen shown by MshhIndex until the first profile exists. */
export function Welcome() {
  const navigate = useNavigate();

  return (
    <Page>
      <Box
        grow="Yes"
        alignItems="Center"
        justifyContent="Center"
        style={{
          padding: config.space.S400,
          paddingBottom: config.space.S700,
        }}
      >
        <PageHeroSection>
          <PageHero
            icon={<Icon size="500" src={Icons.Message} />}
            title="MSHH"
            subTitle="Мультипротокольный мессенджер"
          >
            <Box direction="Column" alignItems="Center" gap="400">
              <Text align="Center" priority="300" style={{ maxWidth: toRem(420) }}>
                Профиль — это аккаунт в одном из мессенджеров: Telegram, WhatsApp, VK, XMPP, Matrix
                и другие. Добавьте профили, и все их чаты появятся в едином списке.
              </Text>
              <Box direction="Column" gap="300" style={{ maxWidth: toRem(300) }}>
                <Button
                  size="400"
                  variant="Primary"
                  before={<Icon size="200" src={Icons.UserPlus} />}
                  onClick={() => navigate(getMshhProfileNewPath())}
                >
                  <Text as="span" size="B400" truncate>
                    Добавить профиль
                  </Text>
                </Button>
                <Button size="400" fill="Soft" onClick={() => navigate(getMshhProfilesPath())}>
                  <Text as="span" size="B400" truncate>
                    Управление профилями
                  </Text>
                </Button>
              </Box>
            </Box>
          </PageHero>
        </PageHeroSection>
      </Box>
    </Page>
  );
}
