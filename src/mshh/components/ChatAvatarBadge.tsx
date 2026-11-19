import React from 'react';
import { Box, Text, color, config, toRem } from 'folds';
import colorMXID from '../../util/colorMXID';
import { Chat, Profile } from '../types';
import { MshhAvatar } from './MshhAvatar';
import { StatusDot } from './StatusDot';

const BADGE_SIZE = 16; // ~40% of the size-400 chat avatar

type ChatAvatarBadgeProps = {
  chat: Chat;
  /** Owning profile — its avatar/monogram is shown in the bottom-right badge. */
  profile?: Profile;
};

/** Chat avatar with a small profile avatar badge in the bottom-right corner
 * (replaces the "which profile is this contact from" text line). */
export function ChatAvatarBadge({ chat, profile }: ChatAvatarBadgeProps) {
  return (
    <Box shrink="No" style={{ position: 'relative' }}>
      <MshhAvatar
        id={`${chat.profileId}/${chat.id}`}
        name={chat.title}
        src={chat.avatarPath}
        size="400"
      />
      {profile && (
        <Box
          as="span"
          style={{
            position: 'absolute',
            right: toRem(-2),
            bottom: toRem(-2),
            width: toRem(BADGE_SIZE),
            height: toRem(BADGE_SIZE),
            borderRadius: config.radii.Round,
            backgroundColor: colorMXID(profile.id),
            border: `${toRem(1.5)} solid ${color.Background.Container}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
          aria-label={`Профиль: ${profile.name}`}
        >
          <Text
            as="span"
            style={{
              fontSize: toRem(9),
              lineHeight: 1,
              fontWeight: 600,
              color: color.Surface.Container,
            }}
          >
            {(profile.name || '?').trim().charAt(0).toUpperCase() || '?'}
          </Text>
        </Box>
      )}
      {/* connection status moved to the free top-right corner */}
      {profile && (
        <Box style={{ position: 'absolute', right: toRem(-1), top: toRem(-1) }}>
          <StatusDot status={profile.status} />
        </Box>
      )}
    </Box>
  );
}
