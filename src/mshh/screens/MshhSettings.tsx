import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import {
  Box,
  Button,
  Icon,
  IconButton,
  Icons,
  Input,
  Scroll,
  Text,
  TextArea,
  color,
  config,
  toRem,
} from 'folds';
import { Page, PageHeader } from '../../app/components/page';
import { SettingTile } from '../../app/components/setting-tile/SettingTile';
import {
  getMshhPath,
  getMshhProfileEditPath,
  getMshhProfilesPath,
} from '../../app/pages/pathUtils';
import { api } from '../api';
import { modulesAtom, profilesAtom } from '../state';
import { ModuleManifest, Profile } from '../types';
import { MshhAvatar } from '../components/MshhAvatar';
import { ModuleChip } from '../components/ModuleChip';

/** persisted UI zoom factor (see electron/main.cjs + src/mshh/boot.ts) */
const ZOOM_KEY = 'mshh_zoom';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

const readSavedZoom = (): number => {
  try {
    const zoom = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM ? zoom : 1;
  } catch {
    return 1;
  }
};

type Tab = 'general' | 'modules' | 'profiles';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'Общие' },
  { id: 'modules', label: 'Модули' },
  { id: 'profiles', label: 'Профили' },
];

function GeneralTab({
  zoom,
  onZoomChange,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  return (
    <SettingTile
      title="Масштаб интерфейса"
      description="Применяется ко всему приложению и сохраняется между запусками"
      after={
        <Button
          size="300"
          variant="Secondary"
          fill="Soft"
          aria-disabled={zoom === 1}
          onClick={() => onZoomChange(1)}
        >
          <Text as="span" size="B300">
            Сбросить
          </Text>
        </Button>
      }
    >
      <Box
        gap="300"
        alignItems="Center"
        style={{ paddingTop: config.space.S200, maxWidth: toRem(480) }}
      >
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          onChange={(evt) => onZoomChange(Number(evt.currentTarget.value))}
          style={{ width: '100%' }}
          aria-label="Масштаб интерфейса"
        />
        <Box shrink="No">
          <Text size="B300" style={{ minWidth: toRem(48) }} align="Center">
            {Math.round(zoom * 100)}%
          </Text>
        </Box>
      </Box>
    </SettingTile>
  );
}

/** Show-only summary of a profile connection fields (phone/api/proxy/...). */
function connectionSummary(profile: Profile, moduleById: Map<string, ModuleManifest>): string {
  const fields = moduleById.get(profile.moduleId)?.fields ?? [];
  if (fields.length === 0) return 'У модуля нет полей связи';
  return fields
    .map((field) => {
      const value = profile.config?.[field.name];
      let shown: string;
      if (field.type === 'password') {
        shown = '••••••••';
      } else if (value === undefined || value === null || value === '') {
        shown = '—';
      } else {
        shown = String(value);
      }
      return `${field.label || field.name}: ${shown}`;
    })
    .join(' · ');
}

function ModulesTab({ moduleById }: { moduleById: Map<string, ModuleManifest> }) {
  const profiles = useAtomValue(profilesAtom);
  const navigate = useNavigate();

  if (profiles.length === 0) {
    return (
      <Text size="T300" priority="300" align="Center">
        Профилей пока нет
      </Text>
    );
  }
  return (
    <Box direction="Column" gap="400">
      {profiles.map((profile) => (
        <SettingTile
          key={profile.id}
          before={
            <MshhAvatar
              id={profile.id}
              name={profile.name}
              src={profile.meta?.avatarPath}
              size="400"
            />
          }
          title={
            <Box alignItems="Center" gap="200">
              <Text size="T300" truncate style={{ minWidth: 0 }}>
                {profile.name}
              </Text>
              <ModuleChip name={profile.moduleName} />
            </Box>
          }
          description={
            <Text size="T200" priority="300" truncate style={{ minWidth: 0 }}>
              {connectionSummary(profile, moduleById)}
            </Text>
          }
          after={
            <Button
              size="300"
              fill="Soft"
              before={<Icon size="100" src={Icons.Pencil} />}
              onClick={() => navigate(getMshhProfileEditPath(profile.id))}
            >
              <Text as="span" size="B300">
                Изменить
              </Text>
            </Button>
          }
        />
      ))}
    </Box>
  );
}

/** Inline name/description editor of one profile (saved via profiles.update). */
function ProfileMetaEditor({
  profile,
  saving,
  onSave,
}: {
  profile: Profile;
  saving: boolean;
  onSave: (profile: Profile, name: string | null, description: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.meta?.description ?? '');

  // re-sync when the profile row is refreshed from the core (after save/rename)
  useEffect(() => {
    setName(profile.name);
    setDescription(profile.meta?.description ?? '');
  }, [profile.name, profile.meta?.description]);

  const nextName = name.trim();
  const nameChanged = nextName !== '' && nextName !== profile.name;
  const descriptionChanged = description !== (profile.meta?.description ?? '');

  const save = () =>
    onSave(profile, nameChanged ? nextName : null, descriptionChanged ? description : null);

  return (
    <Box direction="Column" gap="200" style={{ paddingTop: config.space.S200 }}>
      <Input
        value={name}
        onChange={(evt) => setName(evt.currentTarget.value)}
        placeholder="Имя профиля"
        variant="SurfaceVariant"
        size="400"
        before={<Icon size="100" src={Icons.User} />}
      />
      <TextArea
        value={description}
        onChange={(evt) => setDescription(evt.currentTarget.value)}
        placeholder="Описание"
        variant="SurfaceVariant"
        size="400"
        resize="None"
        rows={2}
      />
      <Box>
        <Button
          size="300"
          variant="Primary"
          fill="Soft"
          disabled={saving || (!nameChanged && !descriptionChanged)}
          onClick={save}
        >
          <Text as="span" size="B300">
            Сохранить
          </Text>
        </Button>
      </Box>
    </Box>
  );
}

function ProfilesTab({
  busyId,
  onSaveMeta,
  onPickAvatar,
}: {
  busyId: string | null;
  onSaveMeta: (profile: Profile, name: string | null, description: string | null) => Promise<void>;
  onPickAvatar: (profile: Profile) => void;
}) {
  const profiles = useAtomValue(profilesAtom);

  if (profiles.length === 0) {
    return (
      <Text size="T300" priority="300" align="Center">
        Профилей пока нет
      </Text>
    );
  }
  return (
    <Box direction="Column" gap="400">
      {profiles.map((profile) => (
        <SettingTile
          key={profile.id}
          before={
            <MshhAvatar
              id={profile.id}
              name={profile.name}
              src={profile.meta?.avatarPath}
              size="400"
            />
          }
          title={
            <Box alignItems="Center" gap="200">
              <Text size="T300" truncate style={{ minWidth: 0 }}>
                {profile.name}
              </Text>
              <ModuleChip name={profile.moduleName} />
            </Box>
          }
          description={
            <Text size="T200" priority="300" style={{ minWidth: 0 }}>
              {profile.meta?.description || 'Описание не задано'}
            </Text>
          }
          after={
            <Button
              size="300"
              fill="Soft"
              aria-disabled={busyId === profile.id}
              before={<Icon size="100" src={Icons.Photo} />}
              onClick={() => onPickAvatar(profile)}
            >
              <Text as="span" size="B300">
                Выбрать файл
              </Text>
            </Button>
          }
        >
          <ProfileMetaEditor profile={profile} saving={busyId === profile.id} onSave={onSaveMeta} />
        </SettingTile>
      ))}
    </Box>
  );
}

/** App settings: interface zoom, module connection fields, profile meta. */
export function MshhSettings() {
  const modules = useAtomValue(modulesAtom);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('general');
  const [zoom, setZoom] = useState<number>(readSavedZoom);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const moduleById = useMemo(
    () => new Map(modules.map((module_) => [module_.id, module_])),
    [modules]
  );

  const changeZoom = useCallback((next: number) => {
    setZoom(next);
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      /* ignore */
    }
    api.setZoom(next).catch(() => {
      /* zoom is cosmetic — ignore IPC failures */
    });
  }, []);

  const saveMeta = useCallback(
    async (profile: Profile, name: string | null, description: string | null): Promise<void> => {
      setBusyId(profile.id);
      setActionError(null);
      try {
        if (name !== null) await api.updateProfile(profile.id, { name });
        if (description !== null) await api.updateProfile(profile.id, { meta: { description } });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyId(null);
      }
    },
    []
  );

  const pickAvatar = useCallback(async (profile: Profile) => {
    setBusyId(profile.id);
    setActionError(null);
    try {
      const [file] = await api.pickFiles();
      if (!file) return;
      await api.setProfileAvatar(profile.id, file);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <Page>
      <PageHeader outlined balance>
        <Box shrink="No">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => navigate(getMshhPath())}
            aria-label="Назад к чатам"
          >
            <Icon src={Icons.ArrowGoLeft} />
          </IconButton>
        </Box>
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="H4" truncate>
            Настройки
          </Text>
        </Box>
        <Box shrink="No" gap="100">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => navigate(getMshhProfilesPath())}
            aria-label="Менеджер профилей"
          >
            <Icon src={Icons.Setting} />
          </IconButton>
        </Box>
      </PageHeader>
      <Box shrink="No" direction="Column" gap="200" style={{ padding: config.space.S400 }}>
        <Box gap="200" wrap="Wrap">
          {TABS.map(({ id, label }) => (
            <Button
              key={id}
              size="300"
              variant={tab === id ? 'Primary' : 'Secondary'}
              fill="Soft"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              <Text as="span" size="B300">
                {label}
              </Text>
            </Button>
          ))}
        </Box>
        {actionError && (
          <Text size="T200" style={{ color: color.Critical.Main }}>
            {actionError}
          </Text>
        )}
      </Box>
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
            {tab === 'general' && <GeneralTab zoom={zoom} onZoomChange={changeZoom} />}
            {tab === 'modules' && <ModulesTab moduleById={moduleById} />}
            {tab === 'profiles' && (
              <ProfilesTab busyId={busyId} onSaveMeta={saveMeta} onPickAvatar={pickAvatar} />
            )}
          </Box>
        </Scroll>
      </Box>
    </Page>
  );
}
