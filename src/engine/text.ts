import type { Currency, Lang } from '../contracts'

/**
 * Text of system messages in a room. The engine has no access to the UI string
 * tables, so these are written once, in the language active when they happen.
 */

export function money(amount: number, currency: Currency, lang: Lang): string {
  const n = amount.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 })
  if (currency === 'KRW') return lang === 'ko' ? `${n}원` : `₩${n}`
  return `$${n}`
}

export const systemText = {
  matched(lang: Lang): string {
    return lang === 'ko' ? '서로 조건이 맞았어요. 여기서 거래를 이야기해 보세요.' : 'Your offers match. You can arrange the trade here.'
  },
  doneMine(lang: Lang, amount: number, currency: Currency): string {
    const m = money(amount, currency, lang)
    return lang === 'ko' ? `${m} 거래를 완료로 표시했어요.` : `You marked ${m} as done.`
  },
  doneTheirs(lang: Lang, amount: number, currency: Currency): string {
    const m = money(amount, currency, lang)
    return lang === 'ko' ? `상대가 ${m} 거래를 완료로 표시했어요.` : `They marked ${m} as done.`
  },
}
