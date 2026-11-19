@Tags(['web'])
library;

import 'package:ilchon_core/ilchon_core.dart';
import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

import 'support/vector_runner.dart';
import 'vectors/money.g.dart';

const _null = Returned(null);
const _false = Returned(false);
final _notANumber = Returned(double.nan);

void main() {
  test('the currency table is the same as the vector file', () {
    final constants = VectorFile.parse(moneyVectors).constants! as Map<String, Object?>;
    expect(constants['CURRENCIES'], [for (final c in Currency.values) c.code]);
    expect(constants['CURRENCY'], {
      for (final c in Currency.values)
        c.code: {
          'decimals': c.decimals,
          'symbol': c.symbol,
          'maxIntDigits': c.maxIntDigits,
          'quickAdd': c.quickAdd,
          'inputMode': c.keyboard.name,
        },
    });
    expect(constants['DEFAULT_CURRENCY'], {for (final l in Lang.values) l.name: defaultCurrency(l).code});
    expect(constants['MINOR_PER_UNIT'], {for (final c in Currency.values) c.code: c.minorPerUnit});
    expect(constants['MAX_MINOR'], maxMinor);
    expect(constants['OVER_TOLERANCE'], overTolerance);
  });

  checkVectors(moneyVectors, {
    'defaultCurrency': Port(
      (a) => defaultCurrency(Lang.values.byName(a.text('lang')), a.has('langs') ? a.texts('langs') : const []).code,
      excused: 1,
    ),
    'isCurrency': Port((a) => Currency.tryParse(a.text('value')) != null, refusals: [_false], excused: 5),
    'isMinor': Port((a) => Money.fromMinor(a.whole('value')) != null, refusals: [_false], excused: 14),
    'formatMoney': Port((a) => formatMoney(a.whole('minor'), a.currency('currency')), excused: 17),
    'formatMinorNumber': Port((a) => formatMinorNumber(a.whole('minor'), a.currency('currency')), excused: 7),
    'formatFee': Port((a) => formatPremium(a.number('feePct'))),
    'formatSats': Port((a) => formatSats(a.number('sats')), excused: 8),
    'satsFor': Port(
      (a) => satsFor(a.whole('minor'), a.currency('currency'), a.optionalNumber('rate'), a.number('feePct')),
      refusals: [_null],
      excused: 4,
    ),
    'requestSats': Port(
      (a) => requestSats(a.money('minor'), a.currency('currency'), a.optionalNumber('rate'), a.number('feePct')),
      refusals: [_null],
      cannotExpress: {
        'fractional amount': 'a trade amount is a Money: whole minor units up to $maxMinor',
        'amount 2^53': 'a trade amount is a Money: whole minor units up to $maxMinor',
      },
      excused: 6,
    ),
    'fiatFor': Port(
      (a) => fiatFor(a.whole('sats'), a.optionalNumber('rate'), a.number('feePct'), a.currency('currency'))?.minor,
      refusals: [_null],
      excused: 4,
    ),
    'asksOver': Port(
      (a) => asksOver(
        a.whole('amountSats'),
        a.money('boundMinor'),
        a.currency('currency'),
        a.optionalNumber('rate'),
        a.number('feePct'),
      ),
      refusals: [_false],
      excused: 8,
    ),
    'parseMinor': Port(
      (a) => parseMinor(a.text('text'), a.currency('currency'))?.minor ?? double.nan,
      refusals: [_notANumber],
    ),
    'toAsciiDigits': Port((a) => toAsciiDigits(a.text('raw'))),
    'amountInputMode': Port(
      (a) => amountInputMode(
        inputType: a.optionalText('inputType'),
        data: a.optionalText('data'),
        composing: a.flag('composing'),
      ).name,
    ),
    'sanitizeAmount': Port(
      (a) => sanitizeAmount(
        a.text('raw'),
        a.currency('currency'),
        a.has('mode') ? AmountInputMode.values.byName(a.text('mode')) : AmountInputMode.type,
      ),
    ),
    'significantBefore': Port((a) => significantBefore(a.text('raw'), a.whole('pos'), a.optionalCurrency('currency'))),
    'minorToInput': Port((a) => minorToInput(a.whole('minor'), a.currency('currency')), excused: 7),
  });
}
