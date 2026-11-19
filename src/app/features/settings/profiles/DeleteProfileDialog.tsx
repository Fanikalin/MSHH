import React, { useState } from 'react';
import { Box, Button, Spinner, Text, color, config } from 'folds';
import { useMatrixClient } from '../../../hooks/useMatrixClient';
import { Modal500 } from '../../../components/Modal500';
import * as api from '../../../../mshh/api';
import { mshhErrorMessage, refreshProfiles } from '../../../../mshh/state';
import type { ProfileMeta } from '../../../../mshh/types';

type DeleteProfileDialogProps = {
  profile: ProfileMeta;
  requestClose: () => void;
};

export function DeleteProfileDialog({ profile, requestClose }: DeleteProfileDialogProps) {
  const mx = useMatrixClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteProfile(profile.id);
      await refreshProfiles(mx.getUserId() ?? undefined);
      requestClose();
    } catch (e) {
      setError(mshhErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal500 requestClose={requestClose}>
      <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
        <Text size="H4">Удалить профиль</Text>
        <Text size="T300" priority="300">
          Профиль «{profile.name}» и его данные будут удалены. Это действие нельзя отменить.
        </Text>
        {error && (
          <Text size="T300" style={{ color: color.Critical.Main }}>
            {error}
          </Text>
        )}
        <Box gap="200" justifyContent="End">
          <Button
            variant="Secondary"
            fill="Soft"
            size="300"
            radii="300"
            onClick={requestClose}
            disabled={busy}
          >
            <Text size="B300">Отмена</Text>
          </Button>
          <Button variant="Critical" size="300" radii="300" onClick={handleDelete} disabled={busy}>
            <Text size="B300">{busy ? 'Удаление…' : 'Удалить'}</Text>
            {busy && <Spinner size="100" variant="Secondary" />}
          </Button>
        </Box>
      </Box>
    </Modal500>
  );
}
