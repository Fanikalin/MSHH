// MSHH Matrix module bridge — runtime: "renderer" (see docs/ARCHITECTURE.md).
//
// There is no main-process runner for Matrix: this bridge runs in the renderer
// and drives matrix-js-sdk directly (the SDK already ships with Cinny). It
// reuses the SAME access token/device as the native Cinny session (one device,
// two sync loops, read-only bridge) and never initializes Rust crypto.
//
// Matrix chats enter MSHH's unified chat list as metadata only (title, ts,
// unread) — no message events are emitted. Opening such a chat navigates to
// Cinny's native room view, where decryption and sending work as usual.

import {
  ClientEvent,
  createClient,
  IndexedDBCryptoStore,
  IndexedDBStore,
  MatrixClient,
  MatrixError,
  NotificationCountType,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk';
import type { Room, SyncStateData } from 'matrix-js-sdk';
import { getDefaultStore } from 'jotai';
import { patchProfile, profilesAtom, removeChat, upsertChat } from '../state';
import type { ChatKind, Profile } from '../types';

/** Cached bridge session, JSON-encoded in localStorage. */
type BridgeSession = {
  accessToken: string;
  userId: string;
  deviceId: string;
  baseUrl: string;
};

const CACHE_PREFIX = 'mshh_matrix_bridge_';
const SYNC_DB_PREFIX = 'mshh-matrix-bridge-';
const CRYPTO_DB_PREFIX = 'mshh-matrix-bridge-crypto-';
const UNREAD_CAP = 999;

function cacheKey(profileId: string) {
  return CACHE_PREFIX + profileId;
}

function readCache(profileId: string): BridgeSession | null {
  try {
    const raw = localStorage.getItem(cacheKey(profileId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BridgeSession>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.baseUrl !== 'string'
    ) {
      return null;
    }
    return parsed as BridgeSession;
  } catch {
    return null;
  }
}

function writeCache(profileId: string, session: BridgeSession) {
  try {
    localStorage.setItem(cacheKey(profileId), JSON.stringify(session));
  } catch {
    // quota/private mode — the bridge simply re-logins next boot
  }
}

function clearCache(profileId: string) {
  try {
    localStorage.removeItem(cacheKey(profileId));
  } catch {
    // ignore
  }
}

/** "user" | "@user" | "@user:hs.tld" + "https://hs.tld/" → "@user:hs.tld". */
function normalizeUserId(raw: string, baseUrl: string): string {
  let id = raw.trim();
  if (!id) return '';
  if (!id.startsWith('@')) id = `@${id}`;
  if (!id.includes(':')) {
    let serverName: string;
    try {
      serverName = new URL(baseUrl).hostname;
    } catch {
      serverName = 'matrix.org';
    }
    id += `:${serverName}`;
  }
  return id;
}

/** Accept "https://hs.tld" / "hs.tld"; return URL string without trailing slash. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Не указан homeserver. Укажите адрес, например https://matrix.org');
  }
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`Некорректный адрес homeserver: ${trimmed}`);
  }
  const s = parsed.toString();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function readableError(err: unknown): string {
  if (err instanceof MatrixError) {
    if (err.errcode === 'M_FORBIDDEN' || err.httpStatus === 403) {
      return 'Неверный логин или пароль (M_FORBIDDEN)';
    }
    if (err.errcode === 'M_USER_DEACTIVATED')
      return 'Учётная запись отключена (M_USER_DEACTIVATED)';
    if (err.httpStatus === 404) return 'Homeserver не найден. Проверьте адрес';
    return `Ошибка входа: ${err.errcode || err.message}`;
  }
  if (err instanceof TypeError) {
    return 'Не удалось связаться с homeserver. Проверьте адрес и подключение';
  }
  return err instanceof Error ? err.message : String(err);
}

function isInvalidToken(err: Error | undefined): err is MatrixError {
  if (!(err instanceof MatrixError)) return false;
  return (
    err.errcode === 'M_UNKNOWN_TOKEN' || err.errcode === 'M_INVALID_TOKEN' || err.httpStatus === 401
  );
}

/** Only these fields affect the bridge; other profile edits must not restart it. */
function relevantConfig(p: Profile): string {
  return JSON.stringify([p.config.homeserver, p.config.userId, p.config.password]);
}

class MatrixBridge {
  private profile!: Profile;

  private baseUrl = '';

  private client: MatrixClient | null = null;

  private store: IndexedDBStore | null = null;

  private roomIds = new Set<string>();

  private stopped = false;

  private retriedLogin = false;

  private appliedConfig = '';

  matchesConfig(p: Profile): boolean {
    return this.appliedConfig === relevantConfig(p);
  }

  async start(profile: Profile): Promise<void> {
    this.profile = profile;
    this.appliedConfig = relevantConfig(profile);
    patchProfile(profile.id, { status: 'connecting', lastError: null });
    try {
      this.baseUrl = normalizeBaseUrl(String(profile.config.homeserver ?? ''));
      const cached = readCache(profile.id);
      if (cached && cached.baseUrl === this.baseUrl) {
        await this.startWithSession(profile.id, cached);
        return;
      }
      await this.loginAndStart();
    } catch (err) {
      if (this.stopped) return;
      patchProfile(profile.id, { status: 'error', lastError: readableError(err) });
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.teardownClient();
    this.roomIds.forEach((roomId) => {
      removeChat(this.profile.id, roomId);
    });
    this.roomIds.clear();
  }

  private teardownClient() {
    const { client } = this;
    const { store } = this;
    this.client = null;
    this.store = null;
    if (client) {
      client.stopClient();
      client.removeAllListeners(ClientEvent.Sync);
      client.removeAllListeners(ClientEvent.Room);
      client.removeAllListeners(RoomEvent.Name);
      client.removeAllListeners(RoomEvent.Timeline);
    }
    if (store) store.destroy(); // close the IndexedDB connection (data kept)
  }

  /** Password login → cache session → start working client. */
  private async loginAndStart(): Promise<void> {
    const { id, config } = this.profile;
    const userId = normalizeUserId(String(config.userId ?? ''), this.baseUrl);
    const password = String(config.password ?? '');
    if (!userId || !password) {
      throw new Error('Укажите homeserver, имя пользователя и пароль в настройках профиля');
    }
    const loginClient = createClient({ baseUrl: this.baseUrl });
    const res = await loginClient.login('m.login.password', {
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: 'MSHH',
    });
    const session: BridgeSession = {
      accessToken: res.access_token,
      userId: res.user_id,
      deviceId: res.device_id,
      baseUrl: this.baseUrl,
    };
    writeCache(id, session);
    if (this.stopped) return;
    await this.startWithSession(id, session);
  }

  /** Working client on a cached or fresh token. Own DB names, no Rust crypto. */
  private async startWithSession(profileId: string, session: BridgeSession): Promise<void> {
    const store = new IndexedDBStore({
      indexedDB: globalThis.indexedDB,
      localStorage: globalThis.localStorage,
      dbName: SYNC_DB_PREFIX + profileId,
    });
    const client = createClient({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
      store,
      cryptoStore: new IndexedDBCryptoStore(globalThis.indexedDB, CRYPTO_DB_PREFIX + profileId),
    });
    this.store = store;
    this.client = client;
    client.on(ClientEvent.Sync, this.onSync);
    client.on(ClientEvent.Room, this.onRoom);
    client.on(RoomEvent.Name, this.onRoom);
    client.on(RoomEvent.Timeline, (_event, room) => {
      if (room) this.onRoom(room);
    });
    await store.startup();
    if (this.stopped) return;
    await client.startClient({ lazyLoadMembers: false, initialSyncLimit: 20 });
  }

  private onSync = (state: SyncState, _prevState: SyncState | null, data?: SyncStateData) => {
    if (this.stopped || !this.client) return;
    if (state === SyncState.Prepared) {
      patchProfile(this.profile.id, { status: 'online', lastError: null });
      this.client.getRooms().forEach((room) => {
        this.upsertRoom(room);
      });
    } else if (state === SyncState.Error) {
      const err = data?.error;
      if (isInvalidToken(err) && !this.retriedLogin) {
        // cached token died: drop it and re-login once, while password is known
        clearCache(this.profile.id);
        this.retriedLogin = true;
        this.teardownClient();
        patchProfile(this.profile.id, { status: 'connecting', lastError: null });
        this.loginAndStart().catch((loginErr) => {
          if (!this.stopped) {
            patchProfile(this.profile.id, { status: 'error', lastError: readableError(loginErr) });
          }
        });
        return;
      }
      patchProfile(this.profile.id, {
        status: 'error',
        lastError: err?.message || 'Ошибка синхронизации с homeserver',
      });
    }
  };

  private onRoom = (room: Room) => {
    if (!this.stopped) this.upsertRoom(room);
  };

  /** Chat metadata only — Matrix chats open in Cinny's native room view. */
  private upsertRoom(room: Room) {
    if (this.stopped || !this.client) return;
    this.roomIds.add(room.roomId);

    const dmCount =
      room.getMembers().filter((m) => m.userId !== this.client?.getUserId()).length === 1;
    let kind: ChatKind;
    if (room.isSpaceRoom()) {
      kind = 'channel';
    } else if (dmCount) {
      kind = 'dm';
    } else {
      kind = 'group';
    }

    const lastEvent = room.timeline[room.timeline.length - 1];
    const ts = lastEvent?.getTs() || room.getLastActiveTimestamp() || Date.now();
    const unread = Math.min(
      room.getUnreadNotificationCount(NotificationCountType.Highlight) +
        room.getUnreadNotificationCount(NotificationCountType.Total),
      UNREAD_CAP
    );

    // avatarPath stays unset on purpose: the bridge cannot store files via
    // mshh-media, and the chat nav falls back to a colored initial.
    upsertChat({
      id: room.roomId,
      profileId: this.profile.id,
      kind,
      title: room.name || room.roomId,
      ts,
      unread,
    });
  }
}

const bridges = new Map<string, MatrixBridge>();

/** Align live bridges with the current profile list (enable/disable/edit/remove). */
function reconcile(profiles: Profile[]) {
  profiles
    .filter((profile) => profile.moduleId === 'matrix')
    .forEach((profile) => {
      const live = bridges.get(profile.id);
      if (!profile.enabled) {
        if (live) {
          bridges.delete(profile.id);
          live.stop();
          patchProfile(profile.id, { status: 'disabled' });
        }
      } else if (!live) {
        const bridge = new MatrixBridge();
        bridges.set(profile.id, bridge);
        bridge.start(profile);
      } else if (!live.matchesConfig(profile)) {
        bridges.delete(profile.id);
        live.stop();
        const bridge = new MatrixBridge();
        bridges.set(profile.id, bridge);
        bridge.start(profile);
      }
    });
  bridges.forEach((bridge, profileId) => {
    if (!profiles.some((p) => p.id === profileId)) {
      bridges.delete(profileId);
      bridge.stop(); // profile removed: also wipes its chats from the unified list
    }
  });
}

let started = false;

/**
 * Subscribe the bridge to profile changes. Idempotent; call once at app boot.
 * Initial state is reconciled immediately, so profiles created before this
 * call (or restored from profiles.json) connect right away.
 */
export function startMatrixBridges(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const store = getDefaultStore();
  store.sub(profilesAtom, () => reconcile(store.get(profilesAtom)));
  reconcile(store.get(profilesAtom));
}
