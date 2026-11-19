import React from 'react';
import { Avatar, AvatarFallback, Box, Icon, Icons, IconSrc, Text, color, config } from 'folds';
import { NavItem } from '../../app/components/nav';
import { UnreadBadge } from '../../app/components/unread-badge/UnreadBadge';
import colorMXID from '../../util/colorMXID';

type FolderItemProps = {
  /** Stable id — drives the avatar fallback color. */
  id: string;
  title: string;
  iconSrc: IconSrc;
  /** Number of chats inside the folder. */
  count: number;
  /** Sum of unread counters inside the folder. */
  unread: number;
  expanded: boolean;
  onToggle: () => void;
};

/** Collapsible folder header row: avatar, title, chat count and unread sum. */
export function FolderItem({
  id,
  title,
  iconSrc,
  count,
  unread,
  expanded,
  onToggle,
}: FolderItemProps) {
  return (
    <NavItem
      as="button"
      variant="Background"
      radii="400"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <Box
        grow="Yes"
        alignItems="Center"
        gap="200"
        style={{
          padding: config.space.S100,
          paddingLeft: config.space.S200,
          minWidth: 0,
        }}
      >
        <Avatar size="400" radii="400">
          <AvatarFallback
            style={{ backgroundColor: colorMXID(id), color: color.Surface.Container }}
          >
            <Icon size="200" src={iconSrc} />
          </AvatarFallback>
        </Avatar>
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="T300" truncate style={{ minWidth: 0 }}>
            {title}
          </Text>
        </Box>
        <Box shrink="No" alignItems="Center" gap="100">
          <Text size="L400" priority="300">
            {count}
          </Text>
          {unread > 0 && <UnreadBadge highlight={false} count={unread} />}
          <Icon size="100" src={expanded ? Icons.ChevronBottom : Icons.ChevronRight} />
        </Box>
      </Box>
    </NavItem>
  );
}
