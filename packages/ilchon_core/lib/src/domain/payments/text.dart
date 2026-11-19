// Text rules shared by the payment readers. They follow the web platform (ECMAScript string methods,
// `decodeURIComponent`, the WHATWG UTF-8 decoder) rather than Dart's own `trim`, `toLowerCase` and
// `utf8`: pasted payment text must be read the same way by every client and on every compile target,
// and Dart's versions differ between the VM and the web in exactly these corners (U+0085, the BOM,
// encoded surrogates).

/// White space as the web platform defines it for `trim()` and `\s`: tab, line feed, vertical tab, form
/// feed, carriage return, space, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F,
/// U+3000 and the byte order mark U+FEFF. U+0085, U+180E and U+200B are not white space.
bool isWhitespaceUnit(int unit) => switch (unit) {
  0x09 || 0x0a || 0x0b || 0x0c || 0x0d || 0x20 || 0xa0 || 0x1680 => true,
  0x2028 || 0x2029 || 0x202f || 0x205f || 0x3000 || 0xfeff => true,
  _ => unit >= 0x2000 && unit <= 0x200a,
};

/// [text] without white space at either end.
String trimWhitespace(String text) {
  var start = 0;
  var end = text.length;
  while (start < end && isWhitespaceUnit(text.codeUnitAt(start))) {
    start++;
  }
  while (end > start && isWhitespaceUnit(text.codeUnitAt(end - 1))) {
    end--;
  }
  return text.substring(start, end);
}

/// [text] cut at every run of white space. With [keepSeparators] the runs are kept as parts of their own,
/// so the parts joined give [text] back. Leading or trailing white space gives an empty first or last part.
List<String> splitAtWhitespace(String text, {bool keepSeparators = false}) {
  final parts = <String>[];
  var start = 0;
  var i = 0;
  while (i < text.length) {
    if (!isWhitespaceUnit(text.codeUnitAt(i))) {
      i++;
      continue;
    }
    final runStart = i;
    while (i < text.length && isWhitespaceUnit(text.codeUnitAt(i))) {
      i++;
    }
    parts.add(text.substring(start, runStart));
    if (keepSeparators) parts.add(text.substring(runStart, i));
    start = i;
  }
  parts.add(text.substring(start));
  return parts;
}

const int _kelvinSign = 0x212a;

bool _isUpperAscii(int unit) => unit >= 0x41 && unit <= 0x5a;

/// [text] with A to Z and the Kelvin sign (U+212A) lowered; every other character kept.
///
/// For text that is ASCII apart from Kelvin signs this is exactly `toLowerCase()` of the web platform:
/// the Kelvin sign is the one character outside ASCII that it lowers to an ASCII letter. Every caller
/// either compares the result with ASCII words or rejects anything else that is not ASCII, so the
/// characters left as they are never change a result.
String lowerAscii(String text) {
  final units = text.codeUnits;
  if (!units.any((u) => _isUpperAscii(u) || u == _kelvinSign)) return text;
  return String.fromCharCodes([for (final u in units) _isUpperAscii(u) ? u + 0x20 : (u == _kelvinSign ? 0x6b : u)]);
}

/// Whether [text] holds both a letter lowering changes and a letter raising changes: A to Z or the Kelvin
/// sign, and a to z. This is the bech32 "mixed case" test for text that is ASCII apart from Kelvin signs.
bool hasMixedCase(String text) {
  var lowerable = false;
  var raisable = false;
  for (final u in text.codeUnits) {
    if (_isUpperAscii(u) || u == _kelvinSign) lowerable = true;
    if (u >= 0x61 && u <= 0x7a) raisable = true;
  }
  return lowerable && raisable;
}

/// Whether [text] starts with [prefix], comparing ASCII letters without case. [prefix] is lower-case ASCII.
/// A character outside ASCII never matches an ASCII letter, as in a case-insensitive regular expression.
bool startsWithIgnoringCase(String text, String prefix) {
  if (text.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) {
    final u = text.codeUnitAt(i);
    if ((_isUpperAscii(u) ? u + 0x20 : u) != prefix.codeUnitAt(i)) return false;
  }
  return true;
}

/// Plain decimal [digits] with a comma every three digits from the right: `1234567` gives `1,234,567`.
String groupThousands(String digits) {
  final head = digits.length % 3;
  final out = StringBuffer(digits.substring(0, head));
  for (var i = head; i < digits.length; i += 3) {
    if (out.isNotEmpty) out.write(',');
    out.write(digits.substring(i, i + 3));
  }
  return out.toString();
}

/// The nearest whole number to [x], halves toward positive infinity (`-2.5` gives `-2`): `Math.round`.
double roundHalfUp(double x) {
  if (!x.isFinite) return x;
  final floor = x.floorToDouble();
  final rounded = x - floor >= 0.5 ? floor + 1 : floor;
  return rounded == 0 && x < 0 ? -0.0 : rounded;
}

/// All decimal digits of the whole number [whole], exact also past 2^53.
String wholeNumberText(double whole) =>
    whole.abs() < 9007199254740991 ? whole.toInt().toString() : BigInt.from(whole).toString();

/// `decodeURIComponent`: every `%XX` escape decoded as UTF-8. Null where that throws: a `%` not followed
/// by two hex digits, or escapes that are not well-formed UTF-8 (overlong, surrogates, past U+10FFFF).
String? decodeUriComponent(String text) {
  int? escapeAt(int at) {
    if (at + 2 >= text.length || text.codeUnitAt(at) != 0x25) return null;
    final high = _hexValue(text.codeUnitAt(at + 1));
    final low = _hexValue(text.codeUnitAt(at + 2));
    return high == null || low == null ? null : high * 16 + low;
  }

  final out = StringBuffer();
  var i = 0;
  while (i < text.length) {
    final percent = text.indexOf('%', i);
    if (percent < 0) {
      out.write(text.substring(i));
      break;
    }
    out.write(text.substring(i, percent));
    final first = escapeAt(percent);
    if (first == null) return null;
    i = percent + 3;
    final length = switch (first) {
      < 0x80 => 1,
      >= 0xc0 && < 0xe0 => 2,
      >= 0xe0 && < 0xf0 => 3,
      >= 0xf0 && < 0xf8 => 4,
      _ => 0,
    };
    if (length == 0) return null;
    final bytes = [first];
    for (var k = 1; k < length; k++) {
      final next = escapeAt(i);
      if (next == null || next & 0xc0 != 0x80) return null;
      bytes.add(next);
      i += 3;
    }
    final decoded = decodeUtf8Strict(bytes);
    if (decoded == null) return null;
    out.write(decoded);
  }
  return out.toString();
}

int? _hexValue(int unit) => switch (unit) {
  >= 0x30 && <= 0x39 => unit - 0x30,
  >= 0x41 && <= 0x46 => unit - 0x37,
  >= 0x61 && <= 0x66 => unit - 0x57,
  _ => null,
};

/// [bytes] as UTF-8, or null when they are not well-formed UTF-8 (the WHATWG decoder in fatal mode).
/// With [dropByteOrderMark] a byte order mark at the very start is dropped, as `TextDecoder` does.
String? decodeUtf8Strict(List<int> bytes, {bool dropByteOrderMark = false}) {
  final codePoints = <int>[];
  final startsWithMark = bytes.length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;
  var i = dropByteOrderMark && startsWithMark ? 3 : 0;
  while (i < bytes.length) {
    final lead = bytes[i++];
    if (lead < 0x80) {
      codePoints.add(lead);
      continue;
    }
    // Continuation bytes, the lead's payload, and the allowed range of the first continuation byte
    // (narrowed where the plain range would allow an overlong form, a surrogate or a value past U+10FFFF).
    final (int need, int value, int lower, int upper) = switch (lead) {
      >= 0xc2 && <= 0xdf => (1, lead & 0x1f, 0x80, 0xbf),
      0xe0 => (2, lead & 0x0f, 0xa0, 0xbf),
      0xed => (2, lead & 0x0f, 0x80, 0x9f),
      >= 0xe1 && <= 0xef => (2, lead & 0x0f, 0x80, 0xbf),
      0xf0 => (3, lead & 0x07, 0x90, 0xbf),
      0xf4 => (3, lead & 0x07, 0x80, 0x8f),
      >= 0xf1 && <= 0xf3 => (3, lead & 0x07, 0x80, 0xbf),
      _ => (0, 0, 0, 0),
    };
    if (need == 0) return null;
    var codePoint = value;
    for (var k = 0; k < need; k++) {
      if (i >= bytes.length) return null;
      final byte = bytes[i++];
      final (lo, hi) = k == 0 ? (lower, upper) : (0x80, 0xbf);
      if (byte < lo || byte > hi) return null;
      codePoint = codePoint * 64 + (byte & 0x3f);
    }
    codePoints.add(codePoint);
  }
  return String.fromCharCodes(codePoints);
}
