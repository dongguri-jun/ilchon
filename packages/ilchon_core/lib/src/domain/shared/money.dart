/// The largest fiat amount in minor units: twelve digits, far below 2^53, so exact on every compile target.
const int maxMinor = 999999999999;

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
