import {
  MATRIX_MODULE_ID,
  type Chat,
  type ModuleInfo,
  type MshhBridge,
  type Msg,
  type ProfileMeta,
} from './types';

/** Built-in renderer-side Matrix module (manifest only, no entry script). */
export const MATRIX_BUILTIN_MODULE: ModuleInfo = {
  id: MATRIX_MODULE_ID,
  name: 'Matrix',
  version: '1.0.0',
  side: 'renderer',
  description: 'Встроенный модуль Matrix (Cinny).',
  auth: { type: 'builtin-login' },
  profileFields: [],
};

const hasHost = typeof window !== 'undefined' && typeof window.mshh !== 'undefined';

/** No-op bridge used in plain web builds where the preload is absent. */
const createStubBridge = (): MshhBridge => {
  const noop = () => Promise.resolve();
  return {
    listModules: () => Promise.resolve([]),
    listProfiles: () => Promise.resolve([]),
    saveProfile: () => Promise.resolve({ id: '' }),
    setProfileSecret: noop,
    deleteProfile: noop,
    setEnabled: noop,
    connectProfile: noop,
    disconnectProfile: noop,
    submitAuth: noop,
    send: () => Promise.resolve(''),
    markRead: noop,
    setTyping: noop,
    getChats: () => Promise.resolve([]),
    getMessages: (): Promise<Msg[]> => Promise.resolve([]),
    onEvent: () => () => undefined,
  };
};

const bridge: MshhBridge = hasHost ? window.mshh! : createStubBridge();

/**
 * Module manifests. The renderer-side Matrix module is always present;
 * main-side manifests come from the host and never shadow it.
 */
export const listModules = async (): Promise<ModuleInfo[]> => {
  const hostModules = hasHost ? await window.mshh!.listModules().catch(() => []) : [];
  return [MATRIX_BUILTIN_MODULE, ...hostModules.filter((m) => m.id !== MATRIX_MODULE_ID)];
};

export const listProfiles = (): Promise<ProfileMeta[]> => bridge.listProfiles();
export const saveProfile = (p: {
  id?: string;
  moduleId: string;
  name: string;
  config: Record<string, unknown>;
}): Promise<{ id: string }> => bridge.saveProfile(p);
export const setProfileSecret = (id: string, key: string, value: string): Promise<void> =>
  bridge.setProfileSecret(id, key, value);
export const deleteProfile = (id: string): Promise<void> => bridge.deleteProfile(id);
export const setEnabled = (id: string, enabled: boolean): Promise<void> =>
  bridge.setEnabled(id, enabled);
export const connectProfile = (id: string): Promise<void> => bridge.connectProfile(id);
export const disconnectProfile = (id: string): Promise<void> => bridge.disconnectProfile(id);
export const submitAuth = (id: string, value: string): Promise<void> => bridge.submitAuth(id, value);
export const send = (id: string, chatId: string, text: string): Promise<string> =>
  bridge.send(id, chatId, text);
export const markRead = (id: string, chatId: string, messageId?: string): Promise<void> =>
  bridge.markRead(id, chatId, messageId);
export const setTyping = (id: string, chatId: string, on: boolean): Promise<void> =>
  bridge.setTyping(id, chatId, on);
export const getChats = (id: string): Promise<Chat[]> => bridge.getChats(id);
export const getMessages = (id: string, chatId: string): Promise<Msg[]> =>
  bridge.getMessages(id, chatId);
export const onEvent = (cb: Parameters<MshhBridge['onEvent']>[0]): (() => void) =>
  bridge.onEvent(cb);
