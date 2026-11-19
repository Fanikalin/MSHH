import { atom, getDefaultStore } from 'jotai';
import { api, mshhDesktop } from './api';
import { Chat, MshhEvent, MshhState, Message, ModuleManifest, Profile } from './types';

// ---- atoms ----

export const coreReadyAtom = atom<boolean>(false);
export const coreErrorAtom = atom<string | null>(null);
export const appVersionAtom = atom<string>('');
export const platformAtom = atom<string>('');

export const profilesAtom = atom<Profile[]>([]);
export const modulesAtom = atom<ModuleManifest[]>([]);

/** key = `${profileId}/${chatId}` */
export const chatKey = (profileId: string, chatId: string) => `${profileId}/${chatId}`;

export const chatsAtom = atom<Map<string, Chat>>(new Map());
export const messagesAtom = atom<Map<string, Message[]>>(new Map());
export const typingAtom = atom<Map<string, { who?: string; until: number }>>(new Map());

/** pending auth prompts, latest per profile */
export const promptsAtom = atom<Map<string, MshhEvent & { type: 'prompt' }>>(new Map());

export type Filters = { query: string; moduleIds: string[]; profileIds: string[] };
export const filtersAtom = atom<Filters>({ query: '', moduleIds: [], profileIds: [] });

/** profileId/chatId currently open in the unified chat view */
export const openedChatAtom = atom<{ profileId: string; chatId: string } | null>(null);

// ---- store accessors used by ingest + bridges (outside React) ----

const store = getDefaultStore();

export function setCoreState(state: MshhState) {
  store.set(appVersionAtom, state.appVersion);
  store.set(platformAtom, state.platform);
  store.set(profilesAtom, state.profiles);
  store.set(modulesAtom, state.modules);
}

export function patchProfile(profileId: string, patch: Partial<Profile>) {
  const profiles = store.get(profilesAtom);
  store.set(
    profilesAtom,
    profiles.map((p) => (p.id === profileId ? { ...p, ...patch } : p))
  );
}

export function upsertChat(chat: Chat) {
  const chats = new Map(store.get(chatsAtom));
  chats.set(chatKey(chat.profileId, chat.id), {
    ...chats.get(chatKey(chat.profileId, chat.id)),
    ...chat,
  });
  store.set(chatsAtom, chats);
}

export function removeChat(profileId: string, chatId: string) {
  const chats = new Map(store.get(chatsAtom));
  chats.delete(chatKey(profileId, chatId));
  store.set(chatsAtom, chats);
  const messages = new Map(store.get(messagesAtom));
  messages.delete(chatKey(profileId, chatId));
  store.set(messagesAtom, messages);
}

function hasConfirmedTwin(pending: Message, byId: Map<string, Message>): boolean {
  return [...byId.values()].some(
    (m) =>
      !m.pending &&
      m.text &&
      pending.text &&
      m.text === pending.text &&
      Math.abs(m.ts - pending.ts) < 20000
  );
}

export function mergeMessages(profileId: string, chatId: string, incoming: Message[]) {
  if (!incoming.length) return;
  const key = chatKey(profileId, chatId);
  const messages = new Map(store.get(messagesAtom));
  const existing = messages.get(key) ?? [];
  const byId = new Map(existing.map((m) => [m.id, m]));
  incoming.forEach((m) => {
    const prev = byId.get(m.id);
    byId.set(m.id, prev ? { ...prev, ...m, pending: prev.pending && m.pending } : m);
  });
  // collapse confirmed duplicates of optimistic pending sends
  const list = [...byId.values()].filter((m) => !(m.pending && hasConfirmedTwin(m, byId)));
  list.sort((a, b) => a.ts - b.ts);
  messages.set(key, list);
  store.set(messagesAtom, messages);
}

export function setMessages(profileId: string, chatId: string, list: Message[]) {
  const key = chatKey(profileId, chatId);
  const messages = new Map(store.get(messagesAtom));
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  messages.set(key, sorted);
  store.set(messagesAtom, messages);
}

export function getMessages(profileId: string, chatId: string): Message[] {
  return store.get(messagesAtom).get(chatKey(profileId, chatId)) ?? [];
}

function markTyping(profileId: string, chatId: string, who?: string) {
  const typing = new Map(store.get(typingAtom));
  typing.set(chatKey(profileId, chatId), { who, until: Date.now() + 6000 });
  store.set(typingAtom, typing);
}

function pushPrompt(event: MshhEvent & { type: 'prompt' }) {
  const prompts = new Map(store.get(promptsAtom));
  prompts.set(event.profileId, event);
  store.set(promptsAtom, prompts);
}

export function clearPrompt(profileId: string, promptId?: string) {
  const prompts = new Map(store.get(promptsAtom));
  const current = prompts.get(profileId);
  if (current && (!promptId || current.payload.promptId === promptId)) {
    prompts.delete(profileId);
    store.set(promptsAtom, prompts);
  }
}

/** All chats, newest first. */
export function allChats(): Chat[] {
  return [...store.get(chatsAtom).values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function handleEvent(event: MshhEvent) {
  switch (event.type) {
    case 'chat':
      upsertChat(event.payload);
      break;
    case 'chat-remove':
      removeChat(event.profileId, event.payload.id);
      break;
    case 'message':
      mergeMessages(event.profileId, event.payload.chatId, [event.payload]);
      break;
    case 'message-edit':
      mergeMessages(event.profileId, event.payload.chatId, [event.payload]);
      break;
    case 'typing':
      markTyping(event.profileId, event.payload.chatId, event.payload.who);
      break;
    case 'status':
      patchProfile(event.profileId, {
        status: event.payload.state,
        lastError: event.payload.error ?? null,
      });
      break;
    case 'prompt':
      pushPrompt(event);
      break;
    default:
      break;
  }
}

// ---- bootstrap / event subscription ----

let started = false;

export async function startMshhCore() {
  if (!mshhDesktop || started) return;
  started = true;
  try {
    const state = await api.getState();
    setCoreState(state);
    const chats = await api.listChats();
    const chatMap = new Map<string, Chat>();
    chats.forEach((chat) => chatMap.set(chatKey(chat.profileId, chat.id), chat));
    store.get(chatsAtom).clear?.();
    store.set(chatsAtom, chatMap);
    store.set(coreReadyAtom, true);

    api.onEvent((event) => {
      handleEvent(event);
    });
    api.onProfilesChanged(() => {
      api
        .getState()
        .then(setCoreState)
        .catch(() => {
          // ignore state refresh failures
        });
    });
  } catch (e) {
    store.set(coreErrorAtom, e instanceof Error ? e.message : String(e));
    store.set(coreReadyAtom, true); // stop spinner, show error screen
  }
}
