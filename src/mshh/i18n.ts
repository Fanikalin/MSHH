import { atom, getDefaultStore, useAtomValue } from 'jotai';

/** MSHH screen language (persisted in localStorage mshh_lang). */
export type MshhLang = 'ru' | 'en';

const LS_LANG = 'mshh_lang';

const RU = {
  'tab.general': 'Общие',
  'tab.modules': 'Модули',
  'tab.profiles': 'Профили',
  'settings.title': 'Настройки',
  'back.toChats': 'Назад к чатам',
  'nav.profiles': 'Менеджер профилей',
  'nav.settings': 'Настройки',
  'general.zoom': 'Масштаб интерфейса',
  'general.zoomDesc': 'Применяется ко всему приложению и сохраняется между запускам',
  'general.reset': 'Сбросить',
  'general.font': 'Шрифт интерфейса',
  'general.fontDesc': 'Шрифт экранов MSHH; применяется сразу и сохраняется',
  'general.accent': 'Акцентный цвет',
  'general.accentDesc': 'Тема акцента экранов MSHH',
  'general.language': 'Язык интерфейса',
  'general.languageDesc': 'Язык строк экранов MSHH',
  'profiles.empty': 'Профилей пока нет',
  'module.noFields': 'У модуля нет полей связи',
  'profiles.title': 'Профили',
  'profiles.add': 'Добавить профиль',
  'profiles.noDescription': 'Описание не задано',
  'profiles.deleteTitle': 'Удалить профиль',
  'profiles.deleteWarn':
    'Профиль «{name}» и его данные сессии будут удалены безвозвратно.',
  'profiles.changeAvatar': 'Сменить аватарку',
  'profile.namePlaceholder': 'Имя профиля',
  'profile.descriptionPlaceholder': 'Описание',
  'action.edit': 'Изменить',
  'action.save': 'Сохранить',
  'action.cancel': 'Отмена',
  'action.delete': 'Удалить',
  'action.connect': 'Подключить',
  'action.disconnect': 'Отключить',
  'action.reconnect': 'Переподключить',
  'chat.title': 'Чат',
  'chat.matrixTitle': 'Матричный чат',
  'chat.matrixDesc': 'Матричные чаты открываются в нативном клиенте Cinny',
  'chat.openInCinny': 'Открыть в Cinny',
  'chat.back': 'Назад',
  'chat.placeholder': 'Сообщение',
  'chat.attach': 'Прикрепить файл',
  'chat.send': 'Отправить',
  'chat.sending': 'отправляется…',
  'chat.sendFailed': 'Ошибка отправки',
  'chat.edited': '(изменено)',
  'chat.typing': 'печатает…',
  'chat.typingWho': '{who} печатает…',
  'chat.removeFile': 'Убрать файл',
  'file.fallback': 'Файл',
  'peer.cardTitle': 'Профиль чата',
  'peer.close': 'Закрыть',
  'peer.loading': 'Загрузка…',
  'peer.unsupported': 'Модуль не поддерживает просмотр профиля',
  'font.system': 'Системный',
  'font.arial': 'Arial',
  'font.georgia': 'Georgia',
  'font.mono': 'Моноширинный',
  'accent.violet': 'Фиолетовый',
  'accent.emerald': 'Изумрудный',
  'accent.amber': 'Янтарный',
} as const;

export type MshhStringKey = keyof typeof RU;

const EN: Record<MshhStringKey, string> = {
  'tab.general': 'General',
  'tab.modules': 'Modules',
  'tab.profiles': 'Profiles',
  'settings.title': 'Settings',
  'back.toChats': 'Back to chats',
  'nav.profiles': 'Profile manager',
  'nav.settings': 'Settings',
  'general.zoom': 'Interface zoom',
  'general.zoomDesc': 'Applies to the whole app and persists between launches',
  'general.reset': 'Reset',
  'general.font': 'Interface font',
  'general.fontDesc': 'Font of the MSHH screens; applies instantly and persists',
  'general.accent': 'Accent color',
  'general.accentDesc': 'Accent theme of the MSHH screens',
  'general.language': 'Interface language',
  'general.languageDesc': 'Language of the MSHH screen strings',
  'profiles.empty': 'No profiles yet',
  'module.noFields': 'The module has no connection fields',
  'profiles.title': 'Profiles',
  'profiles.add': 'Add profile',
  'profiles.noDescription': 'No description',
  'profiles.deleteTitle': 'Delete profile',
  'profiles.deleteWarn':
    'Profile “{name}” and its session data will be deleted permanently.',
  'profiles.changeAvatar': 'Change avatar',
  'profile.namePlaceholder': 'Profile name',
  'profile.descriptionPlaceholder': 'Description',
  'action.edit': 'Edit',
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.delete': 'Delete',
  'action.connect': 'Connect',
  'action.disconnect': 'Disconnect',
  'action.reconnect': 'Reconnect',
  'chat.title': 'Chat',
  'chat.matrixTitle': 'Matrix chat',
  'chat.matrixDesc': 'Matrix chats open in the native Cinny client',
  'chat.openInCinny': 'Open in Cinny',
  'chat.back': 'Back',
  'chat.placeholder': 'Message',
  'chat.attach': 'Attach file',
  'chat.send': 'Send',
  'chat.sending': 'sending…',
  'chat.sendFailed': 'Failed to send',
  'chat.edited': '(edited)',
  'chat.typing': 'typing…',
  'chat.typingWho': '{who} is typing…',
  'chat.removeFile': 'Remove file',
  'file.fallback': 'File',
  'peer.cardTitle': 'Chat profile',
  'peer.close': 'Close',
  'peer.loading': 'Loading…',
  'peer.unsupported': 'The module does not provide a peer profile',
  'font.system': 'System',
  'font.arial': 'Arial',
  'font.georgia': 'Georgia',
  'font.mono': 'Monospace',
  'accent.violet': 'Violet',
  'accent.emerald': 'Emerald',
  'accent.amber': 'Amber',
};

const DICT: Record<MshhLang, Record<MshhStringKey, string>> = { ru: RU, en: EN };

const store = getDefaultStore();

const readLang = (): MshhLang => {
  try {
    const raw = localStorage.getItem(LS_LANG);
    return raw === 'en' || raw === 'ru' ? raw : 'ru';
  } catch {
    return 'ru';
  }
};

/** Subscribable language state; `t` reads its current value. */
export const langAtom = atom<MshhLang>(readLang());

/** Switch the MSHH screen language and persist it (localStorage mshh_lang). */
export const setMshhLang = (lang: MshhLang): void => {
  try {
    localStorage.setItem(LS_LANG, lang);
  } catch {
    /* no localStorage — current session only */
  }
  store.set(langAtom, lang);
};

/** Translate a MSHH screen string ({var} placeholders filled from vars). */
export const t = (key: MshhStringKey, vars?: Record<string, string | number>): string => {
  const text = DICT[store.get(langAtom)][key];
  if (!vars) return text;
  return Object.entries(vars).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    text
  );
};

/** Hook: subscribe the component to language changes, return the translator. */
export const useMshhT = (): typeof t => {
  useAtomValue(langAtom);
  return t;
};
