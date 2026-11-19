/**
 * Japanese glossary: tone, terms, words to avoid. The one copy.
 * Read by the table script
 * (pnpm i18n:table --json, for AI drafts), and by check-i18n T9 (words to avoid,
 * do-not-translate words).
 *
 * check: 확정 = decided for this app, 앱 확인 = seen in public open-source
 * translations, 미확인 = to ask the native-speaker reviewer, 지인 확인 = the reviewer confirmed it.
 */

export const TONE =
  'です・ます体. 버튼과 제목은 명사나 동사 원형(条件を登録, 閉じる, 削除). 설명은 〜します, 〜できません. ' +
  '오류는 원인 뒤에 다음 행동(もう一度お試しください). 경고는 원문의 세기를 지킨다(꼭 → 必ず, 하지 마세요 → 〜しないでください). ' +
  '사람 이름은 {name}さん. 문장부호 、。, 전각 ？！, 따옴표 「」, 구분 기호 ・(U+30FB), 숫자와 라틴 문자는 반각. ' +
  '끝에 공백이 있는 채팅 머리글은 전각 콜론으로 끝내고 공백을 두지 않는다(振込先：).'

export type Term = {
  ko: string
  en?: string
  ja: string
  /** Wording for the first place the term appears. */
  jaFirst?: string
  /** Do not translate: if the Korean has it, the Japanese keeps it as is. */
  dnt?: boolean
  check: '확정' | '앱 확인' | '미확인' | '지인 확인'
  note?: string
}

export const TERMS: Term[] = [
  { ko: '일촌', en: 'contact(s)', ja: 'イルチョン', check: '확정', note: 'shell.intro1, contacts.emptyBody에서 뜻을 한 번 풀어 준다' },
  {
    ko: '청구서(인보이스)',
    en: 'invoice',
    ja: 'インボイス',
    jaFirst: 'ライトニングインボイス',
    check: '확정',
    note: '처음 나오는 곳 = room.invLabel, room.sendLightning, room.sellPay, room.msgAskInvoice, board.buyerHint, board.sellerHint (room.buyInvoice는 "받을 곳"이 되어 빠졌다). 請求書는 피할 말',
  },
  { ko: '말투', ja: 'です・ます体', check: '확정' },
  { ko: '맞는 일촌 / 매칭', en: 'matches', ja: '条件が合うイルチョン / 一致', check: '미확인', note: 'マッチング은 데이트 앱으로 읽힐 수 있다(추론)' },
  { ko: '조건 / 올리기 / 내리기', en: 'offer / Post / Withdraw', ja: '条件 / 条件を登録 / 取り下げる', check: '미확인' },
  { ko: '게시판(탭)', en: 'Board', ja: '条件一覧', check: '미확인', note: '掲示板은 익명 게시판을 떠올린다(추론)' },
  { ko: '삽니다 / 팝니다', en: 'Buying / Selling', ja: '買います / 売ります', check: '미확인' },
  { ko: '구매자 / 판매자', en: 'buyer / seller', ja: '買い手 / 売り手', check: '앱 확인' },
  { ko: '거래방', en: 'trade room', ja: '取引ルーム', check: '미확인' },
  { ko: '수수료(시세 대비 %)', en: 'fee', ja: '相場との差（%）', check: '미확인', note: '手数料는 서비스 요금으로 읽힌다' },
  { ko: '시세', en: 'market price', ja: '相場', check: '미확인' },
  { ko: '중계 서버', en: 'relay', ja: 'リレー', jaFirst: 'リレー（中継サーバー）', check: '앱 확인', note: '설정에서 한 번 リレー（中継サーバー）' },
  { ko: '연결하기(일촌 맺기) / 연결(네트워크)', en: 'Connect / connection', ja: 'つながる / 接続', check: '미확인' },
  { ko: '잠금 / 잠금 해제', en: 'lock / unlock', ja: 'ロック / ロック解除', check: '미확인' },
  { ko: '키 / 비밀키 / 공개키', en: 'key / secret key / public key', ja: '鍵 / 秘密鍵 / 公開鍵', check: '앱 확인', note: 'キー는 키보드 키와 헷갈린다. 앱 확인은 秘密鍵' },
  { ko: '패스키 / 비밀번호', en: 'passkey / password', ja: 'パスキー / パスワード', check: '미확인' },
  {
    ko: '12단어 / 12단어 적기 / 12단어로 되살리기',
    en: '12 words / write down the 12 words / restore with the 12 words',
    ja: '英単語12個（リカバリーフレーズ） / 12個の単語を書き留める / 12個の単語で復元',
    check: '미확인',
    note: '비밀번호 백업 코드는 없다. 키를 되살리는 길은 12단어 하나뿐이다. 단어 목록은 영어 고정(BIP-39). 復元은 Bitcoin Core의 restore 번역과 같다',
  },
  { ko: 'PIN', en: 'PIN', ja: 'PIN', jaFirst: '6桁のPIN', check: '앱 확인', note: '暗証番号 아님' },
  { ko: '지갑', en: 'wallet', ja: 'ウォレット', check: '앱 확인', note: '財布 아님' },
  { ko: '라이트닝 / 온체인 / 메인넷', ja: 'ライトニング / オンチェーン / メインネット', check: '미확인' },
  { ko: '결제하다(청구서)', en: 'pay', ja: '支払う', check: '미확인' },
  { ko: '계좌 / 계좌이체', en: 'account / bank transfer', ja: '口座 / 銀行振込', check: '앱 확인', note: '앱 확인은 銀行振込' },
  {
    ko: '입금할 계좌(받는 쪽)',
    en: 'bank account (to pay into)',
    ja: '振込先',
    check: '미확인',
    note: 'chipAskAccount, chipSendAccount, msgAskAccount, msgSendAccount(振込先：), askAccount, sellAccount, writeAccount',
  },
  { ko: '이체하기', en: 'transfer', ja: '振込 / 振り込む', check: '미확인', note: 'buyTransfer' },
  { ko: '입금 확인', en: 'confirm deposit', ja: '入金確認', check: '미확인', note: 'sellVerify' },
  {
    ko: '입금자명 / 예금주',
    en: "sender's name / account holder",
    ja: '振込名義 / 口座名義',
    check: '미확인',
    note: 'verifyName, doneNotice2. 일본 입금 내역의 이름은 가타카나가 많다(추론)',
  },
  { ko: '거래 완료 / 완료로 표시', en: 'mark as done', ja: '取引完了 / 完了にする', check: '미확인' },
  { ko: '만료 / 초기화 / 삭제', en: 'expired / reset / delete', ja: '期限切れ / 初期化 / 削除', check: '미확인' },
  {
    ko: '원화 / 달러 / 엔화',
    en: 'KRW / USD / JPY',
    ja: '韓国ウォン / 米ドル / 日本円',
    check: '미확인',
    note: '키는 board.curJPY, optJPY, addJPY0~3, room.JPY. 빠른 더하기 값 +1万 +5万 +10万 +50万은 확정, 이름은 미확인',
  },
  // Do not translate (dnt).
  { ko: 'ilchon', ja: 'ilchon', dnt: true, check: '확정' },
  { ko: 'sats', ja: 'sats', dnt: true, check: '확정' },
  { ko: 'BTC', ja: 'BTC', dnt: true, check: '확정' },
  { ko: 'QR', ja: 'QR', dnt: true, check: '확정' },
  { ko: 'Nostr', ja: 'Nostr', dnt: true, check: '확정' },
  { ko: 'NIP-05', ja: 'NIP-05', dnt: true, check: '확정' },
  { ko: 'npub', ja: 'npub', dnt: true, check: '확정' },
  { ko: 'Face ID', ja: 'Face ID', dnt: true, check: '확정' },
]

/**
 * Words the Japanese should not use. fail: true fails check-i18n T9; the rest warn,
 * since they can be right in some contexts (only 請求書 fails).
 */
export const AVOID: { ja: string; fail: boolean; note: string }[] = [
  { ja: '請求書', fail: true, note: 'インボイス' },
  { ja: 'マッチング', fail: false, note: '一致, 条件が合う' },
  { ja: '手数料', fail: false, note: '수수료(시세 대비 %) 뜻일 때: 相場との差' },
  { ja: '掲示板', fail: false, note: '条件一覧' },
  { ja: '財布', fail: false, note: 'ウォレット' },
  { ja: '暗証番号', fail: false, note: 'PIN' },
  { ja: 'キー', fail: false, note: '鍵' },
]

/**
 * The AVOID entries a Japanese value really uses. An avoided word inside an approved
 * glossary word does not count: キー inside パスキー (passkey, a TERMS wording) is not
 * the keyboard-key キー. Those approved words are masked first; a bare キー elsewhere
 * in the same value still counts.
 */
export function avoidedIn(ja: string): typeof AVOID {
  const approved = TERMS.flatMap((t) => [t.ja, t.jaFirst ?? ''])
    .flatMap((w) => w.split('/'))
    .map((w) => w.trim())
    .filter(Boolean)
  return AVOID.filter((a) => {
    let rest = ja
    for (const w of approved) if (w !== a.ja && w.includes(a.ja)) rest = rest.split(w).join('\u0000')
    return rest.includes(a.ja)
  })
}

/** Words kept as is in Japanese (dnt terms). */
export function dntWords(): string[] {
  return TERMS.filter((t) => t.dnt).map((t) => t.ko)
}
