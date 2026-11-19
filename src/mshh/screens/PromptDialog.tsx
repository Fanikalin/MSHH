import React, { useEffect, useRef, useState } from 'react';
import FocusTrap from 'focus-trap-react';
import { useAtomValue } from 'jotai';
import {
  Box,
  Button,
  Dialog,
  Header,
  Icon,
  IconButton,
  Icons,
  Input,
  Overlay,
  OverlayBackdrop,
  OverlayCenter,
  Text,
  config,
} from 'folds';
import { api } from '../api';
import { clearPrompt, promptsAtom } from '../state';
import { stopPropagation } from '../../app/utils/keyboard';

type PromptDialogProps = {
  /** Show only this profile's pending prompt; omitted → latest of any profile. */
  profileId?: string;
};

/**
 * Auth prompt asked by a module while connecting: confirmation code, free-form
 * text or a QR image. Cancelling answers the module with an empty value.
 */
export function PromptDialog({ profileId }: PromptDialogProps) {
  const prompts = useAtomValue(promptsAtom);
  const prompt = profileId ? prompts.get(profileId) : [...prompts.values()][0];
  const [value, setValue] = useState('');
  const answeredRef = useRef(false);

  const promptId = prompt?.payload.promptId;
  useEffect(() => {
    setValue('');
    answeredRef.current = false;
  }, [promptId]);

  if (!prompt) return null;
  const { payload } = prompt;

  const respond = async (answer: string) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    try {
      await api.respondPrompt(prompt.profileId, payload.promptId, answer);
    } catch {
      // keep the dialog around on transport errors so the user can retry
      answeredRef.current = false;
      return;
    }
    clearPrompt(prompt.profileId, payload.promptId);
  };

  return (
    <Overlay open backdrop={<OverlayBackdrop />}>
      <OverlayCenter>
        <FocusTrap
          focusTrapOptions={{
            initialFocus: false,
            onDeactivate: () => {
              if (!answeredRef.current) respond('');
            },
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
                <Text size="H4" truncate>
                  {payload.title ?? 'Подтверждение входа'}
                </Text>
              </Box>
              <IconButton size="300" onClick={() => respond('')} radii="300">
                <Icon src={Icons.Cross} />
              </IconButton>
            </Header>
            <Box direction="Column" gap="400" style={{ padding: config.space.S400 }}>
              {payload.detail && (
                <Text size="T300" priority="400">
                  {payload.detail}
                </Text>
              )}
              {payload.kind === 'qr' ? (
                <Box direction="Column" alignItems="Center" gap="300">
                  {payload.qrBase64 && (
                    <img
                      src={`data:image/png;base64,${payload.qrBase64}`}
                      width={240}
                      height={240}
                      alt="QR-код"
                      style={{ borderRadius: config.radii.R300 }}
                    />
                  )}
                  <Text size="T200" priority="300">
                    Отсканируйте в приложении
                  </Text>
                </Box>
              ) : (
                <Box direction="Column" gap="200">
                  <Input
                    value={value}
                    onChange={(evt) => setValue(evt.currentTarget.value)}
                    placeholder={payload.kind === 'code' ? 'Введите код' : 'Введите ответ'}
                    autoFocus
                  />
                  <Button
                    variant="Primary"
                    onClick={() => {
                      if (value.trim()) respond(value);
                    }}
                    aria-disabled={!value.trim()}
                  >
                    <Text as="span" size="B400">
                      Отправить
                    </Text>
                  </Button>
                </Box>
              )}
            </Box>
          </Dialog>
        </FocusTrap>
      </OverlayCenter>
    </Overlay>
  );
}
