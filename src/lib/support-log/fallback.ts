/**
 * The language of the support log's own button and header when the engine never
 * loaded: the browser's, from detectLang(). Nothing is read from storage
 * (no saved language before unlock). DOM only, no React.
 */
import type { Lang } from '../../contracts'
import { detectLang } from '../../i18n/detect'

export function fallbackLang(): Lang {
  return detectLang()
}
