import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import {
  Box,
  Button,
  Chip,
  Icon,
  IconButton,
  Icons,
  Input,
  Scroll,
  Spinner,
  Switch,
  Text,
  color,
  config,
} from 'folds';
import { Page, PageHeader } from '../../app/components/page';
import { NavItem } from '../../app/components/nav';
import { getMshhPath, getMshhProfilesPath } from '../../app/pages/pathUtils';
import { api } from '../api';
import { clearPrompt, establishedProfiles, moduleDefaultsAtom, profilesAtom, promptsAtom, modulesAtom } from '../state';
import { ModuleField, MshhEvent } from '../types';
import { StatusDot, profileStatusText } from '../components/StatusDot';
import { PromptDialog } from './PromptDialog';

type ConfigValue = string | number | boolean;
type ProfileConfig = Record<string, ConfigValue>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fieldLabel = (field: ModuleField): string => field.label ?? field.name;

type FieldRowProps = {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
};

function FieldRow({ label, required, help, children }: FieldRowProps) {
  return (
    <Box direction="Column" gap="100">
      <Text size="T300">
        {label}
        {required && <span style={{ color: color.Critical.Main }}> *</span>}
      </Text>
      {children}
      {help && (
        <Text size="T200" priority="300">
          {help}
        </Text>
      )}
    </Box>
  );
}

/** Инлайн-ввод ответа на промпт модуля (код подтверждения и т.п.) — без модалки. */
function InlinePromptInput({ prompt }: { prompt: MshhEvent & { type: 'prompt' } }) {
  const [value, setValue] = useState('');
  const [answered, setAnswered] = useState(false);
  const promptId = prompt.payload.promptId;
  useEffect(() => {
    setValue('');
    setAnswered(false);
  }, [promptId]);

  const submit = async () => {
    if (answered) return;
    const answer = value.trim();
    if (!answer) return;
    setAnswered(true);
    try {
      await api.respondPrompt(prompt.profileId, promptId, answer);
    } catch {
      setAnswered(false);
      return;
    }
    clearPrompt(prompt.profileId, promptId);
  };

  return (
    <FieldRow
      label={prompt.payload.title || 'Код подтверждения'}
      required
      help={prompt.payload.detail}
    >
      <Box gap="100">
        <Input
          value={value}
          onChange={(evt) => setValue(evt.currentTarget.value)}
          onKeyDown={(evt) => {
            if (evt.key === 'Enter') void submit();
          }}
          style={{ flex: '1 1 auto' }}
        />
        <Button size="300" fill="Soft" onClick={() => void submit()}>
          <Text as="span" size="B300">
            Подтвердить
          </Text>
        </Button>
      </Box>
    </FieldRow>
  );
}

/** Add-profile flow (module → schema form → connect) and edit mode via route param. */
export function MshhProfileForm() {
  const { profileId } = useParams<{ profileId?: string }>();
  const navigate = useNavigate();
  const modules = useAtomValue(modulesAtom);
  const profiles = useAtomValue(profilesAtom);
  const editing = useMemo(
    () => profiles.find((profile) => profile.id === profileId),
    [profiles, profileId]
  );

  const [moduleId, setModuleId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [formConfig, setFormConfig] = useState<ProfileConfig>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const manifest = useMemo(() => modules.find((m) => m.id === moduleId), [modules, moduleId]);
  const moduleDefaults = useAtomValue(moduleDefaultsAtom);
  const profilePrompts = useAtomValue(promptsAtom);
  const defaultsFor = useMemo(
    () => (moduleId ? moduleDefaults[moduleId] : undefined),
    [moduleDefaults, moduleId]
  );

  // Prefill once in edit mode, when the profile shows up in state.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current || !editing) return;
    prefilledRef.current = true;
    setModuleId(editing.moduleId);
    setName(editing.name);
    setFormConfig({ ...editing.config });
  }, [editing]);

  const setFieldValue = (fieldName: string, value: ConfigValue) =>
    setFormConfig((prev) => ({ ...prev, [fieldName]: value }));

  /** Назад в форме добавления: к меню выбора модуля (без авторизации профиль
   *  не создаёт поверхность чатов). Отменяет висящий QR/код-промпт. */
  const goBack = async () => {
    if (editing) {
      navigate(getMshhProfilesPath());
      return;
    }
    const ownerId = createdId ?? profileId;
    if (ownerId) {
      const pending = profilePrompts.get(ownerId);
      if (pending) {
        try {
          await api.respondPrompt(ownerId, pending.payload.promptId, '');
        } catch {
          /* prompt уже закрылся — не мешает выходу */
        }
        clearPrompt(ownerId);
      }
    }
    if (moduleId) {
      setModuleId(null);
      setName('');
      setFormConfig({});
      setError(null);
      return;
    }
    navigate(getMshhPath());
  };

  const buildConfig = (): ProfileConfig => {
    const result: ProfileConfig = {};
    (manifest?.fields ?? []).forEach((field) => {
      const raw = formConfig[field.name];
      if (field.type === 'number') {
        result[field.name] = raw === undefined || raw === '' ? '' : Number(raw);
      } else if (field.type === 'boolean') {
        result[field.name] = raw === true;
      } else {
        result[field.name] = raw === undefined || typeof raw === 'boolean' ? '' : String(raw);
      }
    });
    return result;
  };

  const firstMissingRequired = (): string | null => {
    const prepared = buildConfig();
    let missing: string | null = null;
    (manifest?.fields ?? []).forEach((field) => {
      if (missing || !field.required) return;
      const value = prepared[field.name];
      if (field.type === 'boolean') {
        if (value !== true) missing = fieldLabel(field);
      } else if (value === '' || value === undefined) {
        missing = fieldLabel(field);
      }
    });
    return missing;
  };

  const connectOrCreate = async () => {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      if (createdId) {
        const nextConfig = buildConfig();
        const existing = profiles.find((p) => p.id === createdId);
        const changed = !existing || JSON.stringify(nextConfig) !== JSON.stringify(existing.config);
        if (changed) {
          await api.updateProfile(createdId, { name, config: nextConfig });
          await api.disconnectProfile(createdId);
          await api.connectProfile(createdId);
        } else if (existing?.status === 'error' || existing?.status === 'offline') {
          // повторное нажатие при неудачном подключении — просто переподключить
          await api.disconnectProfile(createdId);
          await api.connectProfile(createdId);
        }
      } else {
        // Возобновление: если профиль этого модуля уже застрял на авторизации
        // (error/connecting — прошлые попытки), продолжаем его, а не плодим дубликаты.
        const stuck = profiles.find(
          (p) =>
            p.moduleId === manifest.id &&
            !establishedProfiles([p]).length &&
            (p.status === 'error' || p.status === 'connecting')
        );
        if (stuck) {
          setCreatedId(stuck.id);
          const nextConfig = buildConfig();
          const changed = JSON.stringify(nextConfig) !== JSON.stringify(stuck.config);
          if (changed || name.trim()) {
            await api.updateProfile(stuck.id, {
              name: name.trim() || stuck.name,
              config: changed || Object.keys(nextConfig).length ? nextConfig : stuck.config,
            });
          }
          await api.disconnectProfile(stuck.id);
          await api.connectProfile(stuck.id);
          return;
        }
        const created = await api.createProfile(
          manifest.id,
          name.trim() || manifest.name,
          buildConfig(),
          true // усыновить QR-сессию превью, если пользователь уже отсканировал
        );
        setCreatedId(created.id); // auth prompts (code/QR) now surface via PromptDialog
        await api.connectProfile(created.id);
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!manifest) return;
    const missing = firstMissingRequired();
    if (missing) {
      setError(`Заполните обязательное поле: «${missing}»`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const nextConfig = buildConfig();
        const configChanged = JSON.stringify(nextConfig) !== JSON.stringify(editing.config);
        await api.updateProfile(editing.id, { name, config: nextConfig });
        if (configChanged) {
          // runner must pick up the new settings
          await api.disconnectProfile(editing.id);
          await api.connectProfile(editing.id);
        }
        navigate(getMshhProfilesPath());
      } else {
        // остаёмся на форме: QR/статус подключения видны рядом с телефоном
        await connectOrCreate();
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  // Профиль подключился (QR отсканирован / код введён) → в список чатов.
  const createdProfile = !editing && createdId ? profiles.find((p) => p.id === createdId) : undefined;
  useEffect(() => {
    if (createdProfile?.status === 'online') navigate(getMshhPath());
  }, [createdProfile?.status, createdProfile, navigate]);

  // Репо-режим (ключи не вшиты): оба APP-поля заполнены корректно → через 1с
  // после последнего ввода запускаем подключение, модуль выдаёт QR.
  // Повторные автопопытки — не чаще раза в 2с.
  const lastAutoConnectRef = useRef(0);
  const autoReady = useMemo(() => {
    if (editing || moduleId !== 'telegram' || defaultsFor) return false;
    const id = String(formConfig.apiId ?? '').trim();
    const hash = String(formConfig.apiHash ?? '').trim();
    return /^\d+$/.test(id) && Number(id) > 0 && /^[0-9a-f]{32}$/i.test(hash);
  }, [editing, moduleId, defaultsFor, formConfig]);

  useEffect(() => {
    if (!autoReady) return undefined;
    const timer = setTimeout(() => {
      if (Date.now() - lastAutoConnectRef.current < 2000) return;
      lastAutoConnectRef.current = Date.now();
      connectOrCreate();
    }, 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReady, formConfig]);

  // Промпты модуля (QR или код) для любых его профилей — инлайн в форме.
  const modulePrompts = useMemo(() => {
    if (!manifest) return [];
    const previewId = `preview_${manifest.id}`;
    return [...profilePrompts.values()].filter((ev) => {
      const prof = profiles.find((p) => p.id === ev.profileId);
      return prof?.moduleId === manifest.id || ev.profileId === previewId;
    });
  }, [profilePrompts, profiles, manifest]);
  const qrPromptEv = modulePrompts.find((ev) => ev.payload.kind === 'qr');
  const codePrompts = modulePrompts.filter(
    (ev) => ev.payload.kind === 'code' || ev.payload.kind === 'text'
  );
  const qrImage =
    qrPromptEv?.payload.kind === 'qr' && qrPromptEv.payload.qrBase64
      ? `data:image/png;base64,${qrPromptEv.payload.qrBase64}`
      : undefined;

  const retryConnect = async () => {
    const id = createdId ?? profileId;
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.connectProfile(id);
      if (editing) navigate(getMshhProfilesPath());
    } catch (connectError) {
      setError(errorMessage(connectError));
    } finally {
      setBusy(false);
    }
  };

  const renderField = (field: ModuleField) => {
    switch (field.type) {
      case 'boolean':
        return (
          <FieldRow key={field.name} label={fieldLabel(field)} help={field.help}>
            <Switch
              value={formConfig[field.name] === true}
              onChange={(on) => setFieldValue(field.name, on)}
            />
          </FieldRow>
        );
      case 'select':
        return (
          <FieldRow
            key={field.name}
            label={fieldLabel(field)}
            required={field.required}
            help={field.help}
          >
            <select
              value={formConfig[field.name] === undefined ? '' : String(formConfig[field.name])}
              onChange={(evt) => setFieldValue(field.name, evt.currentTarget.value)}
              style={{
                width: '100%',
                padding: config.space.S200,
                borderRadius: config.radii.R300,
                border: 'none',
                backgroundColor: color.SurfaceVariant.Container,
                color: 'inherit',
              }}
            >
              <option value="">—</option>
              {field.options?.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </FieldRow>
        );
      default: {
        let inputType = 'text';
        if (field.type === 'password') inputType = 'password';
        else if (field.type === 'number') inputType = 'number';
        return (
          <FieldRow
            key={field.name}
            label={fieldLabel(field)}
            required={field.required}
            help={field.help}
          >
            <Input
              type={inputType}
              value={formConfig[field.name] === undefined ? '' : String(formConfig[field.name])}
              onChange={(evt) => {
                const { value: rawValue } = evt.currentTarget;
                let value: ConfigValue = rawValue;
                if (field.type === 'number') {
                  value = evt.currentTarget.value === '' ? '' : Number(evt.currentTarget.value);
                }
                setFieldValue(field.name, value);
              }}
              placeholder={field.placeholder}
              required={field.required}
            />
          </FieldRow>
        );
      }
    }
  };

  const showForm = editing !== undefined || moduleId !== null;

  return (
    <Page>
      <PageHeader outlined balance>
        <Box shrink="No">
          <IconButton
            variant="Background"
            fill="None"
            onClick={() => goBack()}
            aria-label="Назад"
          >
            <Icon src={Icons.ArrowGoLeft} />
          </IconButton>
        </Box>
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="H4" truncate>
            {editing ? 'Изменить профиль' : 'Добавить профиль'}
          </Text>
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
          <Box direction="Column" gap="400" style={{ padding: config.space.S400, maxWidth: 640 }}>
            {editing && (
              <Box alignItems="Center" gap="100">
                <StatusDot status={editing.status} />
                <Text size="T200" priority="300">
                  {profileStatusText(editing)}
                </Text>
              </Box>
            )}

            {!showForm ? (
              <>
                <Text size="T300" priority="400">
                  Выберите мессенджер:
                </Text>
                <Box wrap="Wrap" gap="200">
                  {modules.length === 0 && (
                    <Text size="T300" priority="300">
                      Модули не найдены.
                    </Text>
                  )}
                  {modules.map((module) => (
                    <NavItem
                      key={module.id}
                      as="button"
                      variant="Surface"
                      radii="400"
                      onClick={() => {
                        setModuleId(module.id);
                        setName(module.name);
                        // персональная сборка: вшитые значения — предзаполнение
                        setFormConfig({ ...(moduleDefaults[module.id] ?? {}) });
                        // QR-превью: сессия авторизации стартует сразу при выборе
                        void api.formPreviewStart(module.id, moduleDefaults[module.id] ?? {});
                      }}
                    >
                      <Box direction="Column" gap="100" style={{ padding: config.space.S300 }}>
                        <Text size="T300">{module.name}</Text>
                        <Box alignItems="Center" gap="100">
                          <Chip as="span" size="400" variant="Secondary" fill="Soft" radii="Pill">
                            <Text as="span" size="L400">
                              {module.id}
                            </Text>
                          </Chip>
                          {module.version && (
                            <Text size="T200" priority="300">
                              v{module.version}
                            </Text>
                          )}
                        </Box>
                        <Text size="T200" priority="300">
                          {module.runtime === 'renderer'
                            ? 'управляется интерфейсом'
                            : 'выполняется в приложении'}
                        </Text>
                      </Box>
                    </NavItem>
                  ))}
                </Box>
              </>
            ) : (
              <Box direction="Row" wrap="Wrap" gap="400" alignItems="Start">
                <Box direction="Column" gap="400" style={{ flex: '1 1 260px', minWidth: 240 }}>
                  <FieldRow
                    label="Название профиля"
                    required
                    help="Как профиль называется в списках чатов"
                  >
                    <Input value={name} onChange={(evt) => setName(evt.currentTarget.value)} />
                  </FieldRow>
                  {(manifest?.fields ?? [])
                    .filter((field) => !defaultsFor || !(field.name in defaultsFor))
                    .map(renderField)}
                  {codePrompts.map((ev) => (
                    <InlinePromptInput key={ev.payload.promptId} prompt={ev} />
                  ))}
                  {error && (
                    <Box direction="Column" gap="100">
                      <Text size="T200" style={{ color: color.Critical.Main }}>
                        {error}
                      </Text>
                      {(createdId ?? editing) && !busy && (
                        <Button size="300" fill="Soft" onClick={() => retryConnect()}>
                          <Text as="span" size="B300">
                            Повторить подключение
                          </Text>
                        </Button>
                      )}
                    </Box>
                  )}
                  {busy && (
                    <Box alignItems="Center" gap="200">
                      <Spinner size="200" variant="Secondary" fill="Soft" />
                      <Text size="T200" priority="300">
                        Подключение…
                      </Text>
                    </Box>
                  )}
                  <Box>
                    <Button
                      variant="Primary"
                      aria-disabled={busy}
                      onClick={() => submit()}
                      before={busy ? <Spinner size="200" variant="Primary" fill="Soft" /> : undefined}
                    >
                      <Text as="span" size="B400">
                        {editing ? 'Сохранить' : 'Создать и подключить'}
                      </Text>
                    </Button>
                  </Box>
                </Box>
                {(createdId || qrPromptEv || qrImage) && (
                  <Box
                    direction="Column"
                    alignItems="Center"
                    justifyContent="Center"
                    gap="100"
                    style={{ flex: '0 0 230px' }}
                  >
                    {qrImage ? (
                      <>
                        <img
                          src={qrImage}
                          alt="QR для входа в Telegram"
                          width={200}
                          height={200}
                          style={{ borderRadius: config.radii.R300 }}
                        />
                        <Text size="T200" priority="300" align="Center">
                          Отсканируйте в Telegram: Настройки → Устройства → Связать устройство
                        </Text>
                      </>
                    ) : (
                      <>
                        <Spinner size="300" variant="Secondary" fill="Soft" />
                        <Text size="T200" priority="300" align="Center">
                          Готовим QR…
                        </Text>
                      </>
                    )}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Scroll>
      </Box>
      {(moduleId || editing) && <PromptDialog profileId={createdId ?? profileId} />}
    </Page>
  );
}
