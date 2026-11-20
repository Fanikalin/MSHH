import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import FocusTrap from 'focus-trap-react';
import {
  Box,
  Button,
  Dialog,
  Header,
  Icon,
  IconButton,
  Icons,
  Overlay,
  OverlayBackdrop,
  OverlayCenter,
  Scroll,
  Switch,
  Text,
  color,
  config,
} from 'folds';
import { Page, PageHeader } from '../../app/components/page';
import { SettingTile } from '../../app/components/setting-tile/SettingTile';
import { stopPropagation } from '../../app/utils/keyboard';
import {
  getMshhPath,
  getMshhProfileEditPath,
  getMshhProfileNewPath,
  getMshhSettingsPath,
} from '../../app/pages/pathUtils';
import { api } from '../api';
import { profilesAtom } from '../state';
import { Profile } from '../types';
import { MshhAvatar } from '../components/MshhAvatar';
import { ModuleChip } from '../components/ModuleChip';
import { StatusDot, profileStatusText } from '../components/StatusDot';
import { useMshhT } from '../i18n';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Profile manager: enable/disable, reconnect, edit and delete profiles. */
export function MshhProfiles() {
  const profiles = useAtomValue(profilesAtom);
  const navigate = useNavigate();
  const t = useMshhT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const run = useCallback(async (profileId: string, action: () => Promise<unknown>) => {
    setBusyId(profileId);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(`${profileId}: ${errorMessage(error)}`);
    } finally {
      setBusyId(null);
    }
  }, []);

  const toggleEnabled = useCallback(
    (profile: Profile, enabled: boolean) =>
      run(profile.id, async () => {
        await api.setProfileEnabled(profile.id, enabled);
        if (!enabled && profile.runtime === 'main') {
          await api.disconnectProfile(profile.id);
        }
      }),
    [run]
  );

  const removeProfile = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteProfile(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget]);

  return (
    <Page>
      <PageHeader outlined balance>
        <Box shrink="No">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => navigate(getMshhPath())}
            aria-label={t('back.toChats')}
          >
            <Icon src={Icons.ArrowGoLeft} />
          </IconButton>
        </Box>
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="H4" truncate>
            {t('profiles.title')}
          </Text>
        </Box>
        <Box shrink="No" gap="100">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => navigate(getMshhSettingsPath())}
            aria-label={t('nav.settings')}
          >
            <Icon src={Icons.HorizontalDots} />
          </IconButton>
          <Button
            size="300"
            variant="Primary"
            before={<Icon size="100" src={Icons.Plus} />}
            onClick={() => navigate(getMshhProfileNewPath())}
          >
            <Text as="span" size="B300">
              {t('profiles.add')}
            </Text>
          </Button>
        </Box>
      </PageHeader>
      <Box grow="Yes" direction="Column" style={{ minHeight: 0 }}>
        <Scroll
          variant="Background"
          direction="Vertical"
          size="300"
          hideTrack
          visibility="Hover"
          style={{ height: '100%' }}
        >
          <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
            {actionError && (
              <Text size="T200" style={{ color: color.Critical.Main }}>
                {actionError}
              </Text>
            )}
            {profiles.length === 0 ? (
              <Box
                direction="Column"
                alignItems="Center"
                gap="300"
                style={{ padding: config.space.S700 }}
              >
                <Icon size="300" src={Icons.User} />
                <Text size="T300" priority="300">
                  {t('profiles.empty')}
                </Text>
                <Button
                  variant="Primary"
                  fill="Soft"
                  before={<Icon size="100" src={Icons.Plus} />}
                  onClick={() => navigate(getMshhProfileNewPath())}
                >
                  <Text as="span" size="B400">
                    {t('profiles.add')}
                  </Text>
                </Button>
              </Box>
            ) : (
              profiles.map((profile) => {
                const busy = busyId === profile.id;
                return (
                  <SettingTile
                    key={profile.id}
                    before={<MshhAvatar id={profile.id} name={profile.name} size="400" />}
                    title={
                      <Box alignItems="Center" gap="200">
                        <Text size="T300" truncate style={{ minWidth: 0 }}>
                          {profile.name}
                        </Text>
                        <ModuleChip name={profile.moduleName} />
                      </Box>
                    }
                    description={
                      <Box alignItems="Center" gap="100">
                        <StatusDot status={profile.status} />
                        <Text
                          size="T200"
                          priority="300"
                          truncate
                          style={{
                            color: profile.status === 'error' ? color.Critical.Main : undefined,
                          }}
                        >
                          {profileStatusText(profile)}
                        </Text>
                      </Box>
                    }
                    after={
                      <Switch
                        value={profile.enabled}
                        onChange={(enabled) => toggleEnabled(profile, enabled)}
                      />
                    }
                  >
                    <Box wrap="Wrap" gap="100" style={{ paddingTop: config.space.S200 }}>
                      {profile.enabled ? (
                        <>
                          <Button
                            size="300"
                            variant="Secondary"
                            fill="Soft"
                            aria-disabled={busy}
                            before={<Icon size="100" src={Icons.Reload} />}
                            onClick={() => run(profile.id, () => api.connectProfile(profile.id))}
                          >
                            <Text as="span" size="B300">
                              {t('action.reconnect')}
                            </Text>
                          </Button>
                          <Button
                            size="300"
                            variant="Warning"
                            fill="Soft"
                            aria-disabled={busy}
                            onClick={() => run(profile.id, () => api.disconnectProfile(profile.id))}
                          >
                            <Text as="span" size="B300">
                              {t('action.disconnect')}
                            </Text>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="300"
                          variant="Secondary"
                          fill="Soft"
                          aria-disabled={busy}
                          before={<Icon size="100" src={Icons.Power} />}
                          onClick={() =>
                            run(profile.id, async () => {
                              await api.setProfileEnabled(profile.id, true);
                              await api.connectProfile(profile.id);
                            })
                          }
                        >
                          <Text as="span" size="B300">
                            {t('action.connect')}
                          </Text>
                        </Button>
                      )}
                      <Button
                        size="300"
                        fill="Soft"
                        before={<Icon size="100" src={Icons.Pencil} />}
                        onClick={() => navigate(getMshhProfileEditPath(profile.id))}
                      >
                        <Text as="span" size="B300">
                          {t('action.edit')}
                        </Text>
                      </Button>
                      <Button
                        size="300"
                        variant="Critical"
                        fill="Soft"
                        before={<Icon size="100" src={Icons.Delete} />}
                        onClick={() => setDeleteTarget(profile)}
                      >
                        <Text as="span" size="B300">
                          {t('action.delete')}
                        </Text>
                      </Button>
                    </Box>
                  </SettingTile>
                );
              })
            )}
          </Box>
        </Scroll>
      </Box>
      <Overlay open={deleteTarget !== null} backdrop={<OverlayBackdrop />}>
        <OverlayCenter>
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              onDeactivate: () => setDeleteTarget(null),
              clickOutsideDeactivates: true,
              escapeDeactivates: stopPropagation,
            }}
          >
            <Dialog variant="Surface">
              <Header
                style={{
                  padding: `0 ${config.space.S200} 0 ${config.space.S400}`,
                  borderBottomWidth: config.borderWidth.B300,
                }}
                variant="Surface"
                size="500"
              >
                <Box grow="Yes">
                  <Text size="H4">{t('profiles.deleteTitle')}</Text>
                </Box>
                <IconButton size="300" radii="300" onClick={() => setDeleteTarget(null)}>
                  <Icon src={Icons.Cross} />
                </IconButton>
              </Header>
              <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
                <Text priority="400">{t('profiles.deleteWarn', { name: deleteTarget?.name ?? '' })}</Text>
                <Box gap="200" justifyContent="End">
                  <Button
                    variant="Critical"
                    aria-disabled={deleting}
                    onClick={() => removeProfile()}
                  >
                    <Text as="span" size="B400">
                      {t('action.delete')}
                    </Text>
                  </Button>
                  <Button fill="Soft" onClick={() => setDeleteTarget(null)}>
                    <Text as="span" size="B400">
                      {t('action.cancel')}
                    </Text>
                  </Button>
                </Box>
              </Box>
            </Dialog>
          </FocusTrap>
        </OverlayCenter>
      </Overlay>
    </Page>
  );
}
