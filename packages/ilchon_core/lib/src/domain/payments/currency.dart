import '../shared/lang.dart';
import 'text.dart';

/// Which keyboard an amount field asks the phone for.
enum AmountKeyboard {
  /// Digits only.
  numeric,

  /// Digits and a decimal point.
  decimal,
}

/// A fiat currency an offer can be in. Everything that depends on the currency comes from this table.
enum Currency {
  /// South Korean won. Whole won only.
  krw(
    code: 'KRW',
    decimals: 0,
    symbol: '₩',
    maxIntDigits: 12,
    quickAdd: [10000, 50000, 100000, 1000000],
    keyboard: AmountKeyboard.numeric,
  ),

  /// US dollar, in cents.
  usd(
    code: 'USD',
    decimals: 2,
    symbol: r'$',
    maxIntDigits: 9,
    quickAdd: [10, 50, 100, 500],
    keyboard: AmountKeyboard.decimal,
  ),

  /// Japanese yen. Whole yen only. The symbol is U+00A5, not the fullwidth U+FFE5.
  jpy(
    code: 'JPY',
    decimals: 0,
    symbol: '¥',
    maxIntDigits: 12,
    quickAdd: [10000, 50000, 100000, 500000],
    keyboard: AmountKeyboard.numeric,
  );

  const Currency({
    required this.code,
    required this.decimals,
    required this.symbol,
    required this.maxIntDigits,
    required this.quickAdd,
    required this.keyboard,
  });

  /// The ISO 4217 code: `KRW`, `USD`, `JPY`.
  final String code;

  /// Digits after the point: 0 for whole units only.
  final int decimals;

  /// Shown before the amount in every language.
  final String symbol;

  /// How many digits before the point the amount field accepts.
  final int maxIntDigits;

  /// The four quick-add amounts, in major units.
  final List<int> quickAdd;

  /// The keyboard of the amount field.
  final AmountKeyboard keyboard;

  /// Minor units in one major unit: 1 for won and yen, 100 for dollars.
  int get minorPerUnit => decimals == 0 ? 1 : 100;

  /// The currency with the exact, case-sensitive [code], or null: `jpy` and `EUR` are not currencies.
  static Currency? tryParse(String code) => values.where((c) => c.code == code).firstOrNull;
}

/// The currency a new offer starts in.
///
/// Korean starts in won and Japanese in yen. English starts in dollars unless [browserLanguages] (the
/// browser's preferred languages, most preferred first) names Japanese before Korean or English.
Currency defaultCurrency(Lang lang, [List<String> browserLanguages = const []]) {
  switch (lang) {
    case Lang.ko:
      return Currency.krw;
    case Lang.ja:
      return Currency.jpy;
    case Lang.en:
      for (final tag in browserLanguages) {
        final base = lowerAscii(tag).split('-').first;
        if (base == 'ja') return Currency.jpy;
        if (base == 'ko' || base == 'en') break;
      }
      return Currency.usd;
  }
}
