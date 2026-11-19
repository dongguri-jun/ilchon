/**
 * Engine checks on the fake transport and virtual time (scripts/fake-transport.ts).
 * No network. Run: pnpm check:engine
 *
 * This file is the entry: it runs every scenario in one fixed order. The checks live in
 * scripts/engine-check/:
 *   report.ts       the conventions: PASS, FAIL, KNOWN-BUG, UNEXPECTED PASS, the exit code
 *   world.ts        a world (clock, hub, KVs) and its peers; time moves through adv() and until()
 *   invariants.ts   the invariants checked after every move and at the end of a scenario
 *   markers.ts      the secret markers and how a dump is searched for them
 *   helpers/        helpers that scenarios of more than one topic share
 *   scenarios/      the scenarios, one file per topic
 *
 * Run a part: pnpm check:engine -- <part of a scenario name> [<another part> ...] runs only the
 * scenarios whose name holds one of the parts (case matters), in the same order, e.g.
 * pnpm check:engine -- S-TWIN PM-7. CHECK_ONLY=<part> does the same. A part that no name
 * holds fails the run.
 */
import { crashed, exitCode, runOnly, scenario, summary } from './engine-check/report'
import { sChSweep, sChTombFields, sChUnreadable } from './engine-check/scenarios/stored-rooms'
import {
  sBotBufferCap,
  sBotReopenBurst,
  sBotSentAtFuture,
  sBotUnbuffered,
  sChBothLost,
  sChCrashMove,
  sChLostWelcome,
  sChOddRoom,
  sChQuiet,
  sChRestore,
  sChRoomLost,
  sChSkewRestore,
  sChSpamMove,
  sChSpamReq,
  sChStale,
  sChStranded,
  sChStranger,
  sChTwinDeleterRestore,
  sChTwinMove,
  sChTwinRestore,
  sChTwoDevices,
} from './engine-check/scenarios/restores'
import {
  sBotHolderRescanAway,
  sBotHolderRescanAwayL,
  sBotHolderRescanDelay,
  sBotHolderRescanFlood,
  sBotHolderRescanRequests,
  sBotHolderRescanThief,
  sChDeletedOnesided,
  sChDeleterOnesided,
  sChDeleterRescan,
  sChExpiry,
  sChExpirySoon,
  sChForgedHello,
  sChKpRotate,
  sChPreview,
  sChQrBeforeKp,
  sChRescan,
  sChRescanAfterMove,
  sChRescanBackground,
  sChRescanBackgroundReturn,
  sChRescanFresh,
  sChRescanLateReturn,
  sChRescanOneSided,
  sChRescanSameCode,
  sChRescanSixMin,
  sChScanOrder,
  sHolderFlap,
  sResumeFlap,
  sResumeLateClose,
  sResumeLateExpire,
} from './engine-check/scenarios/rescans'
import { kCrashMatch, sCrashSweep } from './engine-check/scenarios/crash'
import { sDlv14, sDlv15, sDlv16, sDlv18, sDlv22, sDlv3, sDlv4, sDlv9b, sDlvFlood, sDlvHang, sDlvInboxDump, sDlvRxSweep, sRelockInbox } from './engine-check/scenarios/delivery-2'
import { sBotMxLoop, sDlv1, sDlv10, sDlv2, sDlv21, sDlv9, sDlvDel, sDlvPost, sDlvRespCap, sDlvTxSweep } from './engine-check/scenarios/delivery-3'
import { sBotProbeScrape, sDlv5, sDlv6, sDlv7, sDlv8, sDlv8b, sDlvEdit, sDlvReorder, sDlvRestartBoth, sDlvRestartOne } from './engine-check/scenarios/delivery-4'
import { sDlv11, sDlv12, sDlv13, sDlv17, sDlv20, sDlvDoneDup, sDlvDoneSweep } from './engine-check/scenarios/delivery-5'
import {
  sDevCatchupOrder,
  sDevFrozenFlood,
  sDevPinStale,
  sDevReopenLimit,
  sDevReopenPin,
  sDevRoomFloorOld,
  sDevRoomFull,
  sAnswerLine,
  sCatchupAhead,
  sOfferParts,
  sSendFailed,
  sSkewFallback,
  sSkewFirst,
  sSkewGenuine,
  sSkewRestart,
  sSkewStale,
  sStaleFree,
  sTwinFrozen,
  sTwinRescan,
  sAnswerLimit,
  sCatchupSlow,
  sClockBack,
  sFailedLine,
  sFailedLineTwin,
  sOldRoomSettled,
  sRestoreRescanCatchup,
  sShutdownReset,
  sShutdownResetFail,
  sTwinRescanBreak,
  sTwinRescanBreakLow,
  sAnswerRetry,
  sAnswerSeparate,
  sAnswerRetryTwin,
  sRelinkTwin,
  sRestartTwin,
} from './engine-check/scenarios/device'
import { sFormat, sFormatRetry } from './engine-check/scenarios/format'
import { sHub, sHubCrashGen, sHubHang, sHubHold, sHubPeerOpts, sHubRejectAfter, sHubSendWait } from './engine-check/scenarios/hub'
import { sLeak, sMarkers } from './engine-check/scenarios/leak'
import { sM2Owner, sReflect } from './engine-check/scenarios/matching'
import { pm1, pm2, pm3, pm4, pm4Same, pm5, pm6, pm7, pm8, pmMoveTag, pmReopen, pmResend, pmTold, pmWire, sLeakMethod } from './engine-check/scenarios/payment'
import { sReaddMatch, sReaddMemo, sRedeemedCode, sRequestRestart, sRescanAfterMoveTwin, sSentAtReadd } from './engine-check/scenarios/readd'
import {
  sBotListInsert,
  sRec1,
  sRec10,
  sRec12,
  sRec13,
  sRec14,
  sRec15,
  sRec16,
  sRec16List,
  sRec2,
  sRec3,
  sRec4,
  sRec5,
  sRec6,
  sRec6b,
  sRec7,
  sRec8,
  sRec9,
  sRecDamagedContacts,
  sRecDamagedTombstones,
  sRecDone,
  sRecListStop,
  sRecMergeStop,
  sRecNoWords,
  sRecRescan,
  sRecRescanTwin,
  sRecRetry,
} from './engine-check/scenarios/recovery'
import { sDlv19, sDlv19HolderLate, sReopenDone, sReopenMatch, sReopenRestart, sTombMemo } from './engine-check/scenarios/reopen'
import { sBootReconnect, sBootRoom, sBootStop, sBootWait, sSettingsSaveFail, sStopStart, sStopWrite } from './engine-check/scenarios/stop-boot'
import { sLogRedact, sLogSweep, sLogTwinOffline, sLogTwinRescan, sLogTwinStale, sRecLog } from './engine-check/scenarios/support-log'
import {
  sBotOfferSwap,
  sBotUnmatchedInvoice,
  sDoneUsd,
  sTrdBadOffer,
  sTrdChain,
  sTrdChatMax,
  sTrdCrashDeduct,
  sTrdCrashEdit,
  sTrdCrashRecord,
  sTrdDeleted,
  sTrdKeep,
  sTrdMarkers,
  sTrdReceived,
  sTrdRefuse,
  sTrdSteps,
  sTrdSums,
  sTrdWriteOrder,
} from './engine-check/scenarios/trade'
import { sTwin, sTwinConfirm } from './engine-check/scenarios/twin'
import { MIN } from './engine-check/world'

async function main(): Promise<void> {
  const t0 = Date.now()
  await scenario('S-HUB', sHub)
  await scenario('S-HUB-HOLD', sHubHold)
  await scenario('S-HUB-REJECT-AFTER', sHubRejectAfter)
  await scenario('S-HUB-SEND-WAIT', sHubSendWait)
  await scenario('S-HUB-HANG', sHubHang)
  await scenario('S-HUB-CRASH-GEN', sHubCrashGen)
  await scenario('S-HUB-PEER-OPTS', sHubPeerOpts)
  await scenario('S-MARKERS', sMarkers)
  await scenario('S-LEAK', sLeak)
  await scenario('S-TWIN (A lower key)', () => sTwin(true))
  await scenario('S-TWIN (A higher key)', () => sTwin(false))
  await scenario('S-TWIN-CONFIRM', sTwinConfirm)
  await scenario('S-LEAK-METHOD', sLeakMethod)
  await scenario('PM-1', pm1)
  await scenario('PM-2', pm2)
  await scenario('PM-3', pm3)
  await scenario('PM-4', pm4)
  await scenario('PM-4-SAME', pm4Same)
  await scenario('PM-5 (A lower key)', () => pm5(true))
  await scenario('PM-5 (A higher key)', () => pm5(false))
  await scenario('PM-6', pm6)
  await scenario('PM-WIRE', pmWire)
  await scenario('PM-TOLD', pmTold)
  await scenario('PM-7', pm7)
  await scenario('PM-8', pm8)
  await scenario('PM-RESEND', pmResend)
  await scenario('PM-REOPEN', pmReopen)
  await scenario('PM-MOVE-TAG (a destination across a tag move and a remote reopen)', pmMoveTag)
  await scenario('S-REFLECT (A lower key)', () => sReflect(true))
  await scenario('S-REFLECT (A higher key)', () => sReflect(false))
  await scenario('S-M2-OWNER', sM2Owner)
  await scenario('S-STOP-WRITE', sStopWrite)
  await scenario('S-STOP-START', sStopStart)
  await scenario('S-SETTINGS-SAVE-FAIL', sSettingsSaveFail)
  await scenario('S-BOOT-WAIT', sBootWait)
  await scenario('S-BOOT-STOP', sBootStop)
  await scenario('S-BOOT-RECONNECT', sBootReconnect)
  await scenario('S-BOOT-ROOM', sBootRoom)
  await scenario('S-CH-SWEEP', sChSweep)
  await scenario('S-CH-UNREADABLE', sChUnreadable)
  await scenario('S-CH-TOMB-FIELDS', sChTombFields)
  await scenario('S-CH-RESTORE-L', () => sChRestore(true))
  await scenario('S-CH-RESTORE-H', () => sChRestore(false))
  await scenario('S-CH-BOTH-LOST', sChBothLost)
  await scenario('S-CH-ROOM-LOST (B lower)', () => sChRoomLost(true))
  await scenario('S-CH-ROOM-LOST (B higher)', () => sChRoomLost(false))
  await scenario('S-CH-STRANDED', sChStranded)
  await scenario('S-CH-STALE', sChStale)
  await scenario('S-CH-LOST-WELCOME (a lost)', () => sChLostWelcome('a'))
  await scenario('S-CH-LOST-WELCOME (b key package gone)', () => sChLostWelcome('b'))
  await scenario('S-CH-LOST-WELCOME (c delivered, then failed)', () => sChLostWelcome('c'))
  await scenario('S-CH-SKEW-RESTORE', sChSkewRestore)
  await scenario('S-CH-CRASH-MOVE', sChCrashMove)
  await scenario('S-CH-SPAM-MOVE', sChSpamMove)
  await scenario('S-CH-SPAM-REQ', sChSpamReq)
  await scenario('S-CH-QUIET (A lower key)', () => sChQuiet(true))
  await scenario('S-CH-QUIET (A higher key)', () => sChQuiet(false))
  await scenario('S-CH-STRANGER', sChStranger)
  await scenario('S-CH-ODD-ROOM', sChOddRoom)
  await scenario('S-CH-TWIN-RESTORE (B lower key)', () => sChTwinRestore(true))
  await scenario('S-CH-TWIN-RESTORE (B higher key)', () => sChTwinRestore(false))
  await scenario('S-CH-TWIN-DELETER-RESTORE (A lower key)', () => sChTwinDeleterRestore(true))
  await scenario('S-CH-TWIN-DELETER-RESTORE (A higher key)', () => sChTwinDeleterRestore(false))
  await scenario('S-CH-TWIN-MOVE (A lower key)', () => sChTwinMove(true))
  await scenario('S-CH-TWIN-MOVE (A higher key)', () => sChTwinMove(false))
  await scenario('S-CH-TWO-DEVICES (A lower key)', () => sChTwoDevices(true))
  await scenario('S-CH-TWO-DEVICES (A higher key)', () => sChTwoDevices(false))
  for (const aLow of [true, false]) {
    for (const aFirst of [true, false]) {
      for (const [gap, label] of [
        [5_000, '5 s'],
        [90_000, '90 s'],
        [4 * MIN, '4 min'],
      ] as const) {
        await scenario(`S-CH-RESCAN (A ${aLow ? 'lower' : 'higher'}, ${aFirst ? 'A' : 'B'} first, ${label})`, () => sChRescan(aLow, aFirst, gap))
      }
    }
  }
  for (const aLow of [true, false]) {
    for (const v of ['plain', 'pinned', 'full', 'off-next-day'] as const) {
      if (!aLow && v !== 'plain') continue
      await scenario(`S-CH-RESCAN one-sided (A ${aLow ? 'lower' : 'higher'}, ${v})`, () => sChRescanOneSided(aLow, v))
    }
  }
  await scenario('S-CH-RESCAN (A lower first, 6 min)', sChRescanSixMin)
  await scenario('S-CH-RESCAN background (B scans while A is away)', () => sChRescanBackground(true))
  await scenario('S-CH-RESCAN background (A alone, back past its deadline)', () => sChRescanBackground(false))
  await scenario('S-CH-QR-BEFORE-KP (the first QR waits for the key package)', sChQrBeforeKp)
  await scenario('S-CH-RESCAN background return (late timers first)', () => sChRescanBackgroundReturn('timers-first'))
  await scenario('S-CH-RESCAN background return (visibility first)', () => sChRescanBackgroundReturn('visible-first'))
  for (const [how, lateMs] of [
    ['timers-first', 45_000],
    ['timers-first', 60_000],
    ['visible-first', 45_000],
    ['visible-first', 60_000],
    ['browser-order', 45_000],
    ['browser-order', 60_000],
    ['restart', 45_000],
    ['restart', 60_000],
    ['timers-first', 2 * MIN],
    ['visible-first', 2 * MIN],
    ['restart', 2 * MIN],
  ] as const) {
    await scenario(`S-CH-RESCAN late return (${how}, ${lateMs / 1000} s past the deadline)`, () => sChRescanLateReturn(how, lateMs))
  }
  await scenario('S-CH-RESCAN same code (B and C scan one QR)', sChRescanSameCode)
  await scenario('S-CH-KP-ROTATE (a QR after a join names the new key package)', sChKpRotate)
  await scenario('S-CH-RESCAN-FRESH (A lower)', () => sChRescanFresh(true))
  await scenario('S-CH-RESCAN-FRESH (A higher)', () => sChRescanFresh(false))
  await scenario('S-CH-RESCAN-AFTER-MOVE (A lower)', () => sChRescanAfterMove(true))
  await scenario('S-CH-RESCAN-AFTER-MOVE (A higher)', () => sChRescanAfterMove(false))
  for (const aLow of [true, false]) {
    for (const aFirst of [true, false]) {
      await scenario(`S-CH-DELETER-RESCAN (A ${aLow ? 'lower' : 'higher'}, ${aFirst ? 'A' : 'B'} first)`, () => sChDeleterRescan(aLow, aFirst))
    }
  }
  await scenario('S-CH-DELETER-ONESIDED (A lower key)', () => sChDeleterOnesided(true))
  await scenario('S-CH-DELETER-ONESIDED (A higher key)', () => sChDeleterOnesided(false))
  await scenario('S-CH-EXPIRY', sChExpiry)
  await scenario('S-CH-EXPIRY (rescan at once)', sChExpirySoon)
  for (const holderLow of [true, false]) {
    for (const order of ['holder-first', 'lacking-first', 'holder-90s-late', 'moved-30s'] as const) {
      await scenario(`S-CH-SCAN-ORDER (holder ${holderLow ? 'L' : 'H'}, ${order})`, () => sChScanOrder(holderLow, order))
    }
  }
  await scenario('S-CH-DELETED-ONESIDED (B lower key)', () => sChDeletedOnesided(true))
  await scenario('S-CH-DELETED-ONESIDED (B higher key)', () => sChDeletedOnesided(false))
  await scenario('S-BOT-SENTAT-FUTURE (A lower key)', () => sBotSentAtFuture(true))
  await scenario('S-BOT-SENTAT-FUTURE (A higher key)', () => sBotSentAtFuture(false))
  await scenario('S-CH-FORGED-HELLO', sChForgedHello)
  await scenario('S-CH-PREVIEW', sChPreview)
  for (const aLow of [true, false]) {
    for (const aFirst of [true, false]) {
      for (const gap of [60_000, 4 * MIN + 50_000]) {
        await scenario(`S-BOT-HOLDER-RESCAN (가) (A ${aLow ? 'lower' : 'higher'}, ${aFirst ? 'A' : 'B'} first, ${gap / 1000} s)`, () => sBotHolderRescanThief(aLow, aFirst, gap))
      }
    }
  }
  for (const [gap, label] of [
    [5_000, '5 s'],
    [90_000, '90 s'],
    [4 * MIN, '4 min'],
  ] as const) {
    await scenario(`S-BOT-HOLDER-RESCAN (나) (matched, ${label})`, () => sChRescan(true, true, gap, true))
  }
  await scenario('S-BOT-HOLDER-RESCAN (라) (L first, 4 min delay, 5 s)', () => sBotHolderRescanDelay(true, 4 * MIN, 5_000, false))
  await scenario('S-BOT-HOLDER-RESCAN (라) (L first, 50 s delay, 4 min)', () => sBotHolderRescanDelay(true, 50_000, 4 * MIN, false))
  await scenario('S-BOT-HOLDER-RESCAN (라) (L first, 2 min delay, 4 min)', () => sBotHolderRescanDelay(true, 2 * MIN, 4 * MIN, true))
  await scenario('S-BOT-HOLDER-RESCAN (라) (H first, 4 min delay, 5 s)', () => sBotHolderRescanDelay(false, 4 * MIN, 5_000, false))
  await scenario('S-BOT-HOLDER-RESCAN (라) (L→H only 6 min, L first)', () => sBotHolderRescanDelay(true, 6 * MIN, 5_000, false, 'lh'))
  await scenario('S-BOT-HOLDER-RESCAN (라) (L→H only 6 min, H first)', () => sBotHolderRescanDelay(false, 6 * MIN, 5_000, false, 'lh'))
  await scenario('S-BOT-HOLDER-RESCAN (라) (H→L only 6 min, L first)', () => sBotHolderRescanDelay(true, 6 * MIN, 5_000, 'h-pinned', 'hl'))
  await scenario('S-BOT-HOLDER-RESCAN (마) (a live thief sends a Welcome every 10 s)', () => sBotHolderRescanFlood(10_000))
  await scenario('S-BOT-HOLDER-RESCAN (마) (a live thief floods a Welcome every second)', () => sBotHolderRescanFlood(1_000))
  await scenario('S-BOT-HOLDER-RESCAN (바) (a thief asks while A scans)', sBotHolderRescanRequests)
  await scenario('S-BOT-HOLDER-RESCAN (아) (B away for 30 min)', sBotHolderRescanAway)
  await scenario('S-BOT-HOLDER-RESCAN (아) (A, the L, back past its deadline + 1 min)', sBotHolderRescanAwayL)
  await scenario('S-HOLDER-FLAP (one reconnect 10 s after a late return)', () => sHolderFlap(true))
  await scenario('S-HOLDER-FLAP (reconnects every 10 s after a late return)', () => sHolderFlap(false))
  await scenario('S-RESUME-FLAP (codes, holder scan and peer time close with the window)', sResumeFlap)
  await scenario('S-RESUME-LATE-CLOSE (a window close that fires late keeps the backlog codes)', sResumeLateClose)
  await scenario('S-RESUME-LATE-EXPIRE (a holder scan end that fires late waits for the backlog)', sResumeLateExpire)
  await scenario('S-BOT-REOPEN-BURST', sBotReopenBurst)
  await scenario('S-BOT-UNBUFFERED', sBotUnbuffered)
  await scenario('S-BOT-BUFFER-CAP', sBotBufferCap)
  await scenario('S-CRASH-SWEEP', sCrashSweep)
  await scenario('K-CRASH-MATCH', kCrashMatch)
  await scenario('S-DLV-3', sDlv3)
  await scenario('S-RELOCK-INBOX', sRelockInbox)
  await scenario('S-DLV-4', sDlv4)
  await scenario('S-DLV-9b', sDlv9b)
  await scenario('S-DLV-14', sDlv14)
  await scenario('S-DLV-15', sDlv15)
  await scenario('S-DLV-16', sDlv16)
  await scenario('S-DLV-18', () => sDlv18(false))
  await scenario('S-DLV-18b', () => sDlv18(true))
  await scenario('S-DLV-22', sDlv22)
  await scenario('S-DLV-HANG', sDlvHang)
  await scenario('S-DLV-FLOOD', sDlvFlood)
  await scenario('S-DLV-INBOX-DUMP', sDlvInboxDump)
  await scenario('S-DLV-RX-SWEEP', sDlvRxSweep)
  await scenario('S-DLV-RESP-CAP', sDlvRespCap)
  await scenario('S-DLV-1', sDlv1)
  await scenario('S-DLV-2', sDlv2)
  await scenario('S-DLV-POST', sDlvPost)
  await scenario('S-DLV-DEL', sDlvDel)
  await scenario('S-DLV-9 (A lower key)', () => sDlv9(true))
  await scenario('S-DLV-9 (A higher key)', () => sDlv9(false))
  await scenario('S-DLV-10', sDlv10)
  await scenario('S-DLV-21', sDlv21)
  await scenario('S-BOT-MX-LOOP', sBotMxLoop)
  await scenario('S-DLV-TX-SWEEP', sDlvTxSweep)
  await scenario('S-DLV-5', sDlv5)
  await scenario('S-DLV-6', sDlv6)
  await scenario('S-DLV-7', sDlv7)
  await scenario('S-DLV-8', sDlv8)
  await scenario('S-DLV-8b', sDlv8b)
  await scenario('S-DLV-RESTART-ONE', sDlvRestartOne)
  await scenario('S-DLV-RESTART-BOTH', sDlvRestartBoth)
  await scenario('S-DLV-REORDER', sDlvReorder)
  await scenario('S-DLV-EDIT', sDlvEdit)
  await scenario('S-BOT-PROBE-SCRAPE', sBotProbeScrape)
  // A completed trade's USD amount, in integer cents.
  await scenario('S-DONE-USD', sDoneUsd)
  await scenario('S-TRD-CHAIN', sTrdChain)
  await scenario('S-TRD-REFUSE', sTrdRefuse)
  await scenario('S-TRD-WRITE-ORDER', sTrdWriteOrder)
  await scenario('S-TRD-CRASH-EDIT', sTrdCrashEdit)
  await scenario('S-TRD-CRASH-DEDUCT', () => sTrdCrashDeduct(false))
  await scenario('S-TRD-CRASH-WITHDRAW', () => sTrdCrashDeduct(true))
  await scenario('S-TRD-CRASH-RECORD', sTrdCrashRecord)
  await scenario('S-TRD-RECEIVED', sTrdReceived)
  await scenario('S-TRD-BAD-OFFER', sTrdBadOffer)
  await scenario('S-TRD-MARKERS', sTrdMarkers)
  await scenario('S-TRD-CHAT-MAX', sTrdChatMax)
  await scenario('S-TRD-SUMS', sTrdSums)
  await scenario('S-TRD-DELETED', sTrdDeleted)
  await scenario('S-TRD-STEPS', sTrdSteps)
  await scenario('S-BOT-OFFER-SWAP', sBotOfferSwap)
  await scenario('S-BOT-UNMATCHED-INVOICE', sBotUnmatchedInvoice)
  await scenario('S-TRD-KEEP', sTrdKeep)
  // Record ids, completion status and its automatic resend.
  await scenario('S-DLV-11', sDlv11)
  await scenario('S-DLV-12', sDlv12)
  await scenario('S-DLV-13', sDlv13)
  await scenario('S-DLV-17', sDlv17)
  await scenario('S-DLV-20', sDlv20)
  await scenario('S-DLV-DONE-DUP', sDlvDoneDup)
  await scenario('S-DLV-DONE-SWEEP', sDlvDoneSweep)
  await scenario('S-REOPEN-MATCH (L loses)', () => sReopenMatch('L'))
  await scenario('S-REOPEN-MATCH (H loses)', () => sReopenMatch('H'))
  await scenario('S-REOPEN-MATCH (withdraw refused)', () => sReopenMatch('L', true))
  await scenario('S-REOPEN-DONE (stranded)', () => sReopenDone('strand'))
  await scenario('S-REOPEN-DONE (refused, then lost)', () => sReopenDone('refused'))
  // A failed completion and a rebind started by the hub.
  await scenario('S-DLV-19', sDlv19)
  // A holder's late return while a failed completion waits.
  await scenario('S-DLV-19-HOLDER (late return while a completion waits)', sDlv19HolderLate)
  await scenario('S-REOPEN-RESTART (A)', () => sReopenRestart('A'))
  await scenario('S-REOPEN-RESTART (B)', () => sReopenRestart('B'))
  await scenario('S-REOPEN-RESTART (B relock)', () => sReopenRestart('B-relock'))
  await scenario('S-TOMB-MEMO (A lower key)', () => sTombMemo(true))
  await scenario('S-TOMB-MEMO (A higher key)', () => sTombMemo(false))
  await scenario('S-READD-MATCH (A lower key)', () => sReaddMatch(false))
  await scenario('S-READD-MATCH (A higher key)', () => sReaddMatch(true))
  await scenario('S-READD-MEMO (A lower key)', () => sReaddMemo(true))
  await scenario('S-READD-MEMO (A higher key)', () => sReaddMemo(false))
  await scenario('S-SENTAT-READD', sSentAtReadd)
  await scenario('S-REDEEMED-CODE', sRedeemedCode)
  await scenario('S-REQUEST-RESTART', sRequestRestart)
  for (const aLow of [false, true]) {
    for (const aFirst of [true, false]) {
      for (const [gap, label] of [
        [5_000, '5 s'],
        [90_000, '90 s'],
        [4 * MIN, '4 min'],
      ] as const) {
        for (const who of ['none', 'A', 'B'] as const) {
          await scenario(`S-RESCAN-AFTER-MOVE-TWIN (A ${aLow ? 'lower' : 'higher'}, ${aFirst ? 'A' : 'B'} first, ${label}, ${who === 'none' ? 'no restart' : `${who} restarts`})`, () =>
            sRescanAfterMoveTwin(aFirst, gap, aLow, who),
          )
        }
      }
    }
  }
  for (const aFirst of [true, false]) {
    await scenario(`S-RESCAN-AFTER-MOVE-TWIN (A higher, ${aFirst ? 'A' : 'B'} first, 5 s, B moves again 2 h later)`, () => sRescanAfterMoveTwin(aFirst, 5_000, false, 'none', true))
  }
  await scenario('S-FORMAT', sFormat)
  await scenario('S-FORMAT-RETRY', sFormatRetry)
  await scenario('S-REC-12', sRec12)
  await scenario('S-REC-NOWORDS', sRecNoWords)
  await scenario('S-REC-1', sRec1)
  await scenario('S-REC-2', sRec2)
  await scenario('S-REC-3', sRec3)
  await scenario('S-REC-4', sRec4)
  await scenario('S-REC-5', sRec5)
  await scenario('S-REC-6', sRec6)
  await scenario('S-REC-6b', sRec6b)
  await scenario('S-REC-7', sRec7)
  await scenario('S-REC-8', sRec8)
  await scenario('S-REC-9', sRec9)
  await scenario('S-REC-10', sRec10)
  await scenario('S-REC-13 (A lower key)', () => sRec13(true))
  await scenario('S-REC-13 (A higher key)', () => sRec13(false))
  await scenario('S-REC-14', sRec14)
  await scenario('S-REC-15', sRec15)
  await scenario('S-REC-16', sRec16)
  await scenario('S-REC-16-LIST (key-takeover check answers after the list fetch)', sRec16List)
  await scenario('S-REC-LIST-STOP', sRecListStop)
  await scenario('S-REC-MERGE-STOP', sRecMergeStop)
  await scenario('S-REC-RESCAN (A lower key)', () => sRecRescan(true))
  await scenario('S-REC-RESCAN (A higher key)', () => sRecRescan(false))
  await scenario('S-REC-RESCAN-TWIN (A lower key)', () => sRecRescanTwin(true))
  await scenario('S-REC-RESCAN-TWIN (A higher key)', () => sRecRescanTwin(false))
  await scenario('S-REC-DONE', sRecDone)
  await scenario('S-REC-DAMAGED-CONTACTS', sRecDamagedContacts)
  await scenario('S-REC-DAMAGED-TOMBSTONES', sRecDamagedTombstones)
  await scenario('S-REC-RETRY', sRecRetry)
  await scenario('S-BOT-LIST-INSERT', sBotListInsert)
  await scenario('S-REC-LOG', sRecLog)
  await scenario('S-LOG-REDACT', sLogRedact)
  await scenario('S-LOG-TWIN-STALE (A lower key)', () => sLogTwinStale(true))
  await scenario('S-LOG-TWIN-STALE (A higher key)', () => sLogTwinStale(false))
  await scenario('S-LOG-TWIN-OFFLINE (A lower key)', () => sLogTwinOffline(true))
  await scenario('S-LOG-TWIN-OFFLINE (A higher key)', () => sLogTwinOffline(false))
  await scenario('S-LOG-TWIN-RESCAN (A lower key)', () => sLogTwinRescan(true))
  await scenario('S-LOG-TWIN-RESCAN (A higher key)', () => sLogTwinRescan(false))
  await scenario('S-LOG-SWEEP', sLogSweep)
  await scenario('S-DEV-ROOM-FULL', sDevRoomFull)
  await scenario('S-DEV-CATCHUP-ORDER', sDevCatchupOrder)
  await scenario('S-CATCHUP-AHEAD', sCatchupAhead)
  await scenario('S-OFFER-PARTS', sOfferParts)
  await scenario('S-DEV-REOPEN-PIN', sDevReopenPin)
  await scenario('S-DEV-REOPEN-LIMIT', sDevReopenLimit)
  await scenario('S-DEV-ROOM-FLOOR-OLD', sDevRoomFloorOld)
  await scenario('S-DEV-PIN-STALE', sDevPinStale)
  await scenario('S-STALE-FREE', sStaleFree)
  await scenario('S-SEND-FAILED', sSendFailed)
  await scenario('S-FAILED-LINE', sFailedLine)
  await scenario('S-CLOCK-BACK', sClockBack)
  await scenario('S-SHUTDOWN-RESET', sShutdownReset)
  await scenario('S-SHUTDOWN-RESET (fail)', sShutdownResetFail)
  await scenario('S-OLD-ROOM-SETTLED', sOldRoomSettled)
  await scenario('S-CATCHUP-SLOW', sCatchupSlow)
  await scenario('S-ANSWER-LINE (no QR lately)', () => sAnswerLine(false))
  await scenario('S-ANSWER-LINE (QR on screen lately)', () => sAnswerLine(true))
  await scenario('S-SKEW-GENUINE', sSkewGenuine)
  await scenario('S-SKEW-STALE', sSkewStale)
  await scenario('S-SKEW-FIRST', sSkewFirst)
  await scenario('S-SKEW-FALLBACK', sSkewFallback)
  await scenario('S-SKEW-RESTART', sSkewRestart)
  for (const chan of ['pin', 'limit', 'free'] as const) {
    await scenario(`S-TWIN-RESCAN (${chan}, scan each other)`, () => sTwinRescan(chan, true))
    await scenario(`S-TWIN-RESCAN (${chan}, A scans only)`, () => sTwinRescan(chan, false))
  }
  await scenario('S-TWIN-FROZEN', sTwinFrozen)
  await scenario('S-TWIN-RESCAN-BREAK', sTwinRescanBreak)
  await scenario('S-TWIN-RESCAN-BREAK-LOW (A lower key, no earlier move, three breaks)', sTwinRescanBreakLow)
  await scenario('S-FAILED-LINE-TWIN (A lower key)', () => sFailedLineTwin(true))
  await scenario('S-FAILED-LINE-TWIN (A higher key)', () => sFailedLineTwin(false))
  await scenario('S-ANSWER-LIMIT', sAnswerLimit)
  await scenario('S-ANSWER-SEPARATE', sAnswerSeparate)
  await scenario('S-ANSWER-RETRY', sAnswerRetry)
  await scenario('S-ANSWER-RETRY-TWIN', sAnswerRetryTwin)
  await scenario('S-RESTART-TWIN (room works)', () => sRestartTwin(false))
  await scenario('S-RESTART-TWIN (room fails later)', () => sRestartTwin(true))
  await scenario('S-RELINK-TWIN', sRelinkTwin)
  await scenario('S-RESTORE-RESCAN-CATCHUP (B lower key)', () => sRestoreRescanCatchup(true))
  await scenario('S-RESTORE-RESCAN-CATCHUP (B higher key)', () => sRestoreRescanCatchup(false))
  await scenario('S-DEV-FROZEN-FLOOD', sDevFrozenFlood)
  summary(t0)
}

// `pnpm check:engine -- <part> [<part> ...]` (pnpm may pass the `--` on) and CHECK_ONLY=<part>.
const parts = [...process.argv.slice(2).filter((a) => a !== '--'), ...(process.env.CHECK_ONLY ? [process.env.CHECK_ONLY] : [])]
if (parts.length > 0) {
  runOnly(parts)
  console.log(`only the scenarios whose name holds ${parts.map((o) => `'${o}'`).join(' or ')}`)
}

main()
  .catch(crashed)
  .finally(() => process.exit(exitCode()))
