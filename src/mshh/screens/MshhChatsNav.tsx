import React, { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import { Box, Icon, IconButton, Icons, IconSrc, Input, Scroll, Text, config } from 'folds';
import { PageNavHeader } from '../../app/components/page';
import { NavItem } from '../../app/components/nav';
import { UnreadBadge } from '../../app/components/unread-badge/UnreadBadge';
import {
  getMshhChatPath,
  getMshhProfileNewPath,
  getMshhProfilesPath,
} from '../../app/pages/pathUtils';
import { Chat, Profile } from '../types';
import { chatsAtom, establishedProfiles, filtersAtom, modulesAtom, profilesAtom } from '../state';
import { formatListTime } from '../components/format';
import { StatusDot } from '../components/StatusDot';
import { FilterStrip, FilterStripItem } from '../components/FilterStrip';
import { FolderItem } from '../components/FolderItem';
import { ChatAvatarBadge } from '../components/ChatAvatarBadge';

/** Ids of folders currently collapsed; persisted in localStorage. */
const FOLDERS_KEY = 'mshh_folder_collapsed';

type ChatFolder = {
  id: string;
  title: string;
  iconSrc: IconSrc;
  chats: Chat[];
};

const readCollapsedFolders = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

type ChatRowProps = {
  chat: Chat;
  profile: Profile;
  active: boolean;
  onClick: () => void;
};

function ChatRow({ chat, profile, active, onClick }: ChatRowProps) {
  return (
    <NavItem as="button" variant="Background" radii="400" aria-selected={active} onClick={onClick}>
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
        <ChatAvatarBadge chat={chat} profile={profile} />
        <Box grow="Yes" style={{ minWidth: 0 }}>
          <Text size="T300" truncate style={{ minWidth: 0 }}>
            {chat.title || 'Без названия'}
          </Text>
        </Box>
        <Box shrink="No" alignItems="Center" gap="100">
          <Text size="L400" priority="300">
            {formatListTime(chat.ts)}
          </Text>
          {chat.unread > 0 && <UnreadBadge highlight={!chat.muted} count={chat.unread} />}
        </Box>
      </Box>
    </NavItem>
  );
}

/** Nav column: unified chat list of all profiles with search, filter strip and folders. */
export function MshhChatsNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const chatsMap = useAtomValue(chatsAtom);
  const profiles = useAtomValue(profilesAtom);
  const modules = useAtomValue(modulesAtom);
  const [filters, setFilters] = useAtom(filtersAtom);
  // чипсы фильтров — только для профилей, дошедших до рабочего состояния
  const established = establishedProfiles(profiles);
  const visibleModules = useMemo(
    () => modules.filter((m) => established.some((p) => p.moduleId === m.id)),
    [modules, established]
  );

  const [collapsedFolders, setCollapsedFolders] = useState<string[]>(readCollapsedFolders);

  const toggleFolder = useCallback((id: string) => {
    setCollapsedFolders((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      try {
        localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const chats = useMemo(
    () => [...chatsMap.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [chatsMap]
  );
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const moduleById = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  const visibleChats = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return chats.filter((chat) => {
      const profile = profileById.get(chat.profileId);
      if (!profile) return false;
      if (filters.profileIds.length > 0 && !filters.profileIds.includes(chat.profileId)) {
        return false;
      }
      if (filters.moduleIds.length > 0 && !filters.moduleIds.includes(profile.moduleId)) {
        return false;
      }
      if (query) {
        const moduleName = moduleById.get(profile.moduleId)?.name ?? profile.moduleName;
        const haystack = `${chat.title} ${chat.subtitle ?? ''} ${profile.name} ${moduleName}`;
        if (!haystack.toLowerCase().includes(query)) return false;
      }
      return true;
    });
  }, [chats, profileById, moduleById, filters]);

  const chatsByKind = useMemo(() => {
    const dms: Chat[] = [];
    const groups: Chat[] = [];
    const channels: Chat[] = [];
    const archive: Chat[] = [];
    visibleChats.forEach((chat) => {
      if (chat.archived) archive.push(chat);
      else if (chat.kind === 'group') groups.push(chat);
      else if (chat.kind === 'channel') channels.push(chat);
      else dms.push(chat);
    });
    return { dms, groups, channels, archive };
  }, [visibleChats]);

  const folders = useMemo<ChatFolder[]>(() => {
    const result: ChatFolder[] = [];
    if (chatsByKind.groups.length > 0) {
      result.push({
        id: 'folder:supergroups',
        title: 'Супергруппы',
        iconSrc: Icons.User,
        chats: chatsByKind.groups,
      });
    }
    if (chatsByKind.channels.length > 0) {
      result.push({
        id: 'folder:channels',
        title: 'Каналы',
        iconSrc: Icons.Hash,
        chats: chatsByKind.channels,
      });
    }
    if (chatsByKind.archive.length > 0) {
      result.push({
        id: 'folder:archive',
        title: 'Архив',
        iconSrc: Icons.Inbox,
        chats: chatsByKind.archive,
      });
    }
    return result;
  }, [chatsByKind]);

  const stripItems = useMemo<FilterStripItem[]>(
    () => [
      ...visibleModules.map((module) => ({
        id: `module:${module.id}`,
        name: module.name,
        active: filters.moduleIds.includes(module.id),
        onToggle: () =>
          setFilters((prev) => ({
            ...prev,
            moduleIds: prev.moduleIds.includes(module.id)
              ? prev.moduleIds.filter((v) => v !== module.id)
              : [...prev.moduleIds, module.id],
          })),
      })),
      ...established.map((profile) => ({
        id: `profile:${profile.id}`,
        name: profile.name,
        active: filters.profileIds.includes(profile.id),
        before: <StatusDot status={profile.status} />,
        onToggle: () =>
          setFilters((prev) => ({
            ...prev,
            profileIds: prev.profileIds.includes(profile.id)
              ? prev.profileIds.filter((v) => v !== profile.id)
              : [...prev.profileIds, profile.id],
          })),
      })),
    ],
    [visibleModules, established, filters, setFilters]
  );

  // Matrix profiles are renderer-runtime too; they now open in the right pane
  // like every other chat — the native room view stays reachable from there.
  const openChat = useCallback(
    (chat: Chat) => {
      navigate(getMshhChatPath(chat.profileId, chat.id));
    },
    [navigate]
  );

  const renderChatRow = useCallback(
    (chat: Chat) => {
      const profile = profileById.get(chat.profileId);
      if (!profile) return null;
      return (
        <ChatRow
          key={`${chat.profileId}/${chat.id}`}
          chat={chat}
          profile={profile}
          active={location.pathname === getMshhChatPath(chat.profileId, chat.id)}
          onClick={() => openChat(chat)}
        />
      );
    },
    [profileById, location.pathname, openChat]
  );

  const listEmpty = chatsByKind.dms.length === 0 && folders.length === 0;

  return (
    <Box grow="Yes" direction="Column" style={{ minWidth: 0, minHeight: 0 }}>
      <PageNavHeader outlined={false}>
        <Box grow="Yes" gap="200">
          <Text size="H4" truncate>
            Чаты
          </Text>
        </Box>
        <Box shrink="No" gap="100">
          <IconButton
            variant="Background"
            fill="None"
            radii="300"
            onClick={() => navigate(getMshhProfilesPath())}
            aria-label="Менеджер профилей"
          >
            <Icon size="200" src={Icons.Setting} />
          </IconButton>
          <IconButton
            variant="Background"
            fill="None"
            radii="300"
            onClick={() => navigate(getMshhProfileNewPath())}
            aria-label="Добавить профиль"
          >
            <Icon size="200" src={Icons.Plus} />
          </IconButton>
        </Box>
      </PageNavHeader>
      <Box
        shrink="No"
        direction="Column"
        gap="200"
        style={{ padding: `${config.space.S200} ${config.space.S200} 0` }}
      >
        <Input
          value={filters.query}
          onChange={(evt) => setFilters((prev) => ({ ...prev, query: evt.currentTarget.value }))}
          placeholder="Поиск чатов"
          before={<Icon size="100" src={Icons.Search} />}
          variant="SurfaceVariant"
          size="400"
        />
        <FilterStrip items={stripItems} />
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
          <Box
            direction="Column"
            gap="100"
            style={{ padding: `${config.space.S200} ${config.space.S200} ${config.space.S300}` }}
          >
            {listEmpty ? (
              <Box
                direction="Column"
                alignItems="Center"
                gap="200"
                style={{ padding: config.space.S500 }}
              >
                <Icon size="300" src={Icons.Message} />
                <Text size="T300" priority="300" align="Center">
                  {filters.query.trim() ? 'Ничего не найдено' : 'Чатов пока нет'}
                </Text>
              </Box>
            ) : (
              <>
                {chatsByKind.dms.map(renderChatRow)}
                {folders.map((folder) => (
                  <React.Fragment key={folder.id}>
                    <FolderItem
                      id={folder.id}
                      title={folder.title}
                      iconSrc={folder.iconSrc}
                      count={folder.chats.length}
                      unread={folder.chats.reduce((sum, chat) => sum + chat.unread, 0)}
                      expanded={!collapsedFolders.includes(folder.id)}
                      onToggle={() => toggleFolder(folder.id)}
                    />
                    {!collapsedFolders.includes(folder.id) && folder.chats.map(renderChatRow)}
                  </React.Fragment>
                ))}
              </>
            )}
          </Box>
        </Scroll>
      </Box>
    </Box>
  );
}
