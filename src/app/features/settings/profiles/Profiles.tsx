import React, { useEffect, useState } from 'react';
import { Avatar, Box, Button, Chip, Icon, IconButton, Icons, Scroll, Switch, Text, color, toRem } from 'folds';
import { useAtomValue } from 'jotai';
import { useMatrixClient } from '../../../hooks/useMatrixClient';
import { Page, PageContent, PageHeader } from '../../../components/page';
import { SequenceCard } from '../../../components/sequence-card';
import { SettingTile } from '../../../components/setting-tile';
import { SequenceCardStyle } from '../styles.css';
import { MshhStoreProvider } from '../../../../mshh/MshhStoreProvider';
import * as api from '../../../../mshh/api';
import {
  authPromptsAtom,
  loadProfileChats,
  modulesAtom,
  mshhErrorMessage,
  profilesAtom,
  profileStatusAtom,
  pushToast,
  refreshModules,
  refreshProfiles,
} from '../../../../mshh/state';
import { isMatrixProfileId, type ProfileMeta, type ProfileStatus } from '../../../../mshh/types';
import { AddProfileDialog } from './AddProfileDialog';
import { AuthPromptDialog } from './AuthPromptDialog';
import { DeleteProfileDialog } from './DeleteProfileDialog';
import { EditProfileDialog } from './EditProfileDialog';

const STATUS_LABELS: Record<ProfileStatus, string> = {
  online: 'В сети',
  connecting: 'Подключение…',
  offline: 'Отключён',
  'auth-pending': 'Требуется вход',
};

const statusColor = (status?: ProfileStatus): string => {
  if (status === 'online') return color.Success.Main;
  if (status === 'connecting' || status === 'auth-pending') return color.Warning.Main;
  return color.Critical.Main;
};

function StatusDot({ status }: { status?: ProfileStatus }) {
  return (
    <Box
      shrink="No"
      style={{
        width: toRem(10),
        height: toRem(10),
        borderRadius: '999px',
        backgroundColor: statusColor(status),
      }}
    />
  );
}

function ProfileAvatar({ moduleName }: { moduleName: string }) {
  return (
    <Avatar size="400" radii="400">
      <Text size="H6">{moduleName.slice(0, 1).toUpperCase()}</Text>
    </Avatar>
  );
}

function ProfilesContent({ requestClose }: { requestClose: () => void }) {
  const mx = useMatrixClient();
  const userId = mx.getUserId() ?? undefined;
  const modules = useAtomValue(modulesAtom);
  const profiles = useAtomValue(profilesAtom);
  const statuses = useAtomValue(profileStatusAtom);
  const authPrompts = useAtomValue(authPromptsAtom);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProfileMeta>();
  const [deleting, setDeleting] = useState<ProfileMeta>();
  const [dismissedAuthIds, setDismissedAuthIds] = useState<string[]>([]);

  useEffect(() => {
    void refreshModules();
    void refreshProfiles(userId);
  }, [userId]);

  const moduleById = (moduleId: string) => modules.find((m) => m.id === moduleId);
  const authEntry = Object.entries(authPrompts).find(([id]) => !dismissedAuthIds.includes(id));

  const handleToggle = async (profile: ProfileMeta) => {
    try {
      await api.setEnabled(profile.id, !profile.enabled);
      await refreshProfiles(userId);
      if (!profile.enabled) await loadProfileChats(profile.id);
    } catch (e) {
      pushToast(`Ошибка: ${mshhErrorMessage(e)}`);
    }
  };

  return (
    <Page>
      <PageHeader outlined={false}>
        <Box grow="Yes" gap="200">
          <Box grow="Yes" alignItems="Center" gap="200">
            <Text size="H3" truncate>
              Профили
            </Text>
          </Box>
          <Box shrink="No">
            <IconButton onClick={requestClose} variant="Surface">
              <Icon src={Icons.Cross} />
            </IconButton>
          </Box>
        </Box>
      </PageHeader>
      <Box grow="Yes">
        <Scroll hideTrack visibility="Hover">
          <PageContent>
            <Box direction="Column" gap="500">
              <Box justifyContent="SpaceBetween" alignItems="Center" gap="200">
                <Text size="H5">Аккаунты и протоколы</Text>
                <Button
                  variant="Primary"
                  size="300"
                  radii="300"
                  before={<Icon size="100" src={Icons.Plus} />}
                  onClick={() => setAdding(true)}
                >
                  <Text size="B300">Добавить профиль</Text>
                </Button>
              </Box>

              {profiles.length === 0 && (
                <Text size="T300" priority="300">
                  Профилей пока нет. Добавьте профиль или войдите через Matrix.
                </Text>
              )}

              <Box direction="Column" gap="100">
                {profiles.map((profile, index) => {
                  const module = moduleById(profile.moduleId);
                  const isMatrix = isMatrixProfileId(profile.id);
                  const status = statuses[profile.id];
                  return (
                    <SequenceCard
                      key={profile.id}
                      className={SequenceCardStyle}
                      variant="SurfaceVariant"
                      direction="Column"
                      data-first-child={index === 0}
                      data-last-child={index === profiles.length - 1}
                    >
                      <SettingTile
                        before={<ProfileAvatar moduleName={module?.name ?? profile.moduleId} />}
                        title={
                          <Box alignItems="Center" gap="200">
                            <Text size="T300" truncate>
                              {profile.name}
                            </Text>
                            <Chip as="span" variant="Secondary" size="400" fill="Soft" radii="Pill">
                              <Text as="span" size="L400" truncate>
                                {module?.name ?? profile.moduleId}
                              </Text>
                            </Chip>
                            {profile.enabled === false && (
                              <Text size="T200" priority="300">
                                (отключён)
                              </Text>
                            )}
                          </Box>
                        }
                        description={
                          <Box alignItems="Center" gap="100">
                            <StatusDot status={status} />
                            <Text size="T200" priority="300">
                              {STATUS_LABELS[status ?? 'offline']}
                              {isMatrix ? ' • используйте вход Matrix' : ''}
                            </Text>
                          </Box>
                        }
                        after={
                          <Box gap="200" shrink="No" alignItems="Center">
                            {status === 'auth-pending' && !isMatrix && (
                              <Button
                                variant="Primary"
                                fill="Soft"
                                size="300"
                                radii="300"
                                onClick={() =>
                                  setDismissedAuthIds((ids) => ids.filter((id) => id !== profile.id))
                                }
                              >
                                <Text size="B300">Продолжить вход</Text>
                              </Button>
                            )}
                            {!isMatrix && (
                              <>
                                <Switch
                                  variant="Primary"
                                  value={profile.enabled}
                                  onChange={() => handleToggle(profile)}
                                />
                                <Button
                                  variant="Secondary"
                                  fill="Soft"
                                  size="300"
                                  radii="300"
                                  before={<Icon size="100" src={Icons.Pencil} />}
                                  onClick={() => setEditing(profile)}
                                >
                                  <Text size="B300">Редактировать</Text>
                                </Button>
                                <Button
                                  variant="Critical"
                                  fill="None"
                                  size="300"
                                  radii="300"
                                  before={<Icon size="100" src={Icons.Delete} />}
                                  onClick={() => setDeleting(profile)}
                                >
                                  <Text size="B300">Удалить</Text>
                                </Button>
                              </>
                            )}
                          </Box>
                        }
                      />
                    </SequenceCard>
                  );
                })}
              </Box>

              <Text size="T200" priority="300">
                Профили Matrix управляются входом в приложение и не редактируются здесь.
              </Text>
            </Box>
          </PageContent>
        </Scroll>
      </Box>

      {adding && <AddProfileDialog requestClose={() => setAdding(false)} />}
      {editing && (
        <EditProfileDialog
          profile={editing}
          module={moduleById(editing.moduleId)}
          requestClose={() => setEditing(undefined)}
        />
      )}
      {deleting && (
        <DeleteProfileDialog profile={deleting} requestClose={() => setDeleting(undefined)} />
      )}
      {authEntry && (
        <AuthPromptDialog
          profileId={authEntry[0]}
          profileName={profiles.find((p) => p.id === authEntry[0])?.name ?? authEntry[0]}
          prompt={authEntry[1]}
          requestClose={() => setDismissedAuthIds((ids) => [...ids, authEntry[0]])}
        />
      )}
    </Page>
  );
}

type ProfilesProps = {
  requestClose: () => void;
};

export function Profiles({ requestClose }: ProfilesProps) {
  return (
    <MshhStoreProvider>
      <ProfilesContent requestClose={requestClose} />
    </MshhStoreProvider>
  );
}
