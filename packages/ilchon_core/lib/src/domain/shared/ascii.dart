const int _kelvinSign = 0x212a;

/// Whether the UTF-16 [unit] is A to Z.
bool isUpperAscii(int unit) => unit >= 0x41 && unit <= 0x5a;

/// Whether the UTF-16 [unit] is a letter that lower-casing changes: A to Z or the Kelvin sign (U+212A).
bool isLowerable(int unit) => isUpperAscii(unit) || unit == _kelvinSign;

/// [text] with A to Z and the Kelvin sign (U+212A) lowered; every other character kept.
///
/// For text that is ASCII apart from Kelvin signs this is exactly `toLowerCase()` of the web platform:
/// the Kelvin sign is the one character outside ASCII that it lowers to an ASCII letter. Every caller
/// either compares the result with ASCII words or rejects anything else that is not ASCII, so the
/// characters left as they are never change a result.
String lowerAscii(String text) {
  final units = text.codeUnits;
  if (!units.any(isLowerable)) return text;
  return String.fromCharCodes([for (final u in units) isUpperAscii(u) ? u + 0x20 : (u == _kelvinSign ? 0x6b : u)]);
}
