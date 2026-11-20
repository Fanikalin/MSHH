import React from 'react';
import { atom, getDefaultStore, useAtomValue } from 'jotai';
import { langAtom, MshhStringKey } from './i18n';

/**
 * MSHH interface preferences: screen font (--mshh-font) and accent theme
 * (--mshh-accent*) CSS variables, applied on the root div of the MSHH screens
 * (MshhIndex) and persisted in localStorage (mshh_font / mshh_accent).
 */

const LS_FONT = 'mshh_font';
const LS_ACCENT = 'mshh_accent';

export type MshhFontId = 'system' | 'arial' | 'georgia' | 'mono';

/** Web-safe font choices for the MSHH screens. */
export const MSHH_FONTS: { id: MshhFontId; labelKey: MshhStringKey; stack: string }[] = [
  { id: 'system', labelKey: 'font.system', stack: 'system-ui, sans-serif' },
  { id: 'arial', labelKey: 'font.arial', stack: 'Arial, Helvetica, sans-serif' },
  { id: 'georgia', labelKey: 'font.georgia', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'mono', labelKey: 'font.mono', stack: '"Courier New", monospace' },
];

export type MshhAccentId = 'violet' | 'emerald' | 'amber';

/** Accent themes: CSS variable values for `--mshh-accent`/-soft/-contrast. */
export const MSHH_ACCENTS: {
  id: MshhAccentId;
  labelKey: MshhStringKey;
  accent: string;
  soft: string;
  contrast: string;
}[] = [
  {
    id: 'violet',
    labelKey: 'accent.violet',
    accent: '#a78bfa',
    soft: 'rgba(167, 139, 250, 0.22)',
    contrast: '#16111f',
  },
  {
    id: 'emerald',
    labelKey: 'accent.emerald',
    accent: '#34d399',
    soft: 'rgba(52, 211, 153, 0.18)',
    contrast: '#0f1a14',
  },
  {
    id: 'amber',
    labelKey: 'accent.amber',
    accent: '#fbbf24',
    soft: 'rgba(251, 191, 36, 0.20)',
    contrast: '#1d1503',
  },
];

const store = getDefaultStore();

const readFont = (): MshhFontId => {
  try {
    const raw = localStorage.getItem(LS_FONT);
    return MSHH_FONTS.some((f) => f.id === raw) ? (raw as MshhFontId) : 'system';
  } catch {
    return 'system';
  }
};

const readAccent = (): MshhAccentId => {
  try {
    const raw = localStorage.getItem(LS_ACCENT);
    return MSHH_ACCENTS.some((a) => a.id === raw) ? (raw as MshhAccentId) : 'violet';
  } catch {
    return 'violet';
  }
};

export const fontAtom = atom<MshhFontId>(readFont());
export const accentAtom = atom<MshhAccentId>(readAccent());

/** Pick a screen font and persist it (localStorage mshh_font). */
export const setMshhFont = (id: MshhFontId): void => {
  try {
    localStorage.setItem(LS_FONT, id);
  } catch {
    /* current session only */
  }
  store.set(fontAtom, id);
};

/** Pick an accent theme and persist it (localStorage mshh_accent). */
export const setMshhAccent = (id: MshhAccentId): void => {
  try {
    localStorage.setItem(LS_ACCENT, id);
  } catch {
    /* current session only */
  }
  store.set(accentAtom, id);
};

/**
 * Wraps the whole MSHH route subtree: publishes the font and accent CSS
 * variables every MSHH screen can consume via var(--mshh-font)/var(--mshh-accent).
 */
export function MshhPrefsScope({ children }: { children: React.ReactNode }) {
  const fontId = useAtomValue(fontAtom);
  const accentId = useAtomValue(accentAtom);
  const lang = useAtomValue(langAtom);
  const font = MSHH_FONTS.find((f) => f.id === fontId) ?? MSHH_FONTS[0];
  const accent = MSHH_ACCENTS.find((a) => a.id === accentId) ?? MSHH_ACCENTS[0];

  return (
    <div
      lang={lang}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        fontFamily: 'var(--mshh-font)',
        ['--mshh-font' as string]: font.stack,
        ['--mshh-accent' as string]: accent.accent,
        ['--mshh-accent-soft' as string]: accent.soft,
        ['--mshh-accent-contrast' as string]: accent.contrast,
      }}
    >
      {children}
    </div>
  );
}
