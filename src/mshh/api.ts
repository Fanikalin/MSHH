import { Chat, MshhEvent, MshhState, Message, Profile } from './types';

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string; userError?: boolean };

type MshhBridge = {
  desktop: true;
  invoke: (channel: string, payload?: unknown) => Promise<Envelope<unknown>>;
  onEvent: (cb: (event: MshhEvent) => void) => () => void;
  onProfilesChanged: (cb: () => void) => () => void;
};

declare global {
  interface Window {
    mshh?: MshhBridge;
  }
}

export const mshhDesktop = typeof window !== 'undefined' && !!window.mshh?.desktop;

export const coreUnavailableError =
  'Ядро MSHH недоступно. Запустите приложение командой mshh (через Electron), а не как обычный сайт.';

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!window.mshh) throw new Error(coreUnavailableError);
  const res = (await window.mshh.invoke(channel, payload)) as Envelope<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export const api = {
  getState: () => invoke<MshhState>('getState'),
  createProfile: (
    moduleId: string,
    name: string,
    config: Record<string, unknown>,
    adoptPreview?: boolean
  ) => invoke<Profile>('profiles.create', { moduleId, name, config, adoptPreview }),
  updateProfile: (id: string, patch: Record<string, unknown>) =>
    invoke<Profile>('profiles.update', { id, patch }),
  deleteProfile: (id: string) => invoke<null>('profiles.delete', { id }),
  setProfileAvatar: (id: string, srcPath: string) =>
    invoke<Profile>('profiles.setAvatar', { id, srcPath }),
  setZoom: (zoom: number) => invoke<null>('app.setZoom', { zoom }),
  setProfileEnabled: (id: string, enabled: boolean) =>
    invoke<Profile>('profiles.update', { id, patch: { enabled } }),
  connectProfile: (id: string) =>
    invoke<{ renderer?: boolean; status?: string }>('profiles.connect', { id }),
  disconnectProfile: (id: string) => invoke<{ renderer?: boolean }>('profiles.disconnect', { id }),
  respondPrompt: (profileId: string, promptId: string, value: string) =>
    invoke<{ delivered: boolean }>('profiles.respond', { profileId, promptId, value }),
  getPendingPrompts: () => invoke<MshhEvent[]>('getPendingPrompts'),
  formPreviewStart: (moduleId: string, config?: Record<string, unknown>) =>
    invoke<{ previewId: string }>('formPreview.start', { moduleId, config }),
  formPreviewStop: (moduleId: string) => invoke<null>('formPreview.stop', { moduleId }),
  listChats: () => invoke<Chat[]>('chats.list'),
  history: (profileId: string, chatId: string, beforeTs?: number, limit?: number) =>
    invoke<Message[]>('chats.history', { profileId, chatId, beforeTs, limit }),
  send: (
    profileId: string,
    chatId: string,
    text?: string,
    files?: { path: string; name?: string }[]
  ) => invoke<Message>('chats.send', { profileId, chatId, text, files }),
  openChat: (profileId: string, chatId: string) =>
    invoke<null>('chats.open', { profileId, chatId }),
  markRead: (profileId: string, chatId: string) =>
    invoke<null>('chats.markRead', { profileId, chatId }),
  sendTyping: (profileId: string, chatId: string) =>
    invoke<null>('chats.typing', { profileId, chatId }),
  pickFiles: () => invoke<string[]>('dialog.pickFiles'),
  openExternal: (url: string) => invoke<null>('shell.openExternal', { url }),
  onEvent: (cb: (event: MshhEvent) => void) =>
    window.mshh?.onEvent(cb) ??
    (() => {
      /* no-op */
    }),
  onProfilesChanged: (cb: () => void) =>
    window.mshh?.onProfilesChanged(cb) ??
    (() => {
      /* no-op */
    }),
};

/** URL for media files stored in profile dataDir by modules. */
export const mediaUrl = (filePath: string) => `mshh-media://f/${encodeURIComponent(filePath)}`;

export type { Chat, Message };
