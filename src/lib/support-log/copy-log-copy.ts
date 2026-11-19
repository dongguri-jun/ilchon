/**
 * Text of the "Copy log" button. Kept out of registerStrings on purpose: the button
 * has to work on screens where everything else failed (crash screen, the plain DOM
 * button when React never started). No React or CSS here.
 *
 * Korean and English are required, Japanese optional: a missing
 * entry shows English. Japanese is written here by hand and listed in
 * 번역/context.json `outside`.
 */
export interface CopyLogCopy {
  /** The button. */
  copy: string
  /** For two seconds after a copy that worked. */
  copied: string
  /** For two seconds after a copy that failed. */
  failed: string
}

export const COPY: { ko: CopyLogCopy; en: CopyLogCopy } & { ja?: CopyLogCopy } = {
  ko: { copy: '기록 복사', copied: '복사했어요', failed: '복사하지 못했어요' },
  en: { copy: 'Copy log', copied: 'Copied', failed: "Couldn't copy" },
  ja: { copy: 'ログをコピー', copied: 'コピーしました', failed: 'コピーできませんでした' },
}
