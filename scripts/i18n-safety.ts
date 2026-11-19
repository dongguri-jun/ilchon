/**
 * Safety strings: money, keys, irreversible actions, scam warnings, privacy promises.
 * Written by hand. The one list of them.
 *
 * Only key names and categories live here. Whether a key's Japanese passed the AI
 * cross-check is in 번역/ja-status.json (aiCheck), never here.
 *
 * A PR that adds a string in one of these categories adds its key here too, or the
 * cross-check rule (check-i18n T8) never sees it. check-i18n T6 fails on a key that is
 * not in the string tables (renamed or removed).
 */

export type SafetyCategory = 'key-backup' | 'reset-delete' | 'payment-steps' | 'payer-name' | 'scam-warning' | 'privacy-promise'

/** Shown in the table's safety column and the review page. */
export const SAFETY_CATEGORIES: Record<SafetyCategory, { ko: string; ja: string }> = {
  'key-backup': { ko: '키 보관, 백업, 복원', ja: '鍵の保管・バックアップ・復元' },
  'reset-delete': { ko: '초기화, 삭제', ja: '初期化・削除' },
  'payment-steps': { ko: '송금, 청구서·주소 확인, 순서, 완료', ja: '送金・インボイスの確認・手順・完了' },
  'payer-name': { ko: '입금자 이름 확인', ja: '振込名義の確認' },
  'scam-warning': { ko: '사기·사칭 경고', ja: '詐欺・なりすましの警告' },
  'privacy-promise': { ko: '프라이버시 약속', ja: 'プライバシーの約束' },
}

/** `namespace.key`, as the string tables register them. */
export const SAFETY_KEYS: Record<SafetyCategory, readonly string[]> = {
  'key-backup': [
    'lock.chooseBody',
    'lock.lockScope',
    'lock.choosePasskeyHelp',
    'lock.passkeyMissingHint',
    // The 12 words are the one backup.
    'lock.pathNewHelp',
    'lock.wordsTitle',
    'lock.wordsBody',
    'lock.wordsSaved',
    'lock.errMnemonic',
    // Restoring from the 12 words.
    'lock.pathRestore',
    'lock.pathRestoreHelp',
    'lock.restoreNotFound',
    'lock.restoreContinue',
    'settings.secretWords',
    'settings.wordsSheetTitle',
    'settings.wordsSheetWarn',
    // The PIN lock and what it costs to lose it.
    'lock.choosePinHelp',
    'lock.errPinWait',
    'lock.errWeakPin',
    'lock.errStorageDamaged',
    'lock.errStorageUnavailable',
    'lock.errCorrupt',
    'lock.errPrfUnlock',
    'lock.errPasskeyMismatch',
    'lock.reauthPasskeyBody',
    'settings.lockNoneBadge',
    'install.iosWarn',
  ],
  'reset-delete': [
    'lock.resetTitle',
    'lock.resetBody',
    'lock.resetConfirm',
    'settings.resetHelp',
    'settings.resetTitle',
    'settings.resetBody',
    'settings.resetConfirm',
    'shell.resetFailedBody',
    // Stored data that cannot be read, and its reset.
    'shell.storageDamagedTitle',
    'shell.storageDamagedBody',
    'shell.storageReset',
    // The key was restored on another device; this one stops.
    'shell.replacedTitle',
    'shell.replacedBody',
    'shell.replacedRestore',
    'shell.storageUnavailableBody',
    'contacts.deleteTitle',
    'contacts.deleteBody',
    'contacts.deleteConfirm',
    'board.withdrawBody',
  ],
  'payment-steps': [
    'room.buyInvoice',
    'room.buyTransfer',
    'room.sellPay',
    'room.sellDone',
    'room.invoiceShared',
    'room.invoiceReceived',
    'room.invoiceWaitDeposit',
    'room.invoiceExpiredBuy',
    'room.invoiceExpiredSell',
    'room.invIssueExpired',
    'room.invIssueNetwork',
    'room.invIssueNoAmount',
    'room.invIssueSoon',
    'room.invOpenHint',
    'room.pasteNotInvoice',
    'room.pasteExpired',
    'room.pasteNetwork',
    'room.pasteCheck',
    'room.manualChecks',
    'room.markDone',
    'room.doneConsequence',
    'room.doneHelper',
    'room.doneNotice1',
    'room.partialDone',
    // The one payable card, the over-amount warning, done before paying.
    'room.invIssueOver',
    'room.invInactive',
    'room.doneSellerFirst',
    // Receiving errors and warnings, and the steps that move the bitcoin on-chain
    // (who pays the on-chain fee).
    'room.reqErrReused',
    'room.reqErrBadAddress',
    'room.reqErrAddrLightning',
    'room.reqErrAddrTestnet',
    'room.reqErrAddrTypo',
    'room.reqErrAddrUnsupported',
    'room.reqErrMismatch',
    'room.reqChanged',
    'room.sellPayOnchain',
    'room.sellPayOnchainFee',
    'room.buyDoneOnchain',
    // The same steps and warnings for an on-chain card, in an address's words
    // (src/screens/room/pay-copy.ts), and the copy buttons the hint names.
    'room.sellPayOnchainTitle',
    'room.addressShared',
    'room.addressWaitDeposit',
    'room.addressWait',
    'room.invIssueNoAmountOnchain',
    'room.invIssueOverOnchain',
    'room.invOpenHintOnchain',
    'room.invOpenHintOnchainNoAmount',
    'room.copyLink',
    'room.copyAddressOnly',
    'room.doneNotice1Onchain',
    'board.buyerHint',
    'board.sellerHint',
    'board.buyerHintOnchain',
    'board.sellerHintOnchain',
    'board.buyerHintAny',
    'board.sellerHintAny',
    'board.sideBuy',
    'board.sideSell',
    'board.previewBuy',
    'board.previewBuyFlat',
    'board.previewSell',
    'board.previewSellFlat',
    'board.feeLabel',
    'board.feeHelper',
    'board.changeWarn',
  ],
  'payer-name': ['room.sellVerify', 'room.verifyName', 'room.doneNotice2', 'room.sellPayTo'],
  'scam-warning': ['room.invNotPayer', 'room.invNotPayerOnchain', 'contacts.nostrWarning', 'connect.err.invalid', 'connect.err.self', 'lock.wordsPhishing', 'room.sysReopened'],
  'privacy-promise': [
    'shell.intro1',
    'shell.intro2',
    'shell.intro3',
    'board.emptyBody',
    'board.footnote',
    'board.sheetPrivacy',
    'board.matchesKept',
    'contacts.nostrPrivacy',
    'contacts.nameHelper',
    'connect.nameHelper',
    'settings.see1',
    'settings.see2',
    'settings.see3',
    'settings.limit1',
    'settings.limit2',
    'settings.limit3',
    'settings.limit4',
    'settings.limit5',
    'settings.relayNoDefault',
    // What the support log holds.
    'settings.supportBody',
    // When the app locks again.
    'settings.relockHelp',
    // What the wallet service sees when the app asks it.
    'settings.lnConfirmBody',
  ],
}

const BY_KEY = new Map<string, SafetyCategory>()
for (const [cat, keys] of Object.entries(SAFETY_KEYS) as [SafetyCategory, readonly string[]][]) {
  for (const k of keys) if (!BY_KEY.has(k)) BY_KEY.set(k, cat)
}

/** The category of a safety key, or undefined for any other key. */
export function safetyCategory(id: string): SafetyCategory | undefined {
  return BY_KEY.get(id)
}

/** Every safety key once, in list order. */
export function allSafetyKeys(): string[] {
  return [...BY_KEY.keys()]
}
