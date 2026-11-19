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

The payment rules are checked against reference vectors written by the TypeScript app
(`spec/vectors/`, copied into `test/vectors/` by `dart run tool/vectors.dart`). Every case of every
function is checked; a case the Dart types cannot take passes only when the TypeScript result was a
refusal, or when the test names it with the reason.

## Dependency rules

`tool/check_arch.dart` enforces these, from `tool/arch_rules.dart`:

1. No Flutter, no `dart:io`, no browser or JavaScript interop, no `package:http`: the core runs anywhere.
2. `lib/src/` holds `domain/` and `application/`; domain never reaches application.
3. A domain zone uses another zone only through `<zone>/<zone>.dart`, and only along the zone map.
4. No clock, randomness, timers, printing or `async` in domain code; no `part` files anywhere.
5. Other packages use only `ilchon_core.dart`; dependencies are the ones listed for the package.
