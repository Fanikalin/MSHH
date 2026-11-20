import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { api, mediaUrl } from '../api';
import { modulesAtom, profilesAtom } from '../state';
import { ModuleManifest, Profile } from '../types';
import { MshhAvatar } from '../components/MshhAvatar';
import { ModuleChip } from '../components/ModuleChip';
import colorMXID from '../../util/colorMXID';
import { langAtom, MshhLang, setMshhLang, useMshhT } from '../i18n';
import {
  MSHH_ACCENTS,
  MSHH_FONTS,
  accentAtom,
  fontAtom,
  setMshhAccent,
  setMshhFont,
} from '../prefs';

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
type MshhSettingsTabKey = 'tab.general' | 'tab.modules' | 'tab.profiles';

const TABS: { id: Tab; labelKey: MshhSettingsTabKey }[] = [
  { id: 'general', labelKey: 'tab.general' },
  { id: 'modules', labelKey: 'tab.modules' },
  { id: 'profiles', labelKey: 'tab.profiles' },
];

/** ?tab=… query param keeps deep links (Модули → «Назад» в форме профиля). */
const tabFromSearch = (tab: string | null): Tab =>
  TABS.some(({ id }) => id === tab) ? (tab as Tab) : 'general';


function GeneralTab({
  zoom,
  onZoomChange,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  const t = useMshhT();
  const fontId = useAtomValue(fontAtom);
  const accentId = useAtomValue(accentAtom);
  const langId = useAtomValue(langAtom);

  return (
    <>
      <SettingTile
        title={t('general.zoom')}
        description={t('general.zoomDesc')}
        after={
          <Button
            size="300"
            variant="Secondary"
            fill="Soft"
            aria-disabled={zoom === 1}
            onClick={() => onZoomChange(1)}
          >
            <Text as="span" size="B300">
              {t('general.reset')}
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
            style={{ width: '100%', accentColor: 'var(--mshh-accent)' }}
            aria-label={t('general.zoom')}
          />
          <Box shrink="No">
            <Text size="B300" style={{ minWidth: toRem(48) }} align="Center">
              {Math.round(zoom * 100)}%
            </Text>
          </Box>
        </Box>
      </SettingTile>
      <SettingTile title={t('general.font')} description={t('general.fontDesc')}>
        <Box gap="200" wrap="Wrap" style={{ paddingTop: config.space.S200 }}>
          {MSHH_FONTS.map((font) => (
            <Button
              key={font.id}
              size="300"
              variant="Secondary"
              fill="Soft"
              aria-selected={fontId === font.id}
              style={{
                fontFamily: font.stack,
                ...(fontId === font.id
                  ? { color: 'var(--mshh-accent)', borderColor: 'var(--mshh-accent)' }
                  : {}),
              }}
              onClick={() => setMshhFont(font.id)}
            >
              <Text as="span" size="B300">
                {t(font.labelKey)}
              </Text>
            </Button>
          ))}
        </Box>
      </SettingTile>
      <SettingTile title={t('general.accent')} description={t('general.accentDesc')}>
        <Box gap="200" wrap="Wrap" style={{ paddingTop: config.space.S200 }}>
          {MSHH_ACCENTS.map((accent) => (
            <Button
              key={accent.id}
              size="300"
              variant="Secondary"
              fill="Soft"
              aria-selected={accentId === accent.id}
              style={
                accentId === accent.id
                  ? { color: 'var(--mshh-accent)', borderColor: 'var(--mshh-accent)' }
                  : {}
              }
              before={
                <Box
                  shrink="No"
                  style={{
                    width: toRem(14),
                    height: toRem(14),
                    borderRadius: config.radii.Pill,
                    backgroundColor: accent.accent,
                    outline:
                      accentId === accent.id
                        ? '2px solid var(--mshh-accent)'
                        : '1px solid var(--mshh-accent-soft)',
                    outlineOffset: '2px',
                  }}
                />
              }
              onClick={() => setMshhAccent(accent.id)}
            >
              <Text as="span" size="B300">
                {t(accent.labelKey)}
              </Text>
            </Button>
          ))}
        </Box>
      </SettingTile>
      <SettingTile title={t('general.language')} description={t('general.languageDesc')}>
        <Box gap="200" wrap="Wrap" style={{ paddingTop: config.space.S200 }}>
          {(['ru', 'en'] as MshhLang[]).map((lang) => (
            <Button
              key={lang}
              size="300"
              variant={langId === lang ? 'Primary' : 'Secondary'}
              fill="Soft"
              aria-selected={langId === lang}
              onClick={() => setMshhLang(lang)}
            >
              <Text as="span" size="B300">
                {lang === 'ru' ? 'Русский' : 'English'}
              </Text>
            </Button>
          ))}
        </Box>
      </SettingTile>
    </>
  );
}

/** Show-only summary of a profile connection fields (phone/api/proxy/...). */
function connectionSummary(profile: Profile, moduleById: Map<string, ModuleManifest>): string {
  const fields = moduleById.get(profile.moduleId)?.fields ?? [];
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
  const t = useMshhT();

  if (profiles.length === 0) {
    return (
      <Text size="T300" priority="300" align="Center">
        {t('profiles.empty')}
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
              {connectionSummary(profile, moduleById) || t('module.noFields')}
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
                {t('action.edit')}
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
  const t = useMshhT();
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
        placeholder={t('profile.namePlaceholder')}
        variant="SurfaceVariant"
        size="400"
        before={<Icon size="100" src={Icons.User} />}
      />
      <TextArea
        value={description}
        onChange={(evt) => setDescription(evt.currentTarget.value)}
        placeholder={t('profile.descriptionPlaceholder')}
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
            {t('action.save')}
          </Text>
        </Button>
      </Box>
    </Box>
  );
}

const AVATAR_SIZE_PX = 200;

/** Большая аватарка профиля: клик = замена файла, hover затемняет и показывает карандаш. */
function EditableAvatar({
  profile,
  busy,
  onPick,
}: {
  profile: Profile;
  busy: boolean;
  onPick: () => void;
}) {
  const t = useMshhT();
  const [hover, setHover] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const src = profile.meta?.avatarPath;

  // новый файл аватарки — снова попробовать <img>
  useEffect(() => {
    setImgFailed(false);
  }, [src]);

  return (
    <Box
      as="button"
      shrink="No"
      alignItems="Center"
      justifyContent="Center"
      style={{
        position: 'relative',
        width: toRem(AVATAR_SIZE_PX),
        height: toRem(AVATAR_SIZE_PX),
        borderRadius: config.radii.Pill,
        overflow: 'hidden',
        padding: 0,
        border: 'none',
        cursor: busy ? 'default' : 'pointer',
        backgroundColor: colorMXID(profile.id),
      }}
      disabled={busy}
      aria-label={t('profiles.changeAvatar')}
      title={t('profiles.changeAvatar')}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {src && !imgFailed ? (
        <img
          src={mediaUrl(src)}
          alt={profile.name}
          onError={() => setImgFailed(true)}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Text size="H1" style={{ color: color.Surface.Container }}>
          {(profile.name || '?').trim().charAt(0).toUpperCase() || '?'}
        </Text>
      )}
      <Box
        alignItems="Center"
        justifyContent="Center"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.45)',
          opacity: hover && !busy ? 1 : 0,
          transition: 'opacity 120ms ease',
          color: 'var(--mshh-accent)',
          pointerEvents: 'none',
        }}
      >
        <Icon size="300" src={Icons.Pencil} />
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
  const t = useMshhT();

  if (profiles.length === 0) {
    return (
      <Text size="T300" priority="300" align="Center">
        {t('profiles.empty')}
      </Text>
    );
  }
  return (
    <Box direction="Column" gap="400">
      {profiles.map((profile) => (
        <Box
          key={profile.id}
          direction="Column"
          alignItems="Center"
          gap="300"
          style={{
            padding: config.space.S400,
            borderRadius: config.radii.R400,
            borderStyle: 'solid',
            borderWidth: config.borderWidth.B300,
            borderColor: color.Surface.ContainerLine,
          }}
        >
          <EditableAvatar
            profile={profile}
            busy={busyId === profile.id}
            onPick={() => onPickAvatar(profile)}
          />
          <Box alignItems="Center" gap="200" wrap="Wrap" justifyContent="Center">
            <Text size="H4">{profile.name}</Text>
            <ModuleChip name={profile.moduleName} />
          </Box>
          <Text size="T200" priority="300" align="Center">
            {profile.meta?.description || t('profiles.noDescription')}
          </Text>
          <Box direction="Column" style={{ width: '100%', maxWidth: toRem(480) }}>
            <ProfileMetaEditor profile={profile} saving={busyId === profile.id} onSave={onSaveMeta} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** App settings: interface (zoom/font/accent/language), module profiles, profile meta. */
export function MshhSettings() {
  const modules = useAtomValue(modulesAtom);
  const navigate = useNavigate();
  const t = useMshhT();
  const [search, setSearch] = useSearchParams();
  const tab = tabFromSearch(search.get('tab'));
  const [zoom, setZoom] = useState<number>(readSavedZoom);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectTab = useCallback(
    (next: Tab) => {
      setSearch(next === 'general' ? {} : { tab: next });
    },
    [setSearch]
  );

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
            aria-label={t('back.toChats')}
          >
            <Icon src={Icons.ArrowGoLeft} />
          </IconButton>
        </Box>
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="H4" truncate>
            {t('settings.title')}
          </Text>
        </Box>
        <Box shrink="No" gap="100">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => navigate(getMshhProfilesPath())}
            aria-label={t('nav.profiles')}
          >
            <Icon src={Icons.Setting} />
          </IconButton>
        </Box>
      </PageHeader>
      <Box shrink="No" direction="Column" gap="200" style={{ padding: config.space.S400 }}>
        <Box gap="200" wrap="Wrap">
          {TABS.map(({ id, labelKey }) => (
            <Button
              key={id}
              size="300"
              variant={tab === id ? 'Primary' : 'Secondary'}
              fill="Soft"
              aria-selected={tab === id}
              style={tab === id ? { boxShadow: '0 2px 0 0 var(--mshh-accent)' } : undefined}
              onClick={() => selectTab(id)}
            >
              <Text as="span" size="B300">
                {t(labelKey)}
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
