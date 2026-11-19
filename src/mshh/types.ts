// Types mirroring docs/mshh/MODULE_API.md — the canonical contract.
// If code disagrees with the docs, the docs win.

import type { Atom, WritableAtom } from 'jotai';

/** Minimal jotai store contract (getDefaultStore() return) used by non-React code. */
export interface MshhStore {
  get<Value>(atom: Atom<Value>): Value;
  set<Value, Args extends unknown[], Result>(
    atom: WritableAtom<Value, Args, Result>,
    ...args: Args
  ): Result;
}

export type ProfileStatus = 'connecting' | 'online' | 'offline' | 'auth-pending';

export type ModuleFieldType = 'string' | 'secret' | 'number' | 'boolean' | 'select';

export interface ModuleFieldOption {
  value: string;
  label: string;
}

export interface ModuleProfileField {
  key: string;
  label: string;
  type: ModuleFieldType;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: ModuleFieldOption[];
  default?: string | number | boolean;
}

export type ModuleAuthType = 'none' | 'qr' | 'code' | 'builtin-login';

export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  side: 'main' | 'renderer';
  description?: string;
  icon?: string;
  auth?: { type: ModuleAuthType };
  profileFields?: ModuleProfileField[];
}

export interface ProfileMeta {
  id: string;
  moduleId: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ChatLastMessage {
  id: string;
  text: string;
  ts: number;
  out: boolean;
  senderName?: string;
}

export interface Chat {
  chatId: string;
  name?: string;
  avatar?: string;
  unread?: number;
  pinned?: boolean;
  muted?: boolean;
  lastMessage?: ChatLastMessage;
}

export interface Msg {
  chatId?: string;
  id: string;
  text: string;
  ts: number;
  out: boolean;
  senderName?: string;
  mediaUrl?: string;
}

export type AuthPrompt =
  | { type: 'qr'; dataUrl: string }
  | { type: 'code'; hint?: string }
  | { type: 'error'; message: string };

export type MshhEventName =
  | 'status'
  | 'auth'
  | 'chats'
  | 'message'
  | 'chat-update'
  | 'typing'
  | 'receipt'
  | 'error';

export interface MshhEvent {
  profileId: string;
  event: MshhEventName;
  payload: unknown;
}

export interface MshhBridge {
  listModules(): Promise<ModuleInfo[]>;
  listProfiles(): Promise<ProfileMeta[]>;
  saveProfile(p: { id?: string; moduleId: string; name: string; config: Record<string, unknown> }): Promise<{ id: string }>;
  setProfileSecret(id: string, key: string, value: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  connectProfile(id: string): Promise<void>;
  disconnectProfile(id: string): Promise<void>;
  submitAuth(id: string, value: string): Promise<void>;
  send(id: string, chatId: string, text: string): Promise<string>;
  markRead(id: string, chatId: string, messageId?: string): Promise<void>;
  setTyping(id: string, chatId: string, on: boolean): Promise<void>;
  getChats(id: string): Promise<Chat[]>;
  getMessages(id: string, chatId: string): Promise<Msg[]>;
  onEvent(cb: (ev: MshhEvent) => void): () => void;
}

declare global {
  interface Window {
    mshh?: MshhBridge;
  }
}

export const MATRIX_MODULE_ID = 'matrix';

export const matrixProfileId = (userId: string): string => `matrix:${userId}`;

export const isMatrixProfileId = (id: string): boolean => id.startsWith(`${MATRIX_MODULE_ID}:`);
