/**
 * Text of the crash screen. Kept out of registerStrings on purpose: it has to
 * render when anything else has failed. No React or CSS here, so Node checks can
 * read it. Japanese is optional; a missing entry shows English.
 */
export interface CrashCopy {
  title: string
  body: string
  reload: string
}

export const COPY: { ko: CrashCopy; en: CrashCopy } & { ja?: CrashCopy } = {
  ko: { title: '문제가 생겼어요', body: '화면을 표시하지 못했어요. 새로고침해 주세요.', reload: '새로고침' },
  en: { title: 'Something went wrong', body: 'This screen couldn’t be shown. Please reload.', reload: 'Reload' },
  ja: { title: '問題が発生しました', body: '画面を表示できませんでした。再読み込みしてください。', reload: '再読み込み' },
}
