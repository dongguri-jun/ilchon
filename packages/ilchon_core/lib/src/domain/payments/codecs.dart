import 'package:crypto/crypto.dart' show sha256;

import '../shared/ascii.dart';

/// The two checksums of the bech32 family: BIP-173 (bech32) and BIP-350 (bech32m).
enum Bech32Checksum {
  /// BIP-173: segwit version 0 addresses and BOLT11 invoices.
  bech32(1),

  /// BIP-350: segwit version 1 and later.
  bech32m(0x2bc830a3);

  const Bech32Checksum(this._constant);

  final int _constant;
}

/// A decoded bech32 string: the human-readable part (lower case) and the 5-bit data words before the checksum.
typedef Bech32Data = ({String prefix, List<int> words});

const String _bech32Letters = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/// Decodes [text] with [checksum], or returns null when it is not a valid string of that kind.
///
/// Like the reference decoder: 8 to [maxLength] characters (no limit when null), all lower or all upper
/// case, the last `1` separates a non-empty prefix from at least six data characters.
Bech32Data? decodeBech32(String text, Bech32Checksum checksum, {int? maxLength = 90}) {
  if (text.length < 8 || (maxLength != null && text.length > maxLength)) return null;
  if (text.codeUnits.any((u) => u < 0x21 || u > 0x7e)) return null;
  final lowered = lowerAscii(text);
  if (lowered != text && text.codeUnits.any((u) => u >= 0x61 && u <= 0x7a)) return null;
  final separator = lowered.lastIndexOf('1');
  if (separator < 1) return null;
  final prefix = lowered.substring(0, separator);
  final data = lowered.substring(separator + 1);
  if (data.length < 6) return null;
  final digits = <int>[];
  for (final unit in data.codeUnits) {
    final digit = _bech32Letters.indexOf(String.fromCharCode(unit));
    if (digit < 0) return null;
    digits.add(digit);
  }
  final words = digits.sublist(0, digits.length - 6);
  final expected = _bech32Sum(prefix, words, checksum._constant);
  for (var i = 0; i < 6; i++) {
    if (digits[words.length + i] != expected[i]) return null;
  }
  return (prefix: prefix, words: words);
}

// Every intermediate value stays below 2^30, so the bit operations agree on every compile target.
int _polymodStep(int pre) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  final top = pre >> 25;
  var chk = (pre & 0x1ffffff) << 5;
  for (var i = 0; i < generators.length; i++) {
    if ((top >> i) & 1 == 1) chk ^= generators[i];
  }
  return chk;
}

List<int> _bech32Sum(String prefix, List<int> words, int constant) {
  var chk = 1;
  for (final c in prefix.codeUnits) {
    chk = _polymodStep(chk) ^ (c >> 5);
  }
  chk = _polymodStep(chk);
  for (final c in prefix.codeUnits) {
    chk = _polymodStep(chk) ^ (c & 0x1f);
  }
  for (final w in words) {
    chk = _polymodStep(chk) ^ w;
  }
  for (var i = 0; i < 6; i++) {
    chk = _polymodStep(chk);
  }
  chk ^= constant;
  return [for (var i = 0; i < 6; i++) (chk >> (5 * (5 - i))) & 31];
}

/// 5-bit [words] regrouped into bytes, or null when the padding is not canonical: more than four bits
/// left over, or left-over bits that are not zero.
List<int>? bytesFromWords(List<int> words) {
  final out = <int>[];
  var carry = 0;
  var bits = 0;
  for (final w in words) {
    carry = ((carry << 5) | w) & 0xffff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.add((carry >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (carry << (8 - bits)) & 0xff != 0) return null;
  return out;
}

const String _base58Letters = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/// Decodes base58check [text] and returns the payload without its four checksum bytes, or null when a
/// character is not base58 or the double SHA-256 checksum does not match.
List<int>? decodeBase58Check(String text) {
  var value = BigInt.zero;
  final base = BigInt.from(58);
  for (final unit in text.codeUnits) {
    final digit = _base58Letters.indexOf(String.fromCharCode(unit));
    if (digit < 0) return null;
    value = value * base + BigInt.from(digit);
  }
  var zeros = 0;
  while (zeros < text.length - 1 && text.codeUnitAt(zeros) == 0x31) {
    zeros++;
  }
  final valueBytes = <int>[];
  for (var v = value; v > BigInt.zero; v = v >> 8) {
    valueBytes.add((v & BigInt.from(0xff)).toInt());
  }
  if (valueBytes.isEmpty && text.isNotEmpty) valueBytes.add(0);
  final data = [...List.filled(zeros, 0), ...valueBytes.reversed];
  if (data.length < 4) return null;
  final payload = data.sublist(0, data.length - 4);
  final sum = sha256.convert(sha256.convert(payload).bytes).bytes;
  for (var i = 0; i < 4; i++) {
    if (sum[i] != data[payload.length + i]) return null;
  }
  return payload;
}
