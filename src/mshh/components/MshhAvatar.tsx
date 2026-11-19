import React, { ReactEventHandler, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage, color, Text } from 'folds';
import colorMXID from '../../util/colorMXID';
import { mediaUrl } from '../api';

type MshhAvatarProps = {
  /** Stable id — drives the fallback color (same id → same color). */
  id: string;
  /** Display name — first letter is shown when no avatar image exists. */
  name: string;
  /** Path inside a profile dataDir; served via the mshh-media protocol. */
  src?: string;
  size?: '200' | '300' | '400' | '500';
};

/** Avatar with colored-initial fallback, shared by chats, messages and profiles. */
export function MshhAvatar({ id, name, src, size = '300' }: MshhAvatarProps) {
  const [error, setError] = useState(false);

  const handleError: ReactEventHandler<HTMLImageElement> = () => setError(true);

  if (!src || error) {
    return (
      <Avatar size={size} radii="400">
        <AvatarFallback style={{ backgroundColor: colorMXID(id), color: color.Surface.Container }}>
          <Text as="span" size="B300" truncate>
            {(name || '?').trim().charAt(0).toUpperCase() || '?'}
          </Text>
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar size={size} radii="400">
      <AvatarImage src={mediaUrl(src)} alt={name} onError={handleError} draggable={false} />
    </Avatar>
  );
}
