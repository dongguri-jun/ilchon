/**
 * Language names and which languages the app offers. No React, so Node checks
 * (scripts/check-i18n.ts) can read it.
 *
 * Names are written in their own language and are not translated, so they
 * live here and not in a string table.
 */
import { LANGS, type Lang } from '../contracts'

export const LANG_NAMES: Record<Lang, { short: string; name: string }> = {
  ko: { short: 'KO', name: '한국어' },
  en: { short: 'EN', name: 'English' },
  ja: { short: 'JA', name: '日本語' },
}

export const LANG_GROUP_LABEL = '언어 / Language / 言語'

/**
 * How far Japanese is released. 'off': Japanese only on the dev server. 'beta': offered as 日本語 (β),
 * safety strings must be AI cross-checked. 'reviewed': native speaker done. Read by check-i18n T8.
 * public/boot-splash.js keeps its own OFFERED list; check-i18n T14 checks that the two agree.
 */
export const JA_STAGE = 'off' as 'off' | 'beta' | 'reviewed'

/** True only on the Vite dev server. Node has no import.meta.env, so checks see the deploy value. */
function isDevServer(): boolean {
  return (import.meta as { env?: Record<string, unknown> }).env?.DEV === true
}

/** Languages the user can pick and that detection may choose. */
export function offeredLangs(): readonly Lang[] {
  if (isDevServer()) return LANGS
  return JA_STAGE === 'off' ? (['ko', 'en'] as const) : LANGS
}

/** '日本語 (β)' while Japanese is in beta. */
export function langLabel(l: Lang): string {
  return l === 'ja' && JA_STAGE !== 'reviewed' ? `${LANG_NAMES.ja.name} (β)` : LANG_NAMES[l].name
}

/** 'JAβ' while Japanese is in beta. */
export function langShort(l: Lang): string {
  return l === 'ja' && JA_STAGE !== 'reviewed' ? `${LANG_NAMES.ja.short}β` : LANG_NAMES[l].short
}

/**
 * Accessible name of a language button that shows langShort(l): 'KO 한국어'. It starts
 * with the visible code so voice control ("tap KO") finds it (WCAG 2.5.3, label in name).
 * check-a11y A2 checks this.
 */
export function langButtonLabel(l: Lang): string {
  return `${langShort(l)} ${langLabel(l)}`
}

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v)
}
