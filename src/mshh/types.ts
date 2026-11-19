// MSHH renderer — shared types (mirror of electron/core/contract.cjs + IPC state)

export type ChatKind = 'dm' | 'group' | 'channel';

export type Chat = {
  id: string;
  profileId: string;
  kind: ChatKind;
  title: string;
  subtitle?: string;
  ts: number;
  unread: number;
  muted?: boolean;
  avatarPath?: string;
};

export type MessageMedia = {
  kind: 'image' | 'file' | 'audio' | 'video';
  name?: string;
  mime?: string;
  size?: number;
  path?: string;
};

export type Message = {
  id: string;
  chatId: string;
  profileId: string;
  senderId: string;
  senderName?: string;
  ts: number;
  out: boolean;
  text?: string;
  media?: MessageMedia;
  replyTo?: string;
  edited?: boolean;
  pending?: boolean;
};

export type ProfileStatus = 'disabled' | 'offline' | 'connecting' | 'online' | 'error' | 'renderer';

export type ConfigValue = string | number | boolean;

export type Profile = {
  id: string;
  moduleId: string;
  name: string;
  enabled: boolean;
  config: Record<string, ConfigValue>;
  createdAt: number;
  /** runtime-enriched */
  status: ProfileStatus;
  lastError: string | null;
  runtime: 'main' | 'renderer';
  moduleName: string;
  /** модуль ждёт ввод пользователя (QR/код) */
  pendingPrompt?: boolean;
};

export type ModuleField = {
  name: string;
  label?: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
};

export type ModuleManifest = {
  id: string;
  name: string;
  version?: string;
  runtime: 'main' | 'renderer';
  auth?: 'password' | 'token' | 'qr' | 'custom';
  fields?: ModuleField[];
  capabilities?: { media?: boolean; history?: boolean; typing?: boolean };
};

export type MshhEvent =
  | { profileId: string; type: 'chat'; payload: Chat }
  | { profileId: string; type: 'chat-remove'; payload: { id: string } }
  | { profileId: string; type: 'message'; payload: Message }
  | { profileId: string; type: 'message-edit'; payload: Message }
  | { profileId: string; type: 'typing'; payload: { chatId: string; who?: string } }
  | { profileId: string; type: 'status'; payload: { state: ProfileStatus; error?: string } }
  | {
      profileId: string;
      type: 'prompt';
      payload: {
        promptId: string;
        kind: 'code' | 'text' | 'qr';
        title?: string;
        detail?: string;
        qrBase64?: string;
      };
    };

export type MshhState = {
  appVersion: string;
  platform: string;
  profiles: Profile[];
  modules: ModuleManifest[];
  /** значения из app-defaults.json модулей (персональная сборка) */
  moduleDefaults?: Record<string, Record<string, string | number | boolean>>;
};
