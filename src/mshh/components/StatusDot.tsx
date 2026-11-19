import React from 'react';
import { Box, color, config, toRem } from 'folds';
import { Profile, ProfileStatus } from '../types';

const statusColor = (status: ProfileStatus): string => {
  switch (status) {
    case 'online':
      return color.Success.Main;
    case 'connecting':
      return color.Warning.Main;
    case 'error':
      return color.Critical.Main;
    case 'renderer':
      return color.Secondary.Main;
    default:
      // offline / disabled
      return color.Secondary.Container;
  }
};

/** Russian status line for a profile, error text included when present. */
export const profileStatusText = (profile: Profile): string => {
  switch (profile.status) {
    case 'online':
      return 'онлайн';
    case 'connecting':
      return 'подключение…';
    case 'error':
      return profile.lastError ? `ошибка: ${profile.lastError}` : 'ошибка';
    case 'renderer':
      return 'управляется интерфейсом';
    case 'disabled':
      return 'отключён';
    default:
      return 'офлайн';
  }
};

/** Small colored circle reflecting a profile connection status. */
export function StatusDot({ status }: { status: ProfileStatus }) {
  return (
    <Box
      as="span"
      shrink="No"
      style={{
        display: 'inline-block',
        width: toRem(8),
        height: toRem(8),
        borderRadius: config.radii.Round,
        backgroundColor: statusColor(status),
        flexShrink: 0,
      }}
    />
  );
}
