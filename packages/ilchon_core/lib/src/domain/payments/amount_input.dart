import '../shared/currency.dart';
import 'text.dart';

/// [raw] with the fullwidth digits ０ to ９ (U+FF10 to U+FF19), point ． (U+FF0E) and comma ，
/// (U+FF0C) of a Japanese keyboard turned into ASCII. Nothing else changes: ½, ① and ² stay as they are.
String toAsciiDigits(String raw) {
  final units = raw.codeUnits;
  if (!units.any(_isFullwidthAmountUnit)) return raw;
  return String.fromCharCodes([for (final u in units) _isFullwidthAmountUnit(u) ? u - 0xfee0 : u]);
}

bool _isFullwidthAmountUnit(int u) => (u >= 0xff10 && u <= 0xff19) || u == 0xff0e || u == 0xff0c;

/// How a change reached an amount field.
enum AmountInputMode {
  /// One keystroke, a deletion, or text being composed by a Korean or Japanese keyboard.
  type,

  /// More than one character at once: a paste, a drop, a keyboard suggestion.
  paste,
}

const Set<String> _compositionInputs = {'insertCompositionText', 'insertFromComposition', 'deleteCompositionText'};
const Set<String> _pasteInputs = {'insertFromPaste', 'insertFromDrop', 'insertReplacementText'};

/// The mode of a browser input event from its `inputType`, `data` and `isComposing`.
///
/// Composition is always [AmountInputMode.type]: while composing, [data] is the whole text composed so far.
/// Otherwise a paste, a drop, a replacement, or [data] of two or more characters (code points) is
/// [AmountInputMode.paste].
AmountInputMode amountInputMode({String? inputType, String? data, bool composing = false}) {
  if (composing || _compositionInputs.contains(inputType)) return AmountInputMode.type;
  if (_pasteInputs.contains(inputType)) return AmountInputMode.paste;
  return data != null && data.runes.length >= 2 ? AmountInputMode.paste : AmountInputMode.type;
}

final RegExp _nonDigit = RegExp(r'[^0-9]');
final RegExp _leadingZeros = RegExp(r'^0+(?=[0-9])');
final RegExp _pastedEnds = RegExp(r'^[^0-9.]+|[^0-9]+$');
final RegExp _shortFraction = RegExp(r'\.[0-9]{1,2}$');
final RegExp _notDigitOrPoint = RegExp(r'[^0-9.]');

/// What an amount field may hold of [raw], with thousands separators.
///
/// Fullwidth digits, comma and point become ASCII first ([toAsciiDigits]). For whole units (won, yen) a
/// typed point is just removed; in a [AmountInputMode.paste] the ends are trimmed of symbols and words,
/// a value that then starts with a point is empty, and one point followed by one or two final digits is
/// a fraction that is dropped (`12.75` gives `12`). Dollars keep one point and two decimals in any mode.
String sanitizeAmount(String raw, Currency currency, [AmountInputMode mode = AmountInputMode.type]) {
  final text = toAsciiDigits(raw);
  if (currency.decimals == 0) {
    var digits = text;
    if (mode == AmountInputMode.paste) {
      final trimmed = text.replaceAll(_pastedEnds, '');
      if (trimmed.startsWith('.')) return '';
      final looksDecimal = trimmed.split('.').length == 2 && _shortFraction.hasMatch(trimmed);
      digits = looksDecimal ? trimmed.substring(0, trimmed.lastIndexOf('.')) : trimmed;
    }
    return groupThousands(
      _cut(digits.replaceAll(_nonDigit, '').replaceFirst(_leadingZeros, ''), currency.maxIntDigits),
    );
  }
  final cleaned = text.replaceAll(_notDigitOrPoint, '');
  final dot = cleaned.indexOf('.');
  final intDigits = _cut(
    (dot < 0 ? cleaned : cleaned.substring(0, dot)).replaceFirst(_leadingZeros, ''),
    currency.maxIntDigits,
  );
  if (dot < 0) return groupThousands(intDigits);
  final fraction = _cut(cleaned.substring(dot + 1).replaceAll('.', ''), currency.decimals);
  return '${intDigits.isEmpty ? '0' : groupThousands(intDigits)}.$fraction';
}

String _cut(String text, int length) => text.length > length ? text.substring(0, length) : text;

/// How many characters before [position] in the raw field text [raw] survive [sanitizeAmount]: digits, and
/// the point when [currency] has decimals. The caret goes back after that many characters of the
/// formatted text. [position] counts UTF-16 code units; a negative one counts from the end.
int significantBefore(String raw, int position, [Currency? currency]) {
  final end = position < 0 ? (raw.length + position).clamp(0, raw.length) : position.clamp(0, raw.length);
  final keepPoint = currency != null && currency.decimals > 0;
  var count = 0;
  for (final u in toAsciiDigits(raw.substring(0, end)).codeUnits) {
    if ((u >= 0x30 && u <= 0x39) || (keepPoint && u == 0x2e)) count++;
  }
  return count;
}
