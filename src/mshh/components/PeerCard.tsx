import React, { useEffect, useState } from 'react';
import {
  Box,
  Icon,
  IconButton,
  Icons,
  Scroll,
  Spinner,
  Text,
  color,
  config,
  toRem,
} from 'folds';
import { api } from '../api';
import { PeerProfile } from '../types';
import { useMshhT } from '../i18n';

type PeerCardProps = {
  profileId: string;
  chatId: string;
  onClose: () => void;
};

type PeerCardState = { profile?: PeerProfile; error?: string; loading: boolean };

/**
 * Карточка профиля чата: панель поверх правого края чата. Показывает fields,
 * которые вернул модуль (getPeerProfile), в порядке этого массива.
 */
export function PeerCard({ profileId, chatId, onClose }: PeerCardProps) {
  const t = useMshhT();
  const [state, setState] = useState<PeerCardState>({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api
      .getPeerProfile(profileId, chatId)
      .then((profile) => {
        if (alive) setState({ profile, loading: false });
      })
      .catch((err) => {
        if (alive) {
          setState({ error: err instanceof Error ? err.message : String(err), loading: false });
        }
      });
    return () => {
      alive = false;
    };
  }, [profileId, chatId]);

  return (
    <Box
      direction="Column"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: toRem(320),
        maxWidth: '100%',
        zIndex: 1,
        backgroundColor: color.Surface.Container,
        borderLeftStyle: 'solid',
        borderLeftWidth: config.borderWidth.B300,
        borderLeftColor: color.Surface.ContainerLine,
        boxShadow: '-12px 0 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      <Box
        shrink="No"
        alignItems="Center"
        gap="200"
        style={{ padding: config.space.S200, paddingLeft: config.space.S300 }}
      >
        <Box grow="Yes" alignItems="Center" gap="200" style={{ minWidth: 0 }}>
          <Box
            shrink="No"
            style={{
              width: toRem(3),
              height: toRem(20),
              borderRadius: config.radii.R300,
              backgroundColor: 'var(--mshh-accent)',
            }}
          />
          <Text size="H5" truncate style={{ minWidth: 0 }}>
            {t('peer.cardTitle')}
          </Text>
        </Box>
        <IconButton
          variant="Surface"
          fill="None"
          size="300"
          radii="300"
          onClick={onClose}
          aria-label={t('peer.close')}
        >
          <Icon size="200" src={Icons.Cross} />
        </IconButton>
      </Box>
      <Box grow="Yes" style={{ minHeight: 0 }}>
        <Scroll
          variant="Background"
          direction="Vertical"
          size="300"
          hideTrack
          visibility="Hover"
          style={{ height: '100%' }}
        >
          <Box direction="Column" gap="300" style={{ padding: config.space.S300 }}>
            {state.loading && (
              <Box alignItems="Center" justifyContent="Center" style={{ paddingTop: config.space.S500 }}>
                <Spinner size="300" variant="Secondary" fill="Soft" />
              </Box>
            )}
            {state.error && (
              <Text size="T200" style={{ color: color.Critical.Main }}>
                {state.error}
              </Text>
            )}
            {state.profile?.fields.map((field) => (
              <Box key={`${field.label}:${field.value}`} direction="Column" gap="100">
                <Text size="L400" priority="300">
                  {field.label}
                </Text>
                <Text size="T300" style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                  {field.value}
                </Text>
              </Box>
            ))}
            {!state.loading && !state.error && (state.profile?.fields.length ?? 0) === 0 && (
              <Text size="T200" priority="300" align="Center">
                {t('peer.unsupported')}
              </Text>
            )}
          </Box>
        </Scroll>
      </Box>
    </Box>
  );
}
