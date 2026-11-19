import { atom, getDefaultStore, type WritableAtom } from 'jotai';
import {
  atomWithLocalStorage,
  getLocalStorageItem,
  setLocalStorageItem,
} from '../app/state/utils/atomWithLocalStorage';
import * as api from './api';
import {
  MATRIX_MODULE_ID,
  isMatrixProfileId,
  matrixProfileId,
  type AuthPrompt,
  type Chat,
  type ModuleInfo,
  type Msg,
  type MshhEvent,
  type MshhStore,
  type ProfileMeta,
  type ProfileStatus,
} from './types';

export const modulesAtom = atom<ModuleInfo[]>([api.MATRIX_BUILTIN_MODULE]);
export const profilesAtom = atom<ProfileMeta[]>([]);
export const profileStatusAtom = atom<Record<string, ProfileStatus>>({});
export const mshhChatsAtom = atom<Record<string, Chat[]>>({});
export const authPromptsAtom = atom<Record<string, AuthPrompt>>({});
export const messagesCacheAtom = atom<Record<string, Record<string, Msg[]>>>({});
export const typingAtom = atom<Record<string, Record<string, string[]>>>({});

/** Chat currently opened in the MshhChatView panel. */
export const openMshhChatAtom = atom<{ profileId: string; chatId: string } | null>(null);

export interface MshhToast {
  id: number;
  text: string;
}
export const toastsAtom = atom<MshhToast[]>([]);

export const pushToast = (text: string) => {
  const store = getDefaultStore();
  store.set(toastsAtom, [
    ...store.get(toastsAtom),
    { id: Date.now() + Math.random(), text },
  ]);
};

export const mshhErrorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// --- Unified chat list filters (persisted; empty set = show all) ---

const FILTER_PROFILE_KEY = 'mshh-filter-profiles';
const FILTER_MODULE_KEY = 'mshh-filter-modules';

const readStringArray = (key: string): string[] => getLocalStorageItem<string[]>(key, []);
const writeStringArray = (key: string, value: string[]) => setLocalStorageItem(key, value);

const profileFilterBaseAtom = atomWithLocalStorage<string[]>(
  FILTER_PROFILE_KEY,
  readStringArray,
  writeStringArray
);
const moduleFilterBaseAtom = atomWithLocalStorage<string[]>(
  FILTER_MODULE_KEY,
  readStringArray,
  writeStringArray
);

export const selectedProfileIdsAtom: WritableAtom<Set<string>, [Set<string>], undefined> = atom(
  (get) => new Set(get(profileFilterBaseAtom)),
  (get, set, ids) => set(profileFilterBaseAtom, Array.from(ids))
);

export const selectedModuleIdsAtom: WritableAtom<Set<string>, [Set<string>], undefined> = atom(
  (get) => new Set(get(moduleFilterBaseAtom)),
  (get, set, ids) => set(moduleFilterBaseAtom, Array.from(ids))
);

// --- Data refresh ---

/** Matrix profiles are derived renderer-side from the active Cinny session(s). */
export const matrixProfiles = (userId?: string): ProfileMeta[] =>
  userId
    ? [
        {
          id: matrixProfileId(userId),
          moduleId: MATRIX_MODULE_ID,
          name: userId,
          enabled: true,
          config: {},
        },
      ]
    : [];

export const refreshModules = async (): Promise<void> => {
  getDefaultStore().set(modulesAtom, await api.listModules());
};

export const refreshProfiles = async (matrixUserId?: string): Promise<void> => {
  const store = getDefaultStore();
  const hostProfiles = await api.listProfiles().catch(() => [] as ProfileMeta[]);
  const profiles = [...matrixProfiles(matrixUserId), ...hostProfiles];
  store.set(profilesAtom, profiles);
  const statuses = { ...store.get(profileStatusAtom) };
  for (const p of profiles) {
    if (isMatrixProfileId(p.id)) statuses[p.id] = 'online';
  }
  store.set(profileStatusAtom, statuses);
};

// --- Event application ---

const MSG_CACHE_LIMIT = 200;

interface AuthEventPayload {
  type: 'qr' | 'code' | 'done' | 'error';
  dataUrl?: string;
  hint?: string;
  message?: string;
}
interface TypingEventPayload {
  chatId: string;
  who: string;
  on: boolean;
}
interface ReceiptEventPayload {
  chatId: string;
  lastReadId: string;
}
type ChatUpdateEventPayload = { chatId: string } & Partial<Omit<Chat, 'chatId'>>;

export const applyMessageEvent = (store: MshhStore, profileId: string, msg: Msg) => {
  const chatId = msg.chatId;
  if (!chatId) return;

  const cache = store.get(messagesCacheAtom);
  const chatCache = cache[profileId] ?? {};
  const list = chatCache[chatId] ?? [];
  const idx = list.findIndex((m) => m.id === msg.id);
  const nextList =
    idx === -1
      ? [...list, msg]
      : list.map((m, i) => (i === idx ? msg : m));
  const trimmed =
    nextList.length > MSG_CACHE_LIMIT ? nextList.slice(nextList.length - MSG_CACHE_LIMIT) : nextList;
  store.set(messagesCacheAtom, {
    ...cache,
    [profileId]: { ...chatCache, [chatId]: trimmed },
  });

  const chats = store.get(mshhChatsAtom)[profileId];
  const chatIdx = chats?.findIndex((c) => c.chatId === chatId) ?? -1;
  if (!chats || chatIdx === -1) return;
  const chat = chats[chatIdx];
  const openChat = store.get(openMshhChatAtom);
  const isOpen = openChat?.profileId === profileId && openChat.chatId === chatId;
  const unread = msg.out || isOpen ? chat.unread ?? 0 : (chat.unread ?? 0) + 1;
  store.set(mshhChatsAtom, {
    ...store.get(mshhChatsAtom),
    [profileId]: chats.map((c, i) =>
      i === chatIdx
        ? {
            ...c,
            unread,
            lastMessage: {
              id: msg.id,
              text: msg.text,
              ts: msg.ts,
              out: msg.out,
              senderName: msg.senderName,
            },
          }
        : c
    ),
  });
};

/** Set a chat's local unread counter to zero (before/without a host receipt event). */
export const markChatReadLocally = (profileId: string, chatId: string) => {
  const store = getDefaultStore();
  const chats = store.get(mshhChatsAtom)[profileId] ?? [];
  store.set(mshhChatsAtom, {
    ...store.get(mshhChatsAtom),
    [profileId]: chats.map((c) => (c.chatId === chatId ? { ...c, unread: 0 } : c)),
  });
};

export const applyMshhEvent = (store: MshhStore, ev: MshhEvent) => {
  switch (ev.event) {
    case 'status': {
      store.set(profileStatusAtom, {
        ...store.get(profileStatusAtom),
        [ev.profileId]: ev.payload as ProfileStatus,
      });
      break;
    }
    case 'auth': {
      const prompts = { ...store.get(authPromptsAtom) };
      const p = ev.payload as AuthEventPayload;
      if (p.type === 'qr') {
        prompts[ev.profileId] = { type: 'qr', dataUrl: p.dataUrl ?? '' };
      } else if (p.type === 'code') {
        prompts[ev.profileId] = { type: 'code', hint: p.hint };
      } else if (p.type === 'error') {
        prompts[ev.profileId] = { type: 'error', message: p.message ?? 'Ошибка авторизации' };
      } else {
        delete prompts[ev.profileId];
        pushToast('Профиль подключён');
      }
      store.set(authPromptsAtom, prompts);
      break;
    }
    case 'chats': {
      store.set(mshhChatsAtom, {
        ...store.get(mshhChatsAtom),
        [ev.profileId]: ev.payload as Chat[],
      });
      break;
    }
    case 'message': {
      applyMessageEvent(store, ev.profileId, ev.payload as Msg);
      break;
    }
    case 'chat-update': {
      const { chatId, ...patch } = ev.payload as ChatUpdateEventPayload;
      const chats = store.get(mshhChatsAtom)[ev.profileId] ?? [];
      store.set(mshhChatsAtom, {
        ...store.get(mshhChatsAtom),
        [ev.profileId]: chats.map((c) => (c.chatId === chatId ? { ...c, ...patch } : c)),
      });
      break;
    }
    case 'typing': {
      const p = ev.payload as TypingEventPayload;
      const perProfile = store.get(typingAtom);
      const perChat = { ...(perProfile[ev.profileId] ?? {}) };
      const whos = new Set(perChat[p.chatId] ?? []);
      if (p.on) {
        whos.add(p.who);
      } else {
        whos.delete(p.who);
      }
      perChat[p.chatId] = Array.from(whos);
      store.set(typingAtom, { ...perProfile, [ev.profileId]: perChat });
      break;
    }
    case 'receipt': {
      const p = ev.payload as ReceiptEventPayload;
      markChatReadLocally(ev.profileId, p.chatId);
      break;
    }
    case 'error': {
      const p = ev.payload as { message?: string };
      console.warn(`[mshh:${ev.profileId}]`, p.message);
      break;
    }
  }
};

// Refcounted event subscription: the provider may be mounted from several
// entry points (Home and Settings) but only one listener reaches the host.
let listenerCount = 0;
let detachListener: (() => void) | undefined;

export const attachMshhEvents = (): (() => void) => {
  listenerCount += 1;
  if (!detachListener) {
    detachListener = api.onEvent((ev) => applyMshhEvent(getDefaultStore(), ev));
  }
  return () => {
    listenerCount -= 1;
    if (listenerCount <= 0) {
      detachListener?.();
      detachListener = undefined;
      listenerCount = 0;
    }
  };
};

/** Fetch the chat snapshot of a profile into the store. */
export const loadProfileChats = async (profileId: string): Promise<void> => {
  const chats = await api.getChats(profileId).catch(() => [] as Chat[]);
  applyMshhEvent(getDefaultStore(), { profileId, event: 'chats', payload: chats });
};

/** Seed/replace the in-memory history of a chat (initial fetch on open). */
export const setChatMessages = (profileId: string, chatId: string, msgs: Msg[]) => {
  const store = getDefaultStore();
  const cache = store.get(messagesCacheAtom);
  store.set(messagesCacheAtom, {
    ...cache,
    [profileId]: { ...(cache[profileId] ?? {}), [chatId]: msgs },
  });
};
