import 'currency.dart';
import 'text.dart';

/// The largest fiat amount in minor units: twelve digits, far below 2^53, so exact on every compile target.
const int maxMinor = 999999999999;

/// How far above the trade amount an invoice may ask before it is flagged: prices move while people talk.
const double overTolerance = 0.03;

/// A fiat amount in the smallest unit of its currency (won, yen or cents): a whole number from 1 to
/// [maxMinor]. Every amount that is stored, sent or subtracted is one.
final class Money {
  const Money._(this.minor);

  /// The amount in minor units.
  final int minor;

  /// Makes a [Money], or returns null when [minor] is outside 1 to [maxMinor].
  static Money? fromMinor(int minor) => minor >= 1 && minor <= maxMinor ? Money._(minor) : null;

  @override
  bool operator ==(Object other) => other is Money && other.minor == minor;

  @override
  int get hashCode => minor.hashCode;

  @override
  String toString() => 'Money(<redacted>)';
}

void _checkAmount(int minor) => RangeError.checkNotNegative(minor, 'minor');

String _wholeAndCents(int minor) {
  final cents = minor % 100;
  return '${groupThousands('${(minor - cents) ~/ 100}')}.${cents.toString().padLeft(2, '0')}';
}

/// [minor] with the currency symbol and thousands separators in every language: `₩50,000`, `¥50,000`,
/// `$1.05`. Throws [RangeError] for a negative amount.
String formatMoney(int minor, Currency currency) {
  _checkAmount(minor);
  return currency.decimals == 0
      ? '${currency.symbol}${groupThousands('$minor')}'
      : '${currency.symbol}${_wholeAndCents(minor)}';
}

/// [minor] without symbol, for sentences that put a unit word after it: `1,000`, `12.50`, `12.05`, `12`.
/// A whole dollar amount has no cents; any other has two digits. Throws [RangeError] for a negative amount.
String formatMinorNumber(int minor, Currency currency) {
  _checkAmount(minor);
  if (currency.decimals == 0 || minor % 100 == 0) return groupThousands('${minor ~/ currency.minorPerUnit}');
  return _wholeAndCents(minor);
}

/// The amount field text for [minor], in the shape [sanitizeAmount] gives: `1,234,567` for whole units,
/// `1,234` or `1,234.05` for cents. Throws [RangeError] for a negative amount.
String minorToInput(int minor, Currency currency) => formatMinorNumber(minor, currency);

/// The premium on the market price as shown: `+1%`, `−0.5%` (with U+2212), `0%`. Rounded to two decimals
/// of the exact binary value, halves away from zero, trailing zeros dropped.
String formatPremium(double premiumPct) {
  final rounded = double.parse(_toFixed2(premiumPct));
  if (rounded > 0) return '+${_numberText(rounded)}%';
  if (rounded < 0) return '−${_numberText(-rounded)}%';
  return '0%';
}

String _toFixed2(double x) {
  if (!x.isFinite || x.abs() >= 1e21) return '$x';
  final exact = _exactDecimal(x.abs());
  final scaled = exact.numerator * BigInt.from(100);
  var whole = scaled ~/ exact.denominator;
  if ((scaled - whole * exact.denominator) * BigInt.two >= exact.denominator) whole += BigInt.one;
  final digits = whole.toString().padLeft(3, '0');
  final sign = x < 0 ? '-' : '';
  return '$sign${digits.substring(0, digits.length - 2)}.${digits.substring(digits.length - 2)}';
}

/// [x] (finite, not negative) as an exact fraction: a double is a whole number times a power of two.
({BigInt numerator, BigInt denominator}) _exactDecimal(double x) {
  var denominator = BigInt.one;
  var value = x;
  while (value != value.truncateToDouble()) {
    value *= 2;
    denominator *= BigInt.two;
  }
  return (numerator: BigInt.from(value), denominator: denominator);
}

String _numberText(double x) => x == x.truncateToDouble() && x.abs() < 1e21 ? wholeNumberText(x) : '$x';

/// [sats] rounded to whole satoshis (halves up) with thousands separators: `66,667`. Takes the fractional
/// estimates [satsFor] gives. Throws [ArgumentError] for a negative or not finite number.
String formatSats(double sats) {
  if (!sats.isFinite || sats.isNegative) throw ArgumentError.value(sats, 'sats', 'not a finite amount');
  return groupThousands(wholeNumberText(roundHalfUp(sats)));
}

double? _priceOf(double? rate, double premiumPct) {
  if (rate == null) return null;
  final price = rate * (1 + premiumPct / 100);
  return price.isFinite && price > 0 ? price : null;
}

/// Satoshis [minor] buys when one bitcoin costs [rate] major units plus [premiumPct] percent, or null
/// without a usable rate. An estimate for display, not rounded; never stored.
double? satsFor(int minor, Currency currency, double? rate, double premiumPct) {
  final price = _priceOf(rate, premiumPct);
  if (price == null) return null;
  return (minor / currency.minorPerUnit / price) * 1e8;
}

/// The whole satoshis a buyer asks for [amount] at [rate] plus [premiumPct], rounded down so it never asks
/// more than the seller's own price. Null without a usable rate or below one satoshi.
int? requestSats(Money amount, Currency currency, double? rate, double premiumPct) {
  if (rate == null || _priceOf(rate, premiumPct) == null) return null;
  final sats = ((amount.minor * 1e8 * 100) / (currency.minorPerUnit * rate * (100 + premiumPct))).floorToDouble();
  return sats.isFinite && sats >= 1 && sats <= 9007199254740991 ? sats.toInt() : null;
}

/// The fiat value of [sats] at [rate] plus [premiumPct], or null without a usable rate or when it rounds
/// outside 1 to [maxMinor].
Money? fiatFor(int sats, double? rate, double premiumPct, Currency currency) {
  final price = _priceOf(rate, premiumPct);
  if (price == null) return null;
  final minor = roundHalfUp((sats / 1e8) * price * currency.minorPerUnit);
  return minor >= 1 && minor <= maxMinor ? Money.fromMinor(minor.toInt()) : null;
}

/// Whether [amountSats] asks for more than [bound] is worth at [rate] plus [premiumPct], by more than
/// [overTolerance]. Decided in whole numbers (the rate to a millionth, the premium to a ten-thousandth of
/// a percent), so an amount right on the limit is never flagged by a rounding error. False without a
/// usable rate or for an amount outside 0 to 2^53 - 1.
bool asksOver(int amountSats, Money bound, Currency currency, double? rate, double premiumPct) {
  if (rate == null || _priceOf(rate, premiumPct) == null) return false;
  if (amountSats < 0 || amountSats > 9007199254740991) return false;
  final r = BigInt.from(roundHalfUp(rate * 1000000));
  final f = BigInt.from(roundHalfUp((100 + premiumPct) * 10000));
  if (r <= BigInt.zero || f <= BigInt.zero) return false;
  final toleranceBp = BigInt.from((overTolerance * 10000).round());
  final left = BigInt.from(amountSats) * r * f * BigInt.from(currency.minorPerUnit) * BigInt.from(10000);
  final right =
      BigInt.from(bound.minor) *
      BigInt.from(100000000) *
      (BigInt.from(10000) + toleranceBp) *
      BigInt.from(1000000) *
      BigInt.from(100) *
      BigInt.from(10000);
  return left > right;
}

/// The amount field text read exactly into [Money]: commas ignored, at most two decimals for cents, none
/// for whole units. Null for anything else and for amounts outside 1 to [maxMinor] (`''`, `.`, `0`,
/// `1.234` in dollars, `1.5` in won).
Money? parseMinor(String text, Currency currency) {
  final t = text.replaceAll(',', '');
  if (currency.decimals == 0) {
    return _asciiDigits.hasMatch(t) ? _moneyOf(BigInt.parse(t)) : null;
  }
  final m = _decimalAmount.firstMatch(t);
  if (m == null) return null;
  final whole = m.group(1)!;
  final fraction = m.group(2) ?? '';
  if (whole.isEmpty && fraction.isEmpty) return null;
  return _moneyOf(
    BigInt.parse(whole.isEmpty ? '0' : whole) * BigInt.from(100) + BigInt.parse(fraction.padRight(2, '0')),
  );
}

final RegExp _asciiDigits = RegExp(r'^[0-9]+$');
final RegExp _decimalAmount = RegExp(r'^([0-9]*)(?:\.([0-9]{0,2}))?$');

Money? _moneyOf(BigInt minor) => minor <= BigInt.from(maxMinor) ? Money.fromMinor(minor.toInt()) : null;
