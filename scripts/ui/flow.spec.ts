import { randomBytes } from 'node:crypto'
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

/**
 * The core flow on a phone-sized screen, two people over the real relays:
 * start → no lock (dev only) → connect by copying and pasting the code → both contact
 * lists → post opposite intents → the match opens a room → the back button and stacked
 * overlays. Nothing in the app is faked: the selectors are roles and visible names.
 *
 * The steps share two pages and run in order (serial), so a failed step skips the rest and
 * the retry starts the whole flow again with fresh profiles.
 */

// Random profile names (?p=, letters and digits, 24 at most) so every run starts empty.
const RUN = randomBytes(4).toString('hex')
const BUYER = `uib${RUN}`
const SELLER = `uis${RUN}`
// The names each side gives the other on the "connected" screen (stored on that device only).
const SELLER_NAME = '판매자'
const BUYER_NAME = '구매자'

// Relay round trips: generous, but a stuck step still fails inside the test timeout.
const RELAY_WAIT = 90_000

test.describe.configure({ mode: 'serial' })

let buyerCtx: BrowserContext
let sellerCtx: BrowserContext
let buyer: Page
let seller: Page

async function openProfile(browser: Browser, profile: string): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({
    // 127.0.0.1 is a secure context, so the copy and paste buttons can use the clipboard.
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  await page.goto(`/?p=${profile}`)
  return [context, page]
}

/** First run: new key, the 12 words acknowledged, then "no lock (dev only)". */
async function startWithoutLock(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^새로 시작하기/ }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '다음' }).click()
  await page.getByRole('radio', { name: '잠금 없이 (개발용)' }).check()
  await page.getByRole('button', { name: '잠금 없이 시작하기' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: '게시판' })).toBeVisible({
    timeout: RELAY_WAIT,
  })
}

/** Back on the board after a fresh load, whatever an earlier step left open. */
async function reopen(page: Page, profile: string): Promise<void> {
  await page.goto(`/?p=${profile}`)
  await expect(tab(page, '게시판')).toBeVisible({ timeout: RELAY_WAIT })
}

/**
 * A closing sheet stays in the page for its 220 ms slide-out, so "still open" is checked
 * after that has had time to finish.
 */
async function staysVisible(page: Page, locator: Locator): Promise<void> {
  await page.waitForTimeout(600)
  await expect(locator).toBeVisible({ timeout: 1_000 })
}

function tab(page: Page, name: '게시판' | '일촌' | '설정') {
  return page.getByRole('navigation').getByRole('button', { name })
}

async function openConnect(page: Page) {
  await tab(page, '일촌').click()
  await page.getByRole('button', { name: '연결하기' }).first().click()
  const dialog = page.getByRole('dialog', { name: '연결하기' })
  await expect(dialog).toBeVisible()
  // Copy and paste sit folded under "if your camera doesn't work".
  await dialog.getByText('카메라가 안 될 때').click()
  await expect(dialog.getByRole('button', { name: '코드 복사' })).toBeEnabled({ timeout: RELAY_WAIT })
  return dialog
}

/** `from` copies its code; `to` takes it with the paste button (the shared clipboard). */
async function copyAndPaste(from: Page, to: Page): Promise<void> {
  await from.getByRole('dialog', { name: '연결하기' }).getByRole('button', { name: '코드 복사' }).click()
  await expect(from.getByText('코드를 복사했어요')).toBeVisible()
  const code = await from.evaluate(() => navigator.clipboard.readText())
  expect(code).toMatch(/^ilchon:/)
  // Each context has its own clipboard: put the code on the receiving side's, then paste.
  await to.evaluate((text) => navigator.clipboard.writeText(text), code)
  await to.getByRole('dialog', { name: '연결하기' }).getByRole('button', { name: '코드 붙여넣기' }).click()
}

async function nameAndClose(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '연결하기' })
  await expect(dialog.getByRole('heading', { name: '연결됐어요' })).toBeVisible({ timeout: RELAY_WAIT })
  await dialog.getByRole('textbox', { name: '이 사람을 뭐라고 부를까요?' }).fill(name)
  await dialog.getByRole('button', { name: '저장하고 닫기' }).click()
  await expect(dialog).toBeHidden()
}

async function postOffer(page: Page, side: 'buy' | 'sell'): Promise<void> {
  await tab(page, '게시판').click()
  await page.getByRole('button', { name: '조건 올리기' }).first().click()
  const sheet = page.getByRole('dialog', { name: '조건 올리기' })
  await expect(sheet).toBeVisible()
  await sheet
    .getByRole('group', { name: '방향' })
    .getByRole('button', { name: side === 'buy' ? /^삽니다/ : /^팝니다/ })
    .click()
  await sheet.getByRole('textbox', { name: '금액' }).fill('100000')
  await sheet.getByRole('button', { name: '조건 올리기' }).click()
  await expect(sheet).toBeHidden({ timeout: RELAY_WAIT })
}

/** The other side's matching offer on the board: a pressable card in its column. */
function matchCard(page: Page, column: '삽니다' | '팝니다', name: string) {
  return page.getByRole('region', { name: column }).getByRole('button', { name: new RegExp(name) })
}

test.beforeAll(async ({ browser }) => {
  ;[buyerCtx, buyer] = await openProfile(browser, BUYER)
  ;[sellerCtx, seller] = await openProfile(browser, SELLER)
})

test.afterAll(async () => {
  await buyerCtx?.close()
  await sellerCtx?.close()
})

test('start without a lock', async () => {
  await startWithoutLock(buyer)
  await startWithoutLock(seller)
})

test('connect by copying and pasting the code', async () => {
  await openConnect(buyer)
  await openConnect(seller)
  // Each side "scans" the other once: both steps are needed for a link.
  await copyAndPaste(seller, buyer)
  await copyAndPaste(buyer, seller)
  await nameAndClose(buyer, SELLER_NAME)
  await nameAndClose(seller, BUYER_NAME)
})

test('both contact lists show the other', async () => {
  await tab(buyer, '일촌').click()
  await expect(buyer.getByRole('main').getByRole('button', { name: new RegExp(SELLER_NAME) })).toBeVisible()
  await tab(seller, '일촌').click()
  await expect(seller.getByRole('main').getByRole('button', { name: new RegExp(BUYER_NAME) })).toBeVisible()
})

test('the back button closes a sheet and stays in the app', async () => {
  await tab(buyer, '게시판').click()
  await buyer.getByRole('button', { name: '조건 올리기' }).first().click()
  const sheet = buyer.getByRole('dialog', { name: '조건 올리기' })
  await expect(sheet).toBeVisible()
  await buyer.goBack()
  await expect(sheet).toBeHidden()
  await expect(tab(buyer, '게시판')).toBeVisible()
})

test('opposite intents match on both boards', async () => {
  await postOffer(buyer, 'buy')
  await postOffer(seller, 'sell')
  await expect(matchCard(buyer, '팝니다', SELLER_NAME)).toBeVisible({ timeout: RELAY_WAIT })
  await expect(matchCard(seller, '삽니다', BUYER_NAME)).toBeVisible({ timeout: RELAY_WAIT })
})

test('a match opens the room, and back closes it', async () => {
  await matchCard(buyer, '팝니다', SELLER_NAME).click()
  const room = buyer.getByRole('dialog', { name: SELLER_NAME })
  await expect(room).toBeVisible()
  await expect(room.getByRole('textbox', { name: '메시지 입력' })).toBeVisible()
  await buyer.goBack()
  await expect(room).toBeHidden()
  await expect(tab(buyer, '게시판')).toBeVisible()
})

// Known bug: a confirm dialog over a sheet does not take a history entry, so back closes the sheet
// underneath and leaves the dialog. Turn on once it is fixed.
test.fixme('back closes the confirm dialog first, not the sheet under it', async () => {
  await reopen(buyer, BUYER)
  await tab(buyer, '일촌').click()
  await buyer
    .getByRole('main')
    .getByRole('button', { name: new RegExp(SELLER_NAME) })
    .click()
  const sheet = buyer.getByRole('dialog', { name: '일촌 관리' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: '일촌 삭제' }).click()
  const confirm = buyer.getByRole('alertdialog', { name: '이 일촌을 삭제할까요?' })
  await expect(confirm).toBeVisible()
  await buyer.goBack()
  await expect(confirm).toBeHidden()
  await staysVisible(buyer, sheet)
  await buyer.goBack()
  await expect(sheet).toBeHidden()
  await expect(tab(buyer, '일촌')).toBeVisible()
})

// Known bug: after a reload with the room open, the old page's history entries are still below,
// and back reloads the app instead of closing one step. Turn on once it is fixed.
// On 2026-11-18 this did not reproduce in headless desktop Chromium (back closed the room, no
// reload); left off until it is known on which browser and steps it happens.
test.fixme('after a reload in the room, back closes the room without reloading', async () => {
  await reopen(buyer, BUYER)
  await matchCard(buyer, '팝니다', SELLER_NAME).click()
  const room = buyer.getByRole('dialog', { name: SELLER_NAME })
  await expect(room).toBeVisible()
  await buyer.reload()
  await expect(room).toBeVisible({ timeout: RELAY_WAIT })
  let reloaded = false
  buyer.once('load', () => {
    reloaded = true
  })
  await buyer.goBack()
  await expect(room).toBeHidden()
  await expect(tab(buyer, '게시판')).toBeVisible()
  expect(reloaded).toBe(false)
})

// Known bug: the "mark trade done" sheet can be closed (backdrop, back button) while it is still
// saving, and its failure text goes with it. The busy moment is a relay round trip, too short
// to hold from here without faking the relay. Write the steps once it is fixed: open the room,
// "거래 완료", confirm, and press back before the sheet closes — the sheet must stay.
test.fixme('the trade-done sheet stays open while it is saving', async () => {})

// Known bug: the intent sheet keeps the amount it was opened with; a fill that lowers the
// remaining amount while it is open can be overwritten on save. Needs a completed trade on
// the other side while this sheet is open. Write the steps once it is fixed.
test.fixme('the intent sheet picks up an amount lowered by a fill while open', async () => {})

test('withdraw both intents', async () => {
  // Leave nothing posted to the contact behind the run (these are throwaway keys anyway).
  for (const [page, profile] of [
    [buyer, BUYER],
    [seller, SELLER],
  ] as const) {
    await reopen(page, profile)
    await page.getByRole('button', { name: '내리기' }).click()
    await page.getByRole('alertdialog', { name: '조건을 내릴까요?' }).getByRole('button', { name: '내리기' }).click()
    await expect(page.getByText('조건을 내렸어요')).toBeVisible({ timeout: RELAY_WAIT })
  }
})
