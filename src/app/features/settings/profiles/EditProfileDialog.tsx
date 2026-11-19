import React, { FormEventHandler, useState } from 'react';
import { Box, Button, Input, Spinner, Text, color, config } from 'folds';
import { useMxOptional } from '../../../hooks/useMatrixClient';
import { Modal500 } from '../../../components/Modal500';
import * as api from '../../../../mshh/api';
import { mshhErrorMessage, refreshProfiles } from '../../../../mshh/state';
import type { ModuleInfo, ProfileMeta } from '../../../../mshh/types';
import {
  ProfileFieldsForm,
  fieldValuesToConfig,
  findMissingRequired,
  initialFieldValues,
  type ProfileFieldValues,
} from './ProfileFieldsForm';

const prefillValues = (module: ModuleInfo | undefined, profile: ProfileMeta): ProfileFieldValues => {
  const values = initialFieldValues(module?.profileFields ?? []);
  for (const field of module?.profileFields ?? []) {
    const v = profile.config[field.key];
    if (v !== undefined && v !== null && field.type !== 'secret') {
      values[field.key] = v as string | number | boolean;
    }
  }
  return values;
};

type EditProfileDialogProps = {
  profile: ProfileMeta;
  module?: ModuleInfo;
  requestClose: () => void;
};

export function EditProfileDialog({ profile, module, requestClose }: EditProfileDialogProps) {
  const mx = useMxOptional();
  const fields = module?.profileFields ?? [];
  const [name, setName] = useState(profile.name);
  const [values, setValues] = useState<ProfileFieldValues>(() => prefillValues(module, profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit: FormEventHandler = async (evt) => {
    evt.preventDefault();
    if (busy) return;
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
      await api.saveProfile({
        id: profile.id,
        moduleId: profile.moduleId,
        name: name.trim(),
        config: fieldValuesToConfig(fields, values),
      });
      // Secrets are blank in the form; only filled ones get updated.
      for (const field of fields) {
        const v = values[field.key];
        if (field.type === 'secret' && typeof v === 'string' && v.length > 0) {
          await api.setProfileSecret(profile.id, field.key, v);
        }
      }
      // Reconnect so the host restarts the client with fresh config.
      await api.disconnectProfile(profile.id).catch(() => undefined);
      await api.connectProfile(profile.id);
      await refreshProfiles(mx?.getUserId() ?? undefined);
      requestClose();
    } catch (e) {
      setError(mshhErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal500 requestClose={requestClose}>
      <form onSubmit={handleSubmit}>
        <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
          <Text size="H4">Редактирование — {profile.name}</Text>
          <Box direction="Column" gap="100">
            <Text as="label" htmlFor="mshh-edit-profile-name" size="T300">
              Название профиля *
            </Text>
            <Input
              id="mshh-edit-profile-name"
              variant="SurfaceVariant"
              size="400"
              radii="300"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              autoComplete="off"
              required
            />
          </Box>
          {fields.length > 0 && (
            <ProfileFieldsForm
              idPrefix="mshh-edit-profile"
              fields={fields}
              values={values}
              onChange={setValues}
            />
          )}
          {fields.some((f) => f.type === 'secret') && (
            <Text size="T200" priority="300">
              Пустые секретные поля останутся без изменений.
            </Text>
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
              onClick={requestClose}
              disabled={busy}
            >
              <Text size="B300">Отмена</Text>
            </Button>
            <Button type="submit" variant="Primary" size="300" radii="300" disabled={busy}>
              <Text size="B300">{busy ? 'Сохранение…' : 'Сохранить'}</Text>
              {busy && <Spinner size="100" variant="Secondary" />}
            </Button>
          </Box>
        </Box>
      </form>
    </Modal500>
  );
}
