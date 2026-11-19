import React, { useMemo } from 'react';
import type { Room } from 'matrix-js-sdk/lib/models/room';
import {
  Avatar,
  Badge,
  Box,
  Chip,
  Icon,
  Icons,
  Text,
  config,
} from 'folds';
import { useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import { useSelectedRoom } from '../../app/hooks/router/useSelectedRoom';
import { NavCategory, NavCategoryHeader, NavItem, NavButton, NavItemContent } from '../../app/components/nav';
import { RoomAvatar } from '../../app/components/room-avatar';
import { UnreadBadge, UnreadBadgeCenter } from '../../app/components/unread-badge';
import { useMatrixClient, useMxOptional } from '../../app/hooks/useMatrixClient';
import { useMediaAuthentication } from '../../app/hooks/useMediaAuthentication';
import { useRoomUnread } from '../../app/state/hooks/unread';
import { roomToUnreadAtom } from '../../app/state/room/roomToUnread';
import { getCanonicalAliasOrRoomId } from '../../app/utils/matrix';
import { getRoomAvatarUrl } from '../../app/utils/room';
import { nameInitials } from '../../app/utils/common';
import { timeHourMinute, timeDay, timeMon, today, yesterday } from '../../app/utils/time';
import { getHomeRoomPath } from '../../app/pages/pathUtils';
import {
  mshhChatsAtom,
  profilesAtom,
  modulesAtom,
  openMshhChatAtom,
  selectedModuleIdsAtom,
  selectedProfileIdsAtom,
} from '../state';
import {
  MATRIX_MODULE_ID,
  matrixProfileId,
  type Chat,
  type ProfileMeta,
} from '../types';

const formatListTime = (ts: number): string => {
  if (today(ts)) return timeHourMinute(ts, true);
  if (yesterday(ts)) return 'вчера';
  return `${timeDay(ts)} ${timeMon(ts)}`;
};

const getRoomLastMessageText = (room: Room): string | undefined => {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (evt.getType() === 'm.room.message') {
      const body = evt.getContent().body;
      if (typeof body === 'string' && body.length > 0) return body;
    }
  }
  return undefined;
};

function ModuleBadge({ label }: { label: string }) {
  return (
    <Chip as="span" variant="Secondary" size="400" fill="Soft" radii="Pill" outlined={false}>
      <Text as="span" size="L400" truncate>
        {label}
      </Text>
    </Chip>
  );
}

function MatrixChatRow({ roomId }: { roomId: string }) {
  const mx = useMatrixClient();
  const useAuthentication = useMediaAuthentication();
  const navigate = useNavigate();
  const selectedRoomId = useSelectedRoom();
  const room = mx.getRoom(roomId);
  const unread = useRoomUnread(roomId, roomToUnreadAtom);
  const userId = mx.getUserId() ?? '';

  if (!room) return null;

  const roomName = room.name ?? roomId;
  const selected = selectedRoomId === roomId;
  const preview = getRoomLastMessageText(room);
  const ts = room.getLastActiveTimestamp();

  return (
    <NavItem variant="Background" radii="400" highlight={unread !== undefined} aria-selected={selected}>
      <NavButton onClick={() => navigate(getHomeRoomPath(getCanonicalAliasOrRoomId(mx, roomId)))}>
        <NavItemContent>
          <Box as="span" grow="Yes" alignItems="Center" gap="200">
            <Avatar size="400" radii="400">
              <RoomAvatar
                roomId={roomId}
                src={getRoomAvatarUrl(mx, room, 96, useAuthentication)}
                alt={roomName}
                renderFallback={() => (
                  <Text as="span" size="H6">
                    {nameInitials(roomName)}
                  </Text>
                )}
              />
            </Avatar>
            <Box as="span" grow="Yes" direction="Column" style={{ minWidth: 0 }}>
              <Text as="span" size="T300" priority={unread ? '500' : '300'} truncate>
                {roomName}
              </Text>
              {preview && (
                <Text as="span" size="T200" priority="300" truncate>
                  {preview}
                </Text>
              )}
            </Box>
            <Box as="span" direction="Column" alignItems="End" gap="100" shrink="No">
              <Text as="span" size="T200" priority="300">
                {formatListTime(ts)}
              </Text>
              {unread && (
                <UnreadBadgeCenter>
                  <UnreadBadge highlight={unread.highlight > 0} count={unread.total} />
                </UnreadBadgeCenter>
              )}
            </Box>
          </Box>
          <Box as="span" alignItems="Center" gap="100">
            <ModuleBadge label="Matrix" />
            <Text as="span" size="T200" priority="300" truncate>
              {userId}
            </Text>
          </Box>
        </NavItemContent>
      </NavButton>
    </NavItem>
  );
}

function MshhChatRow({
  profile,
  chat,
  selected,
  onOpen,
}: {
  profile: ProfileMeta;
  chat: Chat;
  selected: boolean;
  onOpen: () => void;
}) {
  const moduleName = profile.moduleId;
  const hasUnread = (chat.unread ?? 0) > 0;
  const lastMessage = chat.lastMessage;

  return (
    <NavItem variant="Background" radii="400" highlight={hasUnread} aria-selected={selected}>
      <NavButton onClick={onOpen}>
        <NavItemContent>
          <Box as="span" grow="Yes" alignItems="Center" gap="200">
            <Avatar size="400" radii="400">
              {chat.avatar ? (
                <img
                  src={chat.avatar}
                  alt={chat.name ?? chat.chatId}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Text as="span" size="H6">
                  {nameInitials(chat.name ?? chat.chatId)}
                </Text>
              )}
            </Avatar>
            <Box as="span" grow="Yes" direction="Column" style={{ minWidth: 0 }}>
              <Text as="span" size="T300" priority={hasUnread ? '500' : '300'} truncate>
                {chat.name ?? chat.chatId}
              </Text>
              {lastMessage && (
                <Text as="span" size="T200" priority="300" truncate>
                  {lastMessage.out ? 'Вы: ' : (lastMessage.senderName ? `${lastMessage.senderName}: ` : '')}
                  {lastMessage.text}
                </Text>
              )}
            </Box>
            <Box as="span" direction="Column" alignItems="End" gap="100" shrink="No">
              {lastMessage && (
                <Text as="span" size="T200" priority="300">
                  {formatListTime(lastMessage.ts)}
                </Text>
              )}
              {hasUnread && (
                <UnreadBadgeCenter>
                  <UnreadBadge highlight={false} count={chat.unread ?? 0} />
                </UnreadBadgeCenter>
              )}
            </Box>
          </Box>
          <Box as="span" alignItems="Center" gap="100">
            <ModuleBadge label={moduleName} />
            <Text as="span" size="T200" priority="300" truncate>
              {profile.name}
            </Text>
          </Box>
        </NavItemContent>
      </NavButton>
    </NavItem>
  );
}

function FilterChip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <Chip
      variant={pressed ? 'Primary' : 'Surface'}
      size="400"
      radii="Pill"
      fill="Soft"
      aria-pressed={pressed}
      onClick={onClick}
      before={pressed ? <Icon size="50" src={Icons.Check} /> : undefined}
    >
      <Text size="L400" truncate>
        {label}
      </Text>
    </Chip>
  );
}

function FilterBar() {
  const [selectedProfiles, setSelectedProfiles] = useAtom(selectedProfileIdsAtom);
  const [selectedModules, setSelectedModules] = useAtom(selectedModuleIdsAtom);
  const profiles = useAtomValue(profilesAtom);
  const modules = useAtomValue(modulesAtom);

  const toggle = (set: Set<string>, apply: (next: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    apply(next);
  };

  const showAll = selectedProfiles.size === 0 && selectedModules.size === 0;
  const handleShowAll = () => {
    setSelectedProfiles(new Set());
    setSelectedModules(new Set());
  };

  return (
    <Box gap="100" wrap="Wrap" style={{ paddingBottom: config.space.S100 }}>
      <FilterChip label="Все" pressed={showAll} onClick={handleShowAll} />
      {profiles.map((profile) => (
        <FilterChip
          key={profile.id}
          label={profile.name}
          pressed={selectedProfiles.has(profile.id)}
          onClick={() => toggle(selectedProfiles, setSelectedProfiles, profile.id)}
        />
      ))}
      {modules.map((module) => (
        <FilterChip
          key={module.id}
          label={module.name}
          pressed={selectedModules.has(module.id)}
          onClick={() => toggle(selectedModules, setSelectedModules, module.id)}
        />
      ))}
    </Box>
  );
}

type UnifiedRow = {
  key: string;
  pinned: boolean;
  ts: number;
  matrixRoomId?: string;
  profile?: ProfileMeta;
  chat?: Chat;
};

export function UnifiedChats({ sortedRoomIds }: { sortedRoomIds: string[] }) {
  const mx = useMxOptional();
  const profiles = useAtomValue(profilesAtom);
  const chatsByProfile = useAtomValue(mshhChatsAtom);
  const [openChat, setOpenChat] = useAtom(openMshhChatAtom);
  const selectedProfiles = useAtomValue(selectedProfileIdsAtom);
  const selectedModules = useAtomValue(selectedModuleIdsAtom);

  const matrixProfile = useMemo(
    () => (mx ? profiles.find((p) => p.id === matrixProfileId(mx.getUserId() ?? '')) : undefined),
    [profiles, mx]
  );

  const rows = useMemo(() => {
    const out: UnifiedRow[] = [];
    const profileVisible = (profileId: string) =>
      selectedProfiles.size === 0 || selectedProfiles.has(profileId);
    const moduleVisible = (moduleId: string) =>
      selectedModules.size === 0 || selectedModules.has(moduleId);

    if (mx && matrixProfile && profileVisible(matrixProfile.id) && moduleVisible(MATRIX_MODULE_ID)) {
      for (const roomId of sortedRoomIds) {
        const room = mx.getRoom(roomId);
        if (!room) continue;
        out.push({
          key: `m:${roomId}`,
          pinned: false,
          ts: room.getLastActiveTimestamp(),
          matrixRoomId: roomId,
        });
      }
    }

    for (const [profileId, chats] of Object.entries(chatsByProfile)) {
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile || !profile.enabled || !profileVisible(profileId) || !moduleVisible(profile.moduleId))
        continue;
      for (const chat of chats) {
        out.push({
          key: `p:${profileId}:${chat.chatId}`,
          pinned: Boolean(chat.pinned),
          ts: chat.lastMessage?.ts ?? 0,
          profile,
          chat,
        });
      }
    }

    return out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.ts - a.ts;
    });
  }, [mx, profiles, chatsByProfile, sortedRoomIds, matrixProfile, selectedProfiles, selectedModules]);

  return (
    <NavCategory>
      <NavCategoryHeader>
        <Box grow="Yes" alignItems="Center" gap="200" style={{ padding: `0 ${config.space.S200}` }}>
          <Text size="H5" truncate>
            Чаты
          </Text>
          <Badge variant="Secondary" fill="Soft" size="400" radii="Pill" outlined>
            <Text as="span" size="L400">
              {rows.length}
            </Text>
          </Badge>
        </Box>
      </NavCategoryHeader>
      <FilterBar />
      {rows.length === 0 && (
        <Text size="T300" priority="300" style={{ padding: config.space.S200 }}>
          Ничего не найдено по фильтрам.
        </Text>
      )}
      {rows.map((row) =>
        row.matrixRoomId ? (
          <MatrixChatRow key={row.key} roomId={row.matrixRoomId} />
        ) : (
          <MshhChatRow
            key={row.key}
            profile={row.profile!}
            chat={row.chat!}
            selected={
              openChat?.profileId === row.profile?.id && openChat?.chatId === row.chat?.chatId
            }
            onOpen={() =>
              setOpenChat({ profileId: row.profile!.id, chatId: row.chat!.chatId })
            }
          />
        )
      )}
    </NavCategory>
  );
}
