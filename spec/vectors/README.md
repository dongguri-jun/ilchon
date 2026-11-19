# Reference vectors

Input and result of the amount and payment rules in `src/lib/money`, `src/lib/bolt11`, `src/lib/onchain` and `src/lib/pay`, written by the TypeScript code itself. Another implementation of the same rules is correct when it gives the same result for every case.

```bash
pnpm vectors         # write the files
pnpm check:vectors   # fail when the committed files differ from a fresh export (part of pnpm check)
```

## Files

One file per module: `money.json`, `bolt11.json`, `onchain.json`, `pay.json`.

```json
{
  "module": "money",
  "constants": { "MAX_MINOR": 999999999999 },
  "functions": {
    "formatMoney": {
      "args": ["minor", "currency"],
      "cases": [
        { "name": "USD 105", "input": { "minor": 105, "currency": "USD" }, "expected": "$1.05" }
      ]
    }
  }
}
```

- `input` maps argument names (in call order, listed in `args`) to values. An argument that is absent was not passed.
- `expected` is what the function returned. A case that threw has `error` (the class name, such as `RangeError`) instead.
- `outOfDomain: true` marks an input the callers never pass (a negative or fractional amount, `NaN`, a non-string). The result is still what the code does today; an implementation may skip these.
- Cases that take an invoice (`secondsLeft`, `invoiceIssues`) pass the invoice as text: decode it first, then call the function.
- Each case is on one line, so a changed case is one changed line.

## Values JSON cannot carry

| Written as | Means |
|---|---|
| `{"$":"NaN"}`, `{"$":"Infinity"}`, `{"$":"-Infinity"}` | the number |
| `{"$":"-0"}` | negative zero |
| `{"$":"undefined"}` | an argument or field that is `undefined`. `null` stays `null` |
| `{"$":"int","value":"9007199254740993"}` | a whole number outside the safe integer range, exact decimal digits. The value is the number the TypeScript code actually held, so it may differ from the number its source text spelled |
| `{"$":"bigint","value":"250000000"}` | a `BigInt` (millisatoshi amounts of invoices) |

Any other number is a plain JSON number. A plain integer is always a safe integer.

## Notes for a port

- Amounts are JavaScript numbers (IEEE doubles). `requestSats`, `satsFor` and `fiatFor` are defined by the order of their floating-point operations: keep that order, and use doubles rather than 64-bit integers where the vectors hold values past 2^53.
- Rounding: `Math.round` rounds halves toward positive infinity (`-2.5` gives `-2`); `toFixed` and `toLocaleString('en-US')` are the formats the expected strings come from.
- Text lengths and `trim()` follow JavaScript: UTF-16 code units, and `trim()` removes the characters in the `around the token` cases and no others.

## Contract

These files are the contract between the TypeScript app and the Dart packages: the Dart tests read the committed copies in `packages/ilchon_core/test/vectors/` (made by `dart run tool/vectors.dart`), and `pnpm check` fails when a copy or a file here is stale.
