import React, { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import { Box, Chip, Icon, IconButton, Icons, Input, Text, config, toRem } from 'folds';
import { PageNav, PageNavContent, PageNavHeader } from '../../app/components/page';
import { NavItem } from '../../app/components/nav';
import { UnreadBadge } from '../../app/components/unread-badge/UnreadBadge';
import { getHomeRoomPath, getMshhChatPath, getMshhProfileNewPath } from '../../app/pages/pathUtils';
import { Chat } from '../types';
import { chatsAtom, establishedProfiles, filtersAtom, modulesAtom, profilesAtom } from '../state';
import { formatListTime } from '../components/format';
import { MshhAvatar } from '../components/MshhAvatar';
import { StatusDot } from '../components/StatusDot';

function FilterChip({
  active,
  onClick,
  before,
  children,
}: {
  active: boolean;
  onClick: () => void;
  before?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Chip
      size="400"
      variant={active ? 'Primary' : 'Background'}
      fill="Soft"
      radii="Pill"
      outlined={!active}
      before={before}
      onClick={onClick}
      aria-pressed={active}
    >
      <Text as="span" size="L400" truncate>
        {children}
      </Text>
    </Chip>
  );
}

/** Nav column: unified chat list of all profiles with search and filters. */
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

  const openChat = useCallback(
    (chat: Chat) => {
      const profile = profileById.get(chat.profileId);
      // Matrix profiles are driven by the renderer bridge → native Cinny room view.
      if (profile && profile.runtime === 'renderer' && profile.moduleId === 'matrix') {
        navigate(getHomeRoomPath(chat.id));
        return;
      }
      navigate(getMshhChatPath(chat.profileId, chat.id));
    },
    [navigate, profileById]
  );

  return (
    <PageNav size="300">
      <PageNavHeader outlined={false}>
        <Box grow="Yes" gap="200">
          <Text size="H4" truncate>
            Чаты
          </Text>
        </Box>
        <Box shrink="No">
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
      <Box grow="Yes" direction="Column">
        <PageNavContent>
          <div style={{ display: 'flex', flexDirection: 'column', gap: config.space.S300 }}>
            <Box direction="Column" gap="200" style={{ padding: `0 ${config.space.S200}` }}>
              <Input
                value={filters.query}
                onChange={(evt) =>
                  setFilters((prev) => ({ ...prev, query: evt.currentTarget.value }))
                }
                placeholder="Поиск чатов"
                before={<Icon size="100" src={Icons.Search} />}
                variant="SurfaceVariant"
                size="400"
              />
              {visibleModules.length > 0 && (
                <Box wrap="Wrap" gap="100">
                  {visibleModules.map((module) => (
                    <FilterChip
                      key={module.id}
                      active={filters.moduleIds.includes(module.id)}
                      onClick={() =>
                        setFilters((prev) => ({
                          ...prev,
                          moduleIds: prev.moduleIds.includes(module.id)
                            ? prev.moduleIds.filter((v) => v !== module.id)
                            : [...prev.moduleIds, module.id],
                        }))
                      }
                    >
                      {module.name}
                    </FilterChip>
                  ))}
                </Box>
              )}
              {established.length > 0 && (
                <Box wrap="Wrap" gap="100">
                  {established.map((profile) => (
                    <FilterChip
                      key={profile.id}
                      active={filters.profileIds.includes(profile.id)}
                      before={<StatusDot status={profile.status} />}
                      onClick={() =>
                        setFilters((prev) => ({
                          ...prev,
                          profileIds: prev.profileIds.includes(profile.id)
                            ? prev.profileIds.filter((v) => v !== profile.id)
                            : [...prev.profileIds, profile.id],
                        }))
                      }
                    >
                      {profile.name}
                    </FilterChip>
                  ))}
                </Box>
              )}
            </Box>
            <Box direction="Column" gap="100" style={{ paddingBottom: config.space.S200 }}>
              {visibleChats.length === 0 ? (
                <Box
                  direction="Column"
                  alignItems="Center"
                  gap="200"
                  style={{ padding: config.space.S500 }}
                >
                  <Icon size="300" src={Icons.Message} />
                  <Text size="T300" priority="300" align="Center">
                    Чатов пока нет
                  </Text>
                </Box>
              ) : (
                visibleChats.map((chat) => {
                  const profile = profileById.get(chat.profileId);
                  if (!profile) return null;
                  const active = location.pathname === getMshhChatPath(chat.profileId, chat.id);
                  return (
                    <NavItem
                      key={`${chat.profileId}/${chat.id}`}
                      as="button"
                      variant="Background"
                      radii="400"
                      aria-selected={active}
                      onClick={() => openChat(chat)}
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
                        <Box shrink="No" style={{ position: 'relative' }}>
                          <MshhAvatar
                            id={`${chat.profileId}/${chat.id}`}
                            name={chat.title}
                            src={chat.avatarPath}
                            size="400"
                          />
                          <Box
                            style={{ position: 'absolute', right: toRem(-1), bottom: toRem(-1) }}
                          >
                            <StatusDot status={profile.status} />
                          </Box>
                        </Box>
                        <Box grow="Yes" direction="Column" gap="100" style={{ minWidth: 0 }}>
                          <Box alignItems="Center" justifyContent="SpaceBetween" gap="200">
                            <Text size="T300" truncate style={{ minWidth: 0 }}>
                              {chat.title || 'Без названия'}
                            </Text>
                            <Box shrink="No">
                              <Text size="L400" priority="300">
                                {formatListTime(chat.ts)}
                              </Text>
                            </Box>
                          </Box>
                          <Box alignItems="Center" justifyContent="SpaceBetween" gap="200">
                            <Text size="T200" priority="300" truncate style={{ minWidth: 0 }}>
                              {profile.name} · {profile.moduleName}
                            </Text>
                            {chat.unread > 0 && (
                              <UnreadBadge highlight={!chat.muted} count={chat.unread} />
                            )}
                          </Box>
                        </Box>
                      </Box>
                    </NavItem>
                  );
                })
              )}
            </Box>
          </div>
        </PageNavContent>
      </Box>
    </PageNav>
  );
}
