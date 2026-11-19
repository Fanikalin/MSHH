import React, { FormEventHandler, KeyboardEventHandler, useEffect, useRef, useState } from 'react';
import { getDefaultStore, useAtom, useAtomValue } from 'jotai';
import { Box, Header, Icon, IconButton, Icons, Input, Scroll, Text, color, config, toRem } from 'folds';
import * as api from '../api';
import {
  applyMessageEvent,
  markChatReadLocally,
  messagesCacheAtom,
  mshhChatsAtom,
  mshhErrorMessage,
  openMshhChatAtom,
  profilesAtom,
  pushToast,
  setChatMessages,
  typingAtom,
} from '../state';
import { timeHourMinute } from '../../app/utils/time';
import { ContainerColor } from '../../app/styles/ContainerColor.css';

function MshhChatMessage({
  text,
  sender,
  ts,
  out,
}: {
  text: string;
  sender?: string;
  ts: number;
  out: boolean;
}) {
  return (
    <Box direction="Column" gap="100" alignItems={out ? 'End' : 'Start'}>
      <Text size="T200" priority="300">
        {out ? 'Вы' : sender} • {timeHourMinute(ts, true)}
      </Text>
      <Box
        className={ContainerColor({ variant: 'Secondary' })}
        style={{
          padding: `${config.space.S100} ${config.space.S200}`,
          borderRadius: config.radii.R300,
          maxWidth: toRem(320),
          overflowWrap: 'anywhere',
        }}
      >
        <Text size="T300" style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </Text>
      </Box>
    </Box>
  );
}

export function MshhChatView() {
  const [openChat, setOpenChat] = useAtom(openMshhChatAtom);
  const profiles = useAtomValue(profilesAtom);
  const chatsByProfile = useAtomValue(mshhChatsAtom);
  const messagesByChat = useAtomValue(messagesCacheAtom);
  const typingByProfile = useAtomValue(typingAtom);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);

  const profile = openChat ? profiles.find((p) => p.id === openChat.profileId) : undefined;
  const chat = openChat
    ? chatsByProfile[openChat.profileId]?.find((c) => c.chatId === openChat.chatId)
    : undefined;
  const messages = openChat ? messagesByChat[openChat.profileId]?.[openChat.chatId] ?? [] : [];
  const typing = openChat ? typingByProfile[openChat.profileId]?.[openChat.chatId] ?? [] : [];

  const chatId = openChat?.chatId;
  const profileId = openChat?.profileId;

  useEffect(() => {
    if (!openChat) return;
    let cancelled = false;
    void (async () => {
      const history = await api.getMessages(openChat.profileId, openChat.chatId).catch(() => undefined);
      if (!cancelled && history && history.length > 0) {
        setChatMessages(openChat.profileId, openChat.chatId, history);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, chatId]);

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : undefined;

  useEffect(() => {
    if (!openChat) return;
    if (messages.length === 0) return;
    const timer = window.setTimeout(() => {
      void api
        .markRead(openChat.profileId, openChat.chatId, messages[messages.length - 1].id)
        .catch(() => undefined);
      markChatReadLocally(openChat.profileId, openChat.chatId);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, chatId, lastMessageId]);

  useEffect(() => {
    bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, chatId]);

  if (!openChat || !profile || !chat) return null;

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const id = await api.send(profile.id, chat.chatId, text);
      applyMessageEvent(getDefaultStore(), profile.id, {
        chatId: chat.chatId,
        id,
        text,
        ts: Date.now(),
        out: true,
      });
      setDraft('');
    } catch (e) {
      pushToast(`Ошибка отправки: ${mshhErrorMessage(e)}`);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit: FormEventHandler = (evt) => {
    evt.preventDefault();
    void handleSend();
  };

  const handleComposerKeyDown: KeyboardEventHandler<HTMLInputElement> = (evt) => {
    if (evt.key === 'Enter' && !evt.shiftKey) {
      evt.preventDefault();
      void handleSend();
    }
  };

  return (
    <Box
      direction="Column"
      className={ContainerColor({ variant: 'Background' })}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: toRem(420),
        maxWidth: '100vw',
        zIndex: 100,
      }}
    >
      <Header variant="Background" size="600" style={{ padding: `0 ${config.space.S200}` }}>
        <Box grow="Yes" alignItems="Center" gap="200">
          <Box shrink="No">
            <Icon size="300" src={Icons.Message} />
          </Box>
          <Box direction="Column" grow="Yes" style={{ minWidth: 0 }}>
            <Text size="H4" truncate>
              {chat.name ?? chat.chatId}
            </Text>
            <Text size="T200" priority="300" truncate>
              {profile.name}
            </Text>
          </Box>
          <Box shrink="No">
            <IconButton
              onClick={() => setOpenChat(null)}
              variant="Surface"
              aria-label="Закрыть чат"
            >
              <Icon src={Icons.Cross} />
            </IconButton>
          </Box>
        </Box>
      </Header>

      <Box grow="Yes">
        <Scroll hideTrack visibility="Hover">
          <Box direction="Column" gap="300" style={{ padding: config.space.S200 }}>
            {messages.length === 0 && (
              <Text size="T300" priority="300" align="Center">
                Сообщений пока нет.
              </Text>
            )}
            {messages.map((msg) => (
              <MshhChatMessage
                key={msg.id}
                text={msg.text}
                sender={msg.senderName}
                ts={msg.ts}
                out={msg.out}
              />
            ))}
            <div ref={bottomAnchorRef} />
          </Box>
        </Scroll>
      </Box>

      <Box direction="Column" shrink="No" style={{ padding: config.space.S200 }} gap="100">
        {typing.length > 0 && (
          <Text size="T200" priority="300" style={{ color: color.Secondary.Main }}>
            {typing.length === 1 ? `${typing[0]} печатает…` : `${typing.length} печатают…`}
          </Text>
        )}
        <form onSubmit={handleSubmit}>
          <Box gap="200" alignItems="Center">
            <Box grow="Yes">
              <Input
                variant="SurfaceVariant"
                size="400"
                radii="300"
                placeholder="Сообщение"
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={handleComposerKeyDown}
                autoComplete="off"
                style={{ width: '100%' }}
              />
            </Box>
            <IconButton
              type="submit"
              variant="Primary"
              size="400"
              radii="300"
              aria-label="Отправить"
              aria-disabled={sending || draft.trim().length === 0}
            >
              <Icon src={Icons.Send} size="200" />
            </IconButton>
          </Box>
        </form>
      </Box>
    </Box>
  );
}
