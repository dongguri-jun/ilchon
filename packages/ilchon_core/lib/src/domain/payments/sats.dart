/// Satoshis in one bitcoin.
const int satsPerBtc = 100000000;

/// All bitcoin there will ever be, in satoshis: 2.1 × 10^15, below 2^53, so exact on every compile target.
const int maxSats = 2100000000000000;

/// An amount someone can be asked to pay on chain: whole satoshis from 1 to [maxSats].
final class Sats {
  const Sats._(this.value);

  /// The number of satoshis.
  final int value;

  /// Makes a [Sats], or returns null when [value] is outside 1 to [maxSats].
  static Sats? fromInt(int value) => value >= 1 && value <= maxSats ? Sats._(value) : null;

  @override
  bool operator ==(Object other) => other is Sats && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'Sats(<redacted>)';
}

/// [sats] in decimal bitcoin, from whole numbers only: `98039` gives `0.00098039`, `100000000` gives `1`.
String btcText(Sats sats) {
  final fraction = sats.value % satsPerBtc;
  final whole = (sats.value - fraction) ~/ satsPerBtc;
  if (fraction == 0) return '$whole';
  return '$whole.${fraction.toString().padLeft(8, '0').replaceFirst(RegExp(r'0+$'), '')}';
}
