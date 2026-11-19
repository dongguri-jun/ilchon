import 'codecs.dart';
import 'sats.dart';
import 'text.dart';

/// The longest address accepted: the bech32 limit.
const int maxAddressLength = 90;

/// The kinds of mainnet address today's wallets can pay.
enum AddressKind {
  /// Pay to public key hash: base58, starts with `1`.
  p2pkh,

  /// Pay to script hash: base58, starts with `3`.
  p2sh,

  /// Segwit version 0, 20-byte program: `bc1q`, 42 characters.
  p2wpkh,

  /// Segwit version 0, 32-byte program: `bc1q`, 62 characters.
  p2wsh,

  /// Taproot, segwit version 1 with a 32-byte program: `bc1p`.
  p2tr,
}

/// A mainnet address someone can pay today.
final class ParsedAddress {
  const ParsedAddress._(this.address, this.kind);

  /// The address: bech32 lower-cased, base58 as given.
  final String address;

  /// What kind of address it is.
  final AddressKind kind;

  @override
  bool operator ==(Object other) => other is ParsedAddress && other.address == address && other.kind == kind;

  @override
  int get hashCode => Object.hash(address, kind);
}

/// [text] as a mainnet address someone can pay today (p2pkh, p2sh, p2wpkh, p2wsh, p2tr), or null.
///
/// White space around it is ignored. Segwit version 2 and later, and version 1 programs that are not 32
/// bytes, are valid by BIP-350 but refused: some wallets cannot send to them.
ParsedAddress? parseAddress(String text) {
  final s = trimWhitespace(text);
  if (s.isEmpty || s.length > maxAddressLength) return null;

  if (startsWithIgnoringCase(s, 'bc1')) {
    if (hasMixedCase(s)) return null;
    final t = lowerAscii(s);
    final (data, checksum) = switch ((
      decodeBech32(t, Bech32Checksum.bech32),
      decodeBech32(t, Bech32Checksum.bech32m),
    )) {
      (final Bech32Data d, _) => (d, Bech32Checksum.bech32),
      (null, final Bech32Data d) => (d, Bech32Checksum.bech32m),
      _ => (null, null),
    };
    if (data == null || data.prefix != 'bc' || data.words.isEmpty) return null;
    final program = bytesFromWords(data.words.sublist(1));
    if (program == null) return null;
    return switch ((data.words.first, checksum, program.length)) {
      (0, Bech32Checksum.bech32, 20) => ParsedAddress._(t, AddressKind.p2wpkh),
      (0, Bech32Checksum.bech32, 32) => ParsedAddress._(t, AddressKind.p2wsh),
      (1, Bech32Checksum.bech32m, 32) => ParsedAddress._(t, AddressKind.p2tr),
      _ => null,
    };
  }

  final payload = decodeBase58Check(s);
  if (payload == null || payload.length != 21) return null;
  return switch (payload.first) {
    0x00 => ParsedAddress._(s, AddressKind.p2pkh),
    0x05 => ParsedAddress._(s, AddressKind.p2sh),
    _ => null,
  };
}

/// Why a pasted or typed address was refused.
enum AddressProblem {
  /// A Lightning invoice, offer, LNURL or `lightning:` link where an address was asked for.
  lightning,

  /// A valid testnet or regtest address.
  testnet,

  /// Looks like a bitcoin address, but the checksum or the letter case is wrong.
  typo,

  /// A valid address today's wallets cannot pay, or a `bitcoin:` link to a good address.
  unsupported,

  /// Anything else.
  invalid,
}

final RegExp _base58Text = RegExp(r'^[1-9A-HJ-NP-Za-km-z]+$');
final RegExp _alphanumeric = RegExp(r'^[A-Za-z0-9]+$');
const List<String> _lightningPrefixes = ['lightning:', 'lnbc', 'lntb', 'lnurl1', 'lno1'];

/// Why [text] is not an address [parseAddress] accepts; null exactly when it accepts it.
///
/// The network is judged only after the checksum passes: a string that fails its checksum is a typo
/// whatever it starts with.
AddressProblem? addressProblem(String text) {
  final s = trimWhitespace(text);
  if (s.isEmpty) return AddressProblem.invalid;
  if (parseAddress(s) != null) return null;
  if (_lightningPrefixes.any((p) => startsWithIgnoringCase(s, p))) return AddressProblem.lightning;
  if (startsWithIgnoringCase(s, 'bitcoin:')) {
    final rest = s.substring('bitcoin:'.length);
    final q = rest.indexOf('?');
    final inner = q < 0 ? rest : rest.substring(0, q);
    if (inner.isEmpty || startsWithIgnoringCase(inner, 'bitcoin:')) return AddressProblem.invalid;
    return addressProblem(inner) ?? AddressProblem.unsupported;
  }
  if (s.length > maxAddressLength) return AddressProblem.invalid;

  if (['bc1', 'tb1', 'bcrt1'].any((p) => startsWithIgnoringCase(s, p))) {
    if (hasMixedCase(s)) return AddressProblem.typo;
    final t = lowerAscii(s);
    final prefix = (decodeBech32(t, Bech32Checksum.bech32) ?? decodeBech32(t, Bech32Checksum.bech32m))?.prefix;
    return switch (prefix) {
      null => s.length >= 14 ? AddressProblem.typo : AddressProblem.invalid,
      'tb' || 'bcrt' => AddressProblem.testnet,
      'bc' => AddressProblem.unsupported,
      _ => AddressProblem.invalid,
    };
  }

  final looksBase58 = '13mn2'.contains(s[0]) && s.length >= 26 && s.length <= 35 && _alphanumeric.hasMatch(s);
  final payload = _base58Text.hasMatch(s) ? decodeBase58Check(s) : null;
  if (payload == null) return looksBase58 ? AddressProblem.typo : AddressProblem.invalid;
  // Not a 21-byte address payload (a private key, an extended key): not an address of any kind.
  if (payload.length != 21) return AddressProblem.invalid;
  return payload.first == 0x6f || payload.first == 0xc4 ? AddressProblem.testnet : AddressProblem.unsupported;
}

/// `bitcoin:` and [address], with `?amount=` in decimal bitcoin ([btcText]) when [sats] is given (BIP-21).
/// The address is not checked.
String bip21(String address, Sats? sats) =>
    sats == null ? 'bitcoin:$address' : 'bitcoin:$address?amount=${btcText(sats)}';

/// A request to be paid on chain, read from a chat token by [parseOnchainRequest].
final class OnchainRequest {
  /// A request for [sats] (or any amount when null) to [address].
  const OnchainRequest(this.address, this.sats);

  /// Where to pay.
  final String address;

  /// How much, or null for any amount.
  final Sats? sats;

  /// The `bitcoin:` link of this request, rebuilt by [bip21], never the text as it was received.
  String get uri => bip21(address, sats);

  @override
  bool operator ==(Object other) => other is OnchainRequest && other.address == address && other.sats == sats;

  @override
  int get hashCode => Object.hash(address, sats);
}

/// A bare mainnet address, or a `bitcoin:` link to one (BIP-21), as an [OnchainRequest].
///
/// In a link, `amount` (decimal bitcoin, at most eight decimals) becomes [OnchainRequest.sats]; any `req-`
/// parameter makes the link unusable; other parameters are ignored. Null when the address fails
/// [parseAddress], or the amount is malformed, zero, over 21 million bitcoin or given twice.
OnchainRequest? parseOnchainRequest(String token) {
  final s = trimWhitespace(token);
  if (!startsWithIgnoringCase(s, 'bitcoin:')) {
    final parsed = parseAddress(s);
    return parsed == null ? null : OnchainRequest(parsed.address, null);
  }
  final rest = s.substring('bitcoin:'.length);
  final q = rest.indexOf('?');
  final parsed = parseAddress(q < 0 ? rest : rest.substring(0, q));
  if (parsed == null) return null;
  Sats? sats;
  var seenAmount = false;
  if (q >= 0) {
    for (final pair in rest.substring(q + 1).split('&')) {
      if (pair.isEmpty) continue;
      final eq = pair.indexOf('=');
      final key = lowerAscii(eq < 0 ? pair : pair.substring(0, eq));
      if (key.startsWith('req-')) return null;
      if (key != 'amount') continue;
      if (seenAmount) return null;
      seenAmount = true;
      sats = _satsOfBtc(eq < 0 ? '' : pair.substring(eq + 1));
      if (sats == null) return null;
    }
  }
  return OnchainRequest(parsed.address, sats);
}

final RegExp _btcAmount = RegExp(r'^([0-9]{1,8})(?:\.([0-9]{1,8}))?$');

Sats? _satsOfBtc(String value) {
  final m = _btcAmount.firstMatch(value);
  if (m == null) return null;
  final whole = int.parse(m.group(1)!);
  if (whole > maxSats ~/ satsPerBtc) return null;
  return Sats.fromInt(whole * satsPerBtc + int.parse((m.group(2) ?? '').padRight(8, '0')));
}

/// What the on-chain card shows, copies and puts in its QR code.
final class OnchainCardValues {
  const OnchainCardValues._(this.address, this.btc, this.link);

  /// The address alone, for "copy address".
  final String address;

  /// The bitcoin line under the satoshis, or null for a card without an amount.
  final String? btc;

  /// The `bitcoin:` link with the same amount as [btc]: the QR code, "open in wallet" and "copy link".
  final String link;
}

/// The on-chain card's values from one place, so the amount the seller reads and the amount the wallet
/// receives cannot differ.
OnchainCardValues onchainCardValues(OnchainRequest request) => OnchainCardValues._(
  request.address,
  request.sats == null ? null : btcText(request.sats!),
  bip21(request.address, request.sats),
);
