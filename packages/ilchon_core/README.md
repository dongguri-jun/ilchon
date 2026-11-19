# ilchon_core

The rules of ilchon in pure Dart, without screens. Today it holds the payment rules: fiat amounts and
the currency table, the amount field, Lightning invoices (BOLT11), mainnet addresses and `bitcoin:`
links, and payment requests in chat text. It has no Flutter, no I/O, no clock and no randomness of its
own, and gives the same results on the Dart VM, compiled to JavaScript and compiled to Wasm.

## Use

```dart
import 'package:ilchon_core/ilchon_core.dart';

// What someone typed into the amount field, kept to what the field may hold, then read exactly.
final field = sanitizeAmount('１２,３４５원', Currency.krw, AmountInputMode.paste); // '12,345'
final amount = parseMinor(field, Currency.krw); // Money? (whole won, 1 to 999,999,999,999)

// The satoshis a buyer asks for at a rate of 150,000,000 won per bitcoin plus a 1.5 % premium.
final sats = requestSats(amount!, Currency.krw, 150000000, 1.5); // int?, rounded down

// A chat message cut into text and payment requests (invoices, addresses, bitcoin: links).
for (final part in splitPaymentText('pay here bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')) {
  switch (part.request) {
    case LightningPaymentRequest(:final invoice):
      print('${invoice.amountSats} sats, ${invoiceIssues(invoice, Instant(DateTime.now().millisecondsSinceEpoch))}');
    case OnchainPaymentRequest(:final request):
      print(onchainCardValues(request).link);
    case null:
      print(part.text);
  }
}

// Why an address field is refused, for the one line the screen shows.
addressProblem('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'); // AddressProblem.testnet
```

- The time is always an argument (`Instant`); the core never reads a clock.
- Amounts are whole numbers: `Money` (fiat minor units, 1 to 999,999,999,999) and `Sats` (1 to
  2,100,000,000,000,000) both stay below 2^53, so they are exact in a JavaScript number. Invoice amounts
  in millisatoshis can be larger and are `BigInt`.
- `toString()` of an amount never shows the number.
- A refusal is `null` or a closed enum (`AddressProblem`, `InvoiceIssue`); a negative amount passed to a
  formatter is a programming error and throws `RangeError`.

The only public file is `package:ilchon_core/ilchon_core.dart`. Everything under `lib/src/` is private.

## Check

From the repository root: `pnpm check:dart` (or `bash tool/check_dart.sh`) runs format, analysis, the
dependency rules and the tests on the VM, dart2js and dart2wasm. In this folder, `dart test` runs the VM
tests and `dart test -p chrome -c dart2js,dart2wasm -t web` the browser ones.

It needs the pinned Dart SDK (Dart 3.14.0, from Flutter 3.50.0; set `ILCHON_DART` to another path) and
a Chrome or Chromium for the browser step (set `CHROME_EXECUTABLE`); the script says which one is
missing. A run takes about 30 seconds on the check machine, of which the browser step is 10 to 12.
The Dart version is named in `.fvmrc`, `.github/workflows/check.yml` and the `sdk` ranges of the
`pubspec.yaml` files; change all of them together.

The payment rules are checked against reference vectors written by the TypeScript app
(`spec/vectors/`, copied into `test/vectors/` by `dart run tool/vectors.dart`). Every case of every
function is compared, except the cases a test names as excused (a Dart type cannot take the input);
each test states how many, and the run fails when the number differs. The copies in `test/vectors/`
are committed so that `dart test` works in this folder alone; `pnpm check:dart` fails when they are
stale.

## Adding a rule set

1. Write `scripts/vectors/<name>.ts` with the helpers of `scripts/vectors/kit.ts` and register it in
   `scripts/export-vectors.ts`; run `pnpm vectors`. The files in `spec/vectors/` are the contract
   between the TypeScript and the Dart side.
2. Run `dart run tool/vectors.dart` to copy them into `test/vectors/`.
3. Add `lib/src/domain/<zone>/<name>.dart` and a line to the show list of `lib/ilchon_core.dart`.
4. Write `test/<name>_vectors_test.dart` with `@Tags(['web'])`, `checkVectors` and one `Port` per
   function. An input the Dart types cannot take throws `NotExpressible` from the `Args` reader; the
   case passes when its expected result is one of the port's `refusals`, when it is marked
   `outOfDomain` in the file, or when the port names it in `cannotExpress` with the reason. The port
   states the number of excused cases in `excused`.
5. Run `pnpm check:dart`.

## Dependency rules

`tool/check_arch.dart` enforces these, from `tool/arch_rules.dart`:

1. No Flutter, no `dart:io`, no browser or JavaScript interop, no `package:http`: the core runs anywhere.
2. `lib/src/` holds `domain/` and `application/`; domain never reaches application.
3. A domain zone uses another zone only through `<zone>/<zone>.dart`, and only along the zone map.
4. No clock, randomness, timers, printing or `async` in domain code; no `part` files anywhere.
5. Other packages use only `ilchon_core.dart`; dependencies are the ones listed for the package.
