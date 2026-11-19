import React, { FormEventHandler, useState } from 'react';
import { Box, Button, Icon, Icons, Input, Spinner, Text, color, config } from 'folds';
import { Modal500 } from '../../../components/Modal500';
import * as api from '../../../../mshh/api';
import { mshhErrorMessage } from '../../../../mshh/state';
import type { AuthPrompt } from '../../../../mshh/types';

type AuthPromptDialogProps = {
  profileId: string;
  profileName: string;
  prompt: AuthPrompt;
  requestClose: () => void;
};

export function AuthPromptDialog({ profileId, profileName, prompt, requestClose }: AuthPromptDialogProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit: FormEventHandler = async (evt) => {
    evt.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // 'done' auth event closes the dialog; submitAuth errors stay inline.
      await api.submitAuth(profileId, code);
      setBusy(false);
    } catch (e) {
      setError(mshhErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal500 requestClose={requestClose}>
      <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
        <Box alignItems="Center" gap="200">
          <Icon size="300" src={prompt.type === 'error' ? Icons.Warning : Icons.ShieldLock} />
          <Text size="H4" truncate>
            Вход — {profileName}
          </Text>
        </Box>

        {prompt.type === 'qr' && (
          <Box direction="Column" gap="300" alignItems="Center">
            <img
              src={prompt.dataUrl}
              alt="QR-код"
              style={{ width: '256px', height: '256px', borderRadius: config.radii.R300 }}
            />
            <Text size="T300" align="Center">
              Отсканируйте в приложении
            </Text>
          </Box>
        )}

        {prompt.type === 'code' && (
          <form onSubmit={handleSubmit}>
            <Box direction="Column" gap="300">
              {prompt.hint && (
                <Text size="T300" priority="300">
                  {prompt.hint}
                </Text>
              )}
              <Input
                variant="SurfaceVariant"
                size="400"
                radii="300"
                placeholder="Код подтверждения"
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
                autoComplete="off"
                required
              />
              {error && (
                <Text size="T300" style={{ color: color.Critical.Main }}>
                  {error}
                </Text>
              )}
              <Box gap="200" justifyContent="End">
                <Button type="submit" variant="Primary" size="300" radii="300" disabled={busy}>
                  <Text size="B300">{busy ? 'Отправка…' : 'Подтвердить'}</Text>
                  {busy && <Spinner size="100" variant="Secondary" />}
                </Button>
              </Box>
            </Box>
          </form>
        )}

        {prompt.type === 'error' && (
          <Box direction="Column" gap="300">
            <Text size="T300" style={{ color: color.Critical.Main }}>
              {prompt.message}
            </Text>
            <Box justifyContent="End">
              <Button variant="Secondary" fill="Soft" size="300" radii="300" onClick={requestClose}>
                <Text size="B300">Закрыть</Text>
              </Button>
            </Box>
          </Box>
        )}

        {prompt.type !== 'error' && (
          <Box justifyContent="End">
            <Button variant="Secondary" fill="Soft" size="300" radii="300" onClick={requestClose}>
              <Text size="B300">Скрыть</Text>
            </Button>
          </Box>
        )}
      </Box>
    </Modal500>
  );
}
