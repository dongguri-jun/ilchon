import '../shared/ascii.dart';
import '../shared/instant.dart';
import 'codecs.dart';
import 'text.dart';

/// The network a Lightning invoice is for.
enum LnNetwork {
  /// Bitcoin mainnet: `lnbc`.
  mainnet,

  /// Testnet: `lntb`.
  testnet,

  /// Signet: `lntbs`.
  signet,

  /// Regtest: `lnbcrt`.
  regtest,
}

/// Seconds an invoice without an expiry field stays payable (BOLT11).
const int defaultExpirySeconds = 3600;

/// An invoice with this many seconds left or fewer is about to expire.
const int expiringSoonSeconds = 120;

/// A countdown is recounted this long after the expiry second, so a timer that fires a hair early still
/// sees the invoice as expired.
const int expiryRecountSlackMs = 500;

/// What a payer needs to see of a BOLT11 invoice before paying it. The signature and the payee are not
/// checked; the payer's wallet does that.
final class Invoice {
  const Invoice._({
    required this.invoice,
    required this.network,
    required this.amountMsat,
    required this.createdAt,
    required this.expiresAt,
    required this.description,
    required this.descriptionHash,
  });

  /// The invoice, lower-cased, without a `lightning:` prefix.
  final String invoice;

  /// The network it is for.
  final LnNetwork network;

  /// Millisatoshis asked for, or null for an "any amount" invoice. No upper limit.
  final BigInt? amountMsat;

  /// Unix seconds.
  final int createdAt;

  /// Unix seconds.
  final int expiresAt;

  /// The `d` field, when present and valid UTF-8.
  final String? description;

  /// The `h` field (hash of the description) in lower-case hex, when present.
  final String? descriptionHash;

  /// Whole satoshis asked for (rounded down, so 0 for less than one), or null for an "any amount" invoice.
  BigInt? get amountSats => amountMsat == null ? null : amountMsat! ~/ BigInt.from(1000);
}

/// [text] without white space around it and without one leading `lightning:` (any case).
String stripLightningScheme(String text) {
  final trimmed = trimWhitespace(text);
  return startsWithIgnoringCase(trimmed, 'lightning:') ? trimmed.substring('lightning:'.length) : trimmed;
}

const List<(String, LnNetwork)> _prefixes = [
  // Longest first: `lnbcrt` and `lntbs` start with `lnbc` and `lntb`.
  ('lnbcrt', LnNetwork.regtest),
  ('lntbs', LnNetwork.signet),
  ('lnbc', LnNetwork.mainnet),
  ('lntb', LnNetwork.testnet),
];

const int _signatureWords = 104;
const int _timestampWords = 7;
const int _tagPaymentHash = 1;
const int _tagExpiry = 6;
const int _tagDescription = 13;
const int _tagDescriptionHash = 23;

/// [text] (bare or with `lightning:`) read as a BOLT11 invoice, or null when it is not a well-formed one.
///
/// It must have a payment hash. The first expiry field counts; one over ten words (50 bits) makes the
/// invoice unreadable. A description or description hash of the wrong shape is skipped.
Invoice? decodeInvoice(String text) {
  final raw = stripLightningScheme(text);
  final decoded = decodeBech32(raw, Bech32Checksum.bech32, maxLength: null);
  if (decoded == null) return null;
  final (base, network) = _prefixes.firstWhere(
    (p) => decoded.prefix.startsWith(p.$1),
    orElse: () => ('', LnNetwork.mainnet),
  );
  if (base.isEmpty) return null;
  final amount = _amountOf(decoded.prefix.substring(base.length));
  if (amount == null) return null;

  final words = decoded.words;
  if (words.length < _timestampWords + _signatureWords) return null;
  final data = words.sublist(0, words.length - _signatureWords);
  final createdAt = _wordsToInt(data.sublist(0, _timestampWords));

  int? expiry;
  String? description;
  String? descriptionHash;
  var hasPaymentHash = false;
  var i = _timestampWords;
  while (i < data.length) {
    if (i + 3 > data.length) return null;
    final tag = data[i];
    final length = data[i + 1] * 32 + data[i + 2];
    if (i + 3 + length > data.length) return null;
    final field = data.sublist(i + 3, i + 3 + length);
    i += 3 + length;
    if (tag == _tagPaymentHash && length == 52) {
      hasPaymentHash = true;
    } else if (tag == _tagExpiry && expiry == null) {
      if (length > 10) return null;
      expiry = _wordsToInt(field);
    } else if (tag == _tagDescription && description == null) {
      final bytes = bytesFromWords(field);
      description = bytes == null ? null : decodeUtf8Strict(bytes, dropByteOrderMark: true);
    } else if (tag == _tagDescriptionHash && length == 52 && descriptionHash == null) {
      final bytes = bytesFromWords(field);
      if (bytes != null && bytes.length == 32) descriptionHash = _hex(bytes);
    }
  }
  if (!hasPaymentHash) return null;

  return Invoice._(
    invoice: lowerAscii(raw),
    network: network,
    amountMsat: amount.msat,
    createdAt: createdAt,
    expiresAt: createdAt + (expiry ?? defaultExpirySeconds),
    description: description,
    descriptionHash: descriptionHash,
  );
}

final RegExp _amountPart = RegExp(r'^([1-9][0-9]*)([munp]?)$');

/// The amount part of the prefix: `msat` null for an "any amount" invoice. Null when it is not an amount.
({BigInt? msat})? _amountOf(String text) {
  if (text.isEmpty) return (msat: null);
  final m = _amountPart.firstMatch(text);
  if (m == null) return null;
  final digits = BigInt.parse(m.group(1)!);
  final ten = BigInt.from(10);
  return switch (m.group(2)) {
    // One pico-bitcoin is a tenth of a millisatoshi; smaller amounts cannot be paid.
    'p' => digits % ten == BigInt.zero ? (msat: digits ~/ ten) : null,
    'n' => (msat: digits * BigInt.from(100)),
    'u' => (msat: digits * BigInt.from(100000)),
    'm' => (msat: digits * BigInt.from(100000000)),
    _ => (msat: digits * BigInt.from(100000000000)),
  };
}

// At most ten words (50 bits): multiplying, not shifting, keeps it exact on every compile target.
int _wordsToInt(List<int> words) => words.fold(0, (n, w) => n * 32 + w);

String _hex(List<int> bytes) => [for (final b in bytes) b.toRadixString(16).padLeft(2, '0')].join();

/// Invoice-looking strings in pasted [text], in order: every white-space-separated token, except that a
/// `bitcoin:` link gives only the values of its `lightning=` parameters (percent-decoded once; one with a
/// broken escape is skipped).
List<String> invoiceCandidates(String text) => [
  for (final token in splitAtWhitespace(text))
    if (token.isNotEmpty)
      if (startsWithIgnoringCase(token, 'bitcoin:')) ..._lightningParameters(token) else token,
];

Iterable<String> _lightningParameters(String link) sync* {
  final q = link.indexOf('?');
  if (q < 0) return;
  for (final pair in link.substring(q + 1).split('&')) {
    final parts = pair.split('=');
    final value = parts.length > 1 ? parts[1] : '';
    if (lowerAscii(parts[0]) != 'lightning' || value.isEmpty) continue;
    final decoded = decodeUriComponent(value);
    if (decoded != null) yield decoded;
  }
}

/// Seconds left before [invoice] expires at [now]; zero or negative once expired.
int secondsLeft(Invoice invoice, Instant now) => invoice.expiresAt - (now.epochMs / 1000).floor();

/// How long until a countdown to [expiresAt] (Unix seconds) should be recounted: every [intervalMs], but
/// sooner when the expiry (plus [expiryRecountSlackMs]) comes first. Null once that moment has passed.
int? msUntilRecount(int expiresAt, Instant now, int intervalMs) {
  final recountAt = expiresAt * 1000.0 + expiryRecountSlackMs;
  if (now.epochMs >= recountAt) return null;
  final left = recountAt - now.epochMs;
  return intervalMs < left ? intervalMs : left.toInt();
}

/// Something a payer should know before paying.
enum InvoiceIssue {
  /// The invoice can no longer be paid.
  expired,

  /// It is not a mainnet invoice.
  notMainnet,

  /// It does not say how much.
  noAmount,

  /// It expires within [expiringSoonSeconds].
  expiringSoon,
}

/// What a payer should know about [invoice] at [now], most serious first. An empty list means nothing
/// stood out, not that the invoice is safe to pay.
List<InvoiceIssue> invoiceIssues(Invoice invoice, Instant now) {
  final left = secondsLeft(invoice, now);
  return [
    if (left <= 0) InvoiceIssue.expired,
    if (invoice.network != LnNetwork.mainnet) InvoiceIssue.notMainnet,
    if (invoice.amountMsat == null) InvoiceIssue.noAmount,
    if (left > 0 && left <= expiringSoonSeconds) InvoiceIssue.expiringSoon,
  ];
}
