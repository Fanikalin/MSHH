import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import {
  Box,
  Button,
  Chip,
  Icon,
  IconButton,
  Icons,
  Scroll,
  Spinner,
  Text,
  TextArea,
  color,
  config,
  toRem,
} from 'folds';
import { isKeyHotkey } from 'is-hotkey';
import { Page, PageHeader } from '../../app/components/page';
import { ScreenSize, useScreenSizeContext } from '../../app/hooks/useScreenSize';
import { useKeyDown } from '../../app/hooks/useKeyDown';
import colorMXID from '../../util/colorMXID';
import { getHomeRoomPath, getMshhPath } from '../../app/pages/pathUtils';
import { api, mediaUrl } from '../api';
import {
  chatKey,
  chatsAtom,
  getMessages,
  mergeMessages,
  messagesAtom,
  modulesAtom,
  openedChatAtom,
  profilesAtom,
  promptsAtom,
  setMessages,
  typingAtom,
} from '../state';
import { Message, MessageMedia } from '../types';
import {
  formatBytes,
  formatDaySeparator,
  formatMessageTime,
  isSameDay,
} from '../components/format';
import { MshhAvatar } from '../components/MshhAvatar';
import { PeerCard } from '../components/PeerCard';
import { StatusDot, profileStatusText } from '../components/StatusDot';
import { EmptyState } from '../components/EmptyState';
import { PromptDialog } from './PromptDialog';
import { useMshhT } from '../i18n';

const HISTORY_LIMIT = 50;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const TYPING_THROTTLE_MS = 4000;

const mediaKindFromName = (name: string): MessageMedia['kind'] => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'ogg', 'wav', 'm4a', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  return 'file';
};

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

type MediaBlockProps = { media: MessageMedia };

function MediaBlock({ media }: MediaBlockProps) {
  const t = useMshhT();
  if (media.kind === 'image' && media.path) {
    return (
      <Box style={{ maxWidth: toRem(320) }}>
        <img
          src={mediaUrl(media.path)}
          alt={media.name ?? ''}
          style={{ maxWidth: '100%', borderRadius: config.radii.R300, display: 'block' }}
        />
      </Box>
    );
  }
  if (media.path) {
    return (
      <Box style={{ maxWidth: toRem(320) }}>
        <Chip
          as="a"
          size="400"
          variant="Secondary"
          fill="Soft"
          radii="400"
          href={mediaUrl(media.path)}
          download={media.name ?? true}
          before={<Icon size="100" src={Icons.Download} />}
        >
          <Text as="span" size="L400" truncate>
            {media.name ?? t('file.fallback')}
            {media.size ? ` · ${formatBytes(media.size)}` : ''}
          </Text>
        </Chip>
      </Box>
    );
  }
  return null;
}

type MessageRowProps = {
  msg: Message;
  startGroup: boolean;
  failed: boolean;
};

function MessageRow({ msg, startGroup, failed }: MessageRowProps) {
  const t = useMshhT();
  return (
    <Box
      direction={msg.out ? 'RowReverse' : 'Row'}
      alignItems="End"
      gap="200"
      style={{ minWidth: 0 }}
    >
      {!msg.out &&
        (startGroup ? (
          <Box shrink="No">
            <MshhAvatar id={msg.senderId} name={msg.senderName ?? msg.senderId} size="300" />
          </Box>
        ) : (
          <Box shrink="No" style={{ width: toRem(34) }} />
        ))}
      <Box
        direction="Column"
        gap="100"
        style={{
          maxWidth: '72%',
          minWidth: 0,
          padding: config.space.S200,
          paddingLeft: config.space.S300,
          paddingRight: config.space.S300,
          borderRadius: config.radii.R300,
          backgroundColor: msg.out ? color.Primary.Container : color.Secondary.Container,
          opacity: msg.pending && !failed ? 0.6 : undefined,
        }}
      >
        {!msg.out && startGroup && (
          <Text
            as="span"
            size="L400"
            style={{ color: colorMXID(msg.senderId), wordBreak: 'break-word' }}
          >
            {msg.senderName ?? msg.senderId}
          </Text>
        )}
        {msg.media && <MediaBlock media={msg.media} />}
        {msg.text && (
          <Text size="T300" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {msg.text}
          </Text>
        )}
        <Box alignItems="Center" justifyContent={msg.out ? 'End' : 'Start'} gap="100">
          {failed && (
            <Text size="T200" style={{ color: color.Critical.Main }}>
              {t('chat.sendFailed')}
            </Text>
          )}
          {!failed && msg.pending && (
            <Text size="T200" priority="300">
              {t('chat.sending')}
            </Text>
          )}
          {msg.edited && (
            <Text size="T200" priority="300">
              {t('chat.edited')}
            </Text>
          )}
          <Box shrink="No">
            <Text as="span" size="T200" priority="300">
              {formatMessageTime(msg.ts)}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/** Unified chat view body for non-Matrix profiles. Exported wrapper sits at
 * the end of the file and remounts this view per chat: composer draft, picked
 * files and scroll state must never bleed from one chat into another. */
function MshhChatView() {
  const { profileId, chatId } = useParams<{ profileId: string; chatId: string }>();
  const navigate = useNavigate();
  const screenSize = useScreenSizeContext();
  const isMobile = screenSize === ScreenSize.Mobile;
  const t = useMshhT();
  const profiles = useAtomValue(profilesAtom);
  const modules = useAtomValue(modulesAtom);
  const chatsMap = useAtomValue(chatsAtom);
  const messagesMap = useAtomValue(messagesAtom);
  const typingMap = useAtomValue(typingAtom);
  const [, setOpenedChat] = useAtom(openedChatAtom);

  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<{ path: string; name?: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(Date.now());
  const [peerOpen, setPeerOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastTypingRef = useRef(0);
  const prependHeightRef = useRef<number | null>(null);

  const profile = useMemo(() => profiles.find((p) => p.id === profileId), [profiles, profileId]);
  const module = useMemo(() => modules.find((m) => m.id === profile?.moduleId), [modules, profile]);
  const key = profileId && chatId ? chatKey(profileId, chatId) : '';
  const chat = useMemo(() => (key ? chatsMap.get(key) : undefined), [chatsMap, key]);
  const messages = useMemo(
    () => (key ? (messagesMap.get(key) as Message[] | undefined) ?? [] : []),
    [messagesMap, key]
  );
  const typing = key ? typingMap.get(key) : undefined;
  const typingActive = !!typing && typing.until > tick;
  const prompts = useAtomValue(promptsAtom);
  // Renderer-runtime Matrix chats render as a stub here — the native room view
  // stays reachable via the Cinny route; the list pane is never left.
  const isMatrixRenderer = profile?.runtime === 'renderer' && profile.moduleId === 'matrix';
  // карточка профиля чата доступна, если модуль её объявил
  const peerSupported = module?.capabilities?.peerProfile === true;

  // Mark open + read; publish the opened chat for bridges.
  useEffect(() => {
    if (isMatrixRenderer || !profileId || !chatId) return undefined;
    setOpenedChat({ profileId, chatId });
    setHasMore(true);
    setLoadingOlder(false);
    setPeerOpen(false);
    nearBottomRef.current = true;
    api.openChat(profileId, chatId).catch(() => {
      /* ignore */
    });
    api.markRead(profileId, chatId).catch(() => {
      /* ignore */
    });
    return () => setOpenedChat(null);
  }, [isMatrixRenderer, profileId, chatId, setOpenedChat]);

  // Initial page of history when the view holds no messages.
  useEffect(() => {
    if (!profileId || !chatId) return;
    if (isMatrixRenderer) return;
    if (module?.capabilities?.history === false) return;
    if (getMessages(profileId, chatId).length > 0) return;
    const currentChatId = chatId;
    api
      .history(profileId, chatId, undefined, HISTORY_LIMIT)
      .then((history) => {
        if (!profileId || chatId !== currentChatId) return;
        // replace only if nothing arrived meanwhile, otherwise merge
        if (getMessages(profileId, chatId).length === 0) {
          setMessages(profileId, chatId, history);
        } else {
          mergeMessages(profileId, chatId, history);
        }
        if (history.length < HISTORY_LIMIT) setHasMore(false);
      })
      .catch(() => {
        /* ignore */
      });
  }, [isMatrixRenderer, profileId, chatId, module]);

  // Expire the typing indicator.
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Escape closes the peer card first, then returns to the chat list; an open
  // auth prompt keeps its dialog in front.
  useKeyDown(
    window,
    useCallback(
      (evt: KeyboardEvent) => {
        if (!isKeyHotkey('escape', evt)) return;
        const hasPrompt = profileId ? prompts.has(profileId) : prompts.size > 0;
        if (hasPrompt) return;
        if (peerOpen) {
          setPeerOpen(false);
          return;
        }
        navigate(getMshhPath());
      },
      [navigate, profileId, prompts, peerOpen]
    )
  );

  // Keep pinned to bottom when near it; restore position after older pages prepend.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependHeightRef.current !== null) {
      const delta = el.scrollHeight - prependHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      prependHeightRef.current = null;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadOlder = useCallback(async () => {
    if (!profileId || !chatId || loadingOlder || !hasMore) return;
    if (module?.capabilities?.history === false) return;
    const list = getMessages(profileId, chatId);
    if (list.length === 0) return;
    const el = scrollRef.current;
    prependHeightRef.current = el?.scrollHeight ?? null;
    setLoadingOlder(true);
    try {
      const older = await api.history(profileId, chatId, list[0].ts, HISTORY_LIMIT);
      if (older.length < HISTORY_LIMIT) setHasMore(false);
      if (older.length > 0) mergeMessages(profileId, chatId, older);
      else prependHeightRef.current = null;
    } catch {
      prependHeightRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }, [profileId, chatId, loadingOlder, hasMore, module]);

  const handleScroll = useCallback(
    (evt: React.UIEvent<HTMLDivElement>) => {
      const el = evt.currentTarget;
      nearBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
      if (el.scrollTop <= 30) loadOlder();
    },
    [loadOlder]
  );

  const pickFiles = useCallback(async () => {
    try {
      const picked = await api.pickFiles();
      if (picked.length > 0) {
        setFiles((prev) => [...prev, ...picked.map((path) => ({ path, name: baseName(path) }))]);
      }
    } catch {
      // dialog unavailable — ignore
    }
  }, []);

  const sendTypingThrottled = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
    if (module?.capabilities?.typing === false) return;
    lastTypingRef.current = now;
    if (profileId && chatId)
      api.sendTyping(profileId, chatId).catch(() => {
        /* ignore */
      });
  }, [profileId, chatId, module]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!profileId || !chatId || sending || (!text && files.length === 0)) return;

    const optimistic: Message = {
      id: crypto.randomUUID(),
      chatId,
      profileId,
      senderId: 'me',
      ts: Date.now(),
      out: true,
      text: text || undefined,
      media:
        files.length > 0
          ? {
              kind: mediaKindFromName(files[0].name ?? files[0].path),
              name: files.map((f) => f.name ?? baseName(f.path)).join(', '),
            }
          : undefined,
      pending: true,
    };
    mergeMessages(profileId, chatId, [optimistic]);
    setDraft('');
    setFiles([]);
    setSending(true);
    try {
      await api.send(profileId, chatId, text || undefined, files.length > 0 ? files : undefined);
      // the confirmed message arrives through the event bus and collapses its twin
    } catch {
      // optimistic message stays pending-flagged; the marker renders the error line
      setFailedIds((prev) => new Set(prev).add(optimistic.id));
      setDraft((cur) => cur || text);
    } finally {
      setSending(false);
    }
  }, [draft, files, profileId, chatId, sending]);

  const handleDraftKeyDown = useCallback(
    (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (evt.key === 'Enter' && !evt.shiftKey) {
        evt.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const rows = useMemo(() => {
    const result: React.ReactNode[] = [];
    let prev: Message | null = null;
    messages.forEach((msg) => {
      const dayChanged = !prev || !isSameDay(prev.ts, msg.ts);
      const startGroup =
        dayChanged || !prev || prev.senderId !== msg.senderId || msg.ts - prev.ts > GROUP_WINDOW_MS;
      if (dayChanged) {
        result.push(
          <Box key={`day-${msg.id}`} alignItems="Center" justifyContent="Center">
            <Chip as="span" size="400" variant="SurfaceVariant" fill="Soft" radii="Pill">
              <Text as="span" size="L400">
                {formatDaySeparator(msg.ts)}
              </Text>
            </Chip>
          </Box>
        );
      }
      result.push(
        <MessageRow key={msg.id} msg={msg} startGroup={startGroup} failed={failedIds.has(msg.id)} />
      );
      prev = msg;
    });
    return result;
  }, [messages, failedIds]);

  if (!profileId || !chatId) return null;

  if (isMatrixRenderer) {
    return (
      <Page>
        <PageHeader outlined balance>
          {isMobile && (
            <Box shrink="No">
              <IconButton
                variant="Background"
                fill="None"
                onClick={() => navigate(getMshhPath())}
                aria-label={t('chat.back')}
              >
                <Icon src={Icons.ArrowGoLeft} />
              </IconButton>
            </Box>
          )}
          <Box grow="Yes" direction="Column" gap="0" style={{ minWidth: 0 }}>
            <Text size="H4" truncate>
              {chat?.title || t('chat.matrixTitle')}
            </Text>
            <Box alignItems="Center" gap="100">
              {profile && <StatusDot status={profile.status} />}
              <Text size="T200" priority="300" truncate>
                {profile ? `${profile.name} · ${profile.moduleName}` : '…'}
              </Text>
            </Box>
          </Box>
        </PageHeader>
        <EmptyState
          title={chat?.title || t('chat.matrixTitle')}
          subtitle={t('chat.matrixDesc')}
        >
          <Button variant="Primary" onClick={() => navigate(getHomeRoomPath(chatId))}>
            <Text as="span" size="B300">
              {t('chat.openInCinny')}
            </Text>
          </Button>
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page style={{ position: 'relative' }}>
      <PageHeader
        outlined
        balance
        onContextMenu={(evt) => {
          if (!peerSupported) return;
          evt.preventDefault();
          setPeerOpen(true);
        }}
      >
        {isMobile && (
          <Box shrink="No">
            <IconButton
              variant="Background"
              fill="None"
              onClick={() => navigate(getMshhPath())}
              aria-label={t('chat.back')}
            >
              <Icon src={Icons.ArrowGoLeft} />
            </IconButton>
          </Box>
        )}
        <Box grow="Yes" direction="Column" gap="0" style={{ minWidth: 0 }}>
          <Text size="H4" truncate>
            {chat?.title || t('chat.title')}
          </Text>
          <Box alignItems="Center" gap="100">
            {profile && <StatusDot status={profile.status} />}
            <Text size="T200" priority="300" truncate>
              {profile
                ? `${profile.name} · ${profile.moduleName} — ${profileStatusText(profile)}`
                : '…'}
            </Text>
          </Box>
        </Box>
        {peerSupported && (
          <Box shrink="No">
            <IconButton
              variant="Background"
              fill="None"
              aria-pressed={peerOpen}
              onClick={() => setPeerOpen((open) => !open)}
              aria-label={t('peer.cardTitle')}
            >
              <Icon src={Icons.Info} />
            </IconButton>
          </Box>
        )}
      </PageHeader>
      <Box grow="Yes" direction="Column" style={{ minHeight: 0 }}>
        <Scroll
          ref={scrollRef}
          variant="Background"
          direction="Vertical"
          size="300"
          hideTrack
          visibility="Hover"
          onScroll={handleScroll}
          style={{ height: '100%', minHeight: 0 }}
        >
          <Box
            direction="Column"
            gap="200"
            justifyContent="End"
            style={{ minHeight: '100%', padding: config.space.S300 }}
          >
            {loadingOlder && (
              <Box alignItems="Center" justifyContent="Center">
                <Spinner size="200" variant="Secondary" fill="Soft" />
              </Box>
            )}
            {rows}
            {typingActive && (
              <Text size="T200" priority="300">
                {typing?.who
                  ? t('chat.typingWho', { who: typing.who })
                  : t('chat.typing')}
              </Text>
            )}
          </Box>
        </Scroll>
      </Box>
      <Box
        shrink="No"
        direction="Column"
        gap="200"
        style={{
          padding: config.space.S300,
          borderTopWidth: config.borderWidth.B300,
        }}
      >
        {files.length > 0 && (
          <Box wrap="Wrap" gap="100">
            {files.map((file) => (
              <Chip
                key={file.path}
                size="400"
                variant="Secondary"
                fill="Soft"
                radii="Pill"
                after={
                  <IconButton
                    size="300"
                    variant="Secondary"
                    fill="None"
                    radii="Pill"
                    onClick={() => setFiles((prev) => prev.filter((f) => f.path !== file.path))}
                    aria-label={t('chat.removeFile')}
                  >
                    <Icon size="50" src={Icons.Cross} />
                  </IconButton>
                }
              >
                <Text as="span" size="L400" truncate>
                  {file.name}
                </Text>
              </Chip>
            ))}
          </Box>
        )}
        <Box alignItems="End" gap="200">
          <IconButton
            variant="Secondary"
            fill="None"
            onClick={() => pickFiles()}
            aria-label={t('chat.attach')}
          >
            <Icon src={Icons.Attachment} />
          </IconButton>
          <TextArea
            value={draft}
            onChange={(evt) => {
              setDraft(evt.currentTarget.value);
              sendTypingThrottled();
            }}
            onKeyDown={handleDraftKeyDown}
            placeholder={t('chat.placeholder')}
            rows={Math.min(4, Math.max(1, draft.split('\n').length))}
            resize="None"
            variant="SurfaceVariant"
            style={{ flex: 1, minWidth: 0, resize: 'none' }}
          />
          <IconButton
            variant="Primary"
            onClick={() => handleSend()}
            aria-disabled={sending || (!draft.trim() && files.length === 0)}
            aria-label={t('chat.send')}
          >
            {sending ? (
              <Spinner size="200" variant="Primary" fill="Soft" />
            ) : (
              <Icon src={Icons.Send} />
            )}
          </IconButton>
        </Box>
      </Box>
      {peerOpen && profileId && chatId && (
        <PeerCard profileId={profileId} chatId={chatId} onClose={() => setPeerOpen(false)} />
      )}
      <PromptDialog profileId={profileId} />
    </Page>
  );
}

/** Remount key: each chat gets its own view instance. */
export function MshhChat() {
  const { profileId, chatId } = useParams<{ profileId: string; chatId: string }>();
  const viewKey = profileId && chatId ? `${profileId}/${chatId}` : 'empty';
  return <MshhChatView key={viewKey} />;
}
