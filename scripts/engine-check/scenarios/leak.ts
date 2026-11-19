/**
 * Engine check scenarios: leaks of the secret markers (S-MARKERS, S-LEAK).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { leakRun } from '../helpers/leak'
import { AMOUNT, FEE, holdsNumber } from '../markers'
import { expect } from '../report'
import { finish } from '../world'

export async function sLeak(): Promise<void> {
  const r = await leakRun(false)
  await finish(r.w)
}

/** The leak search itself: it finds a number under any field and skips one inside hex. */
export async function sMarkers(): Promise<void> {
  expect(holdsNumber('{"rest":[43219]}', AMOUNT), 'an amount in an array is found')
  expect(holdsNumber('{"amountMinor":43219}', AMOUNT), 'an amount under another field name is found')
  expect(holdsNumber('pay 43219 won', AMOUNT), 'an amount in text is found')
  expect(!holdsNumber('"ab43219cd"', AMOUNT) && !holdsNumber('"0443219"', AMOUNT) && !holdsNumber('"432190"', AMOUNT), 'an amount inside hex or a longer number is not')
  expect(holdsNumber('{"feePct":2.75}', FEE) && holdsNumber('[2.75,1]', FEE), 'a fee is found')
  expect(!holdsNumber('"a2b75c"', FEE) && !holdsNumber('"12.75"', FEE) && !holdsNumber('"2.759"', FEE) && !holdsNumber('"2a75"', FEE), 'a fee inside hex or another number is not')
  expect(holdsNumber('{"amountMinor":205}', 205) && holdsNumber('done 100', 100) && holdsNumber('$2.05', 2.05) && holdsNumber('1.05 left', 1.05), 'completion amounts are found')
  expect(!holdsNumber('"a205f"', 205) && !holdsNumber('"1005"', 100) && !holdsNumber('"12.05"', 2.05) && !holdsNumber('"1.055"', 1.05), 'completion amounts inside hex or longer numbers are not')
}
