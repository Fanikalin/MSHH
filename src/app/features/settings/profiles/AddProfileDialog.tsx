import React, { FormEventHandler, useState } from 'react';
import { Avatar, Box, Button, Input, Spinner, Text, color, config, toRem } from 'folds';
import { useAtomValue } from 'jotai';
import { useMxOptional } from '../../../hooks/useMatrixClient';
import { Modal500 } from '../../../components/Modal500';
import { ContainerColor } from '../../../styles/ContainerColor.css';
import * as api from '../../../../mshh/api';
import { modulesAtom, mshhErrorMessage, refreshProfiles } from '../../../../mshh/state';
import { MATRIX_MODULE_ID, type ModuleInfo } from '../../../../mshh/types';
import {
  ProfileFieldsForm,
  fieldValuesToConfig,
  findMissingRequired,
  initialFieldValues,
  type ProfileFieldValues,
} from './ProfileFieldsForm';

function ModuleCard({
  module,
  onSelect,
  disabled,
  caption,
}: {
  module: ModuleInfo;
  onSelect?: () => void;
  disabled?: boolean;
  caption?: string;
}) {
  return (
    <Box
      as="button"
      type="button"
      onClick={disabled ? undefined : onSelect}
      aria-disabled={disabled}
      direction="Column"
      gap="200"
      alignItems="Center"
      className={ContainerColor({ variant: 'SurfaceVariant' })}
      style={{
        width: toRem(170),
        padding: config.space.S300,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        borderRadius: config.radii.R300,
      }}
    >
      <Avatar size="300" radii="300">
        {module.icon ? (
          <img src={module.icon} alt={module.name} style={{ width: '100%', height: '100%' }} />
        ) : (
          <Text size="H5">{module.name.slice(0, 1).toUpperCase()}</Text>
        )}
      </Avatar>
      <Text size="H6" align="Center" truncate>
        {module.name}
      </Text>
      <Text size="T200" priority="300" align="Center" style={{ minHeight: toRem(32) }}>
        {caption ?? module.description}
      </Text>
    </Box>
  );
}

type AddProfileDialogProps = {
  requestClose: () => void;
  onMatrixLogin?: () => void;
};

export function AddProfileDialog({ requestClose, onMatrixLogin }: AddProfileDialogProps) {
  const mx = useMxOptional();
  const modules = useAtomValue(modulesAtom);
  const selectableModules = modules.filter((m) => m.side === 'main');
  const matrixModule = modules.find((m) => m.id === MATRIX_MODULE_ID);

  const [module, setModule] = useState<ModuleInfo>();
  const [name, setName] = useState('');
  const [values, setValues] = useState<ProfileFieldValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const fields = module?.profileFields ?? [];

  const handlePickModule = (picked: ModuleInfo) => {
    setModule(picked);
    setValues(initialFieldValues(picked.profileFields ?? []));
    setError(undefined);
  };

  const handleSubmit: FormEventHandler = async (evt) => {
    evt.preventDefault();
    if (!module || busy) return;
    const missing = findMissingRequired(fields, values);
    if (name.trim().length === 0) {
      setError('Укажите имя профиля');
      return;
    }
    if (missing) {
      setError(`Заполните «${missing.label}»`);
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api.saveProfile({
        moduleId: module.id,
        name: name.trim(),
        config: fieldValuesToConfig(fields, values),
      });
      for (const field of fields) {
        const v = values[field.key];
        if (field.type === 'secret' && typeof v === 'string' && v.length > 0) {
          await api.setProfileSecret(id, field.key, v);
        }
      }
      await api.connectProfile(id);
      await refreshProfiles(mx?.getUserId() ?? undefined);
      requestClose();
    } catch (e) {
      setError(mshhErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal500 requestClose={requestClose}>
      {!module ? (
        <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
          <Text size="H4">Добавить профиль</Text>
          <Text size="T300" priority="300">
            Выберите протокол для нового профиля.
          </Text>
          <Box gap="200" wrap="Wrap">
            {selectableModules.map((m) => (
              <ModuleCard key={m.id} module={m} onSelect={() => handlePickModule(m)} />
            ))}
            {matrixModule && (
              <ModuleCard
                module={matrixModule}
                disabled={!onMatrixLogin}
                caption={onMatrixLogin ? 'вход через Matrix' : 'используйте вход Matrix'}
                onSelect={onMatrixLogin}
              />
            )}
          </Box>
          {selectableModules.length === 0 && (
            <Text size="T300" priority="300">
              Дополнительные модули не установлены.
            </Text>
          )}
        </Box>
      ) : (
        <form onSubmit={handleSubmit}>
          <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
            <Text size="H4">Новый профиль — {module.name}</Text>
            <Box direction="Column" gap="100">
              <Text as="label" htmlFor="mshh-add-profile-name" size="T300">
                Название профиля *
              </Text>
              <Input
                id="mshh-add-profile-name"
                variant="SurfaceVariant"
                size="400"
                radii="300"
                placeholder="Например: Личный аккаунт"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                autoComplete="off"
                required
              />
            </Box>
            {fields.length > 0 && (
              <ProfileFieldsForm
                idPrefix="mshh-add-profile"
                fields={fields}
                values={values}
                onChange={setValues}
              />
            )}
            {error && (
              <Text size="T300" style={{ color: color.Critical.Main }}>
                {error}
              </Text>
            )}
            <Box gap="200" justifyContent="End">
              <Button
                type="button"
                variant="Secondary"
                fill="Soft"
                size="300"
                radii="300"
                onClick={() => {
                  setModule(undefined);
                  setError(undefined);
                }}
                disabled={busy}
              >
                <Text size="B300">Назад</Text>
              </Button>
              <Button type="submit" variant="Primary" size="300" radii="300" disabled={busy}>
                <Text size="B300">{busy ? 'Подключение…' : 'Создать'}</Text>
                {busy && <Spinner size="100" variant="Secondary" />}
              </Button>
            </Box>
          </Box>
        </form>
      )}
    </Modal500>
  );
}
