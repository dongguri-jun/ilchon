import 'bolt11.dart';
import 'onchain.dart';
import 'text.dart';

/// A longer token is never read as a payment request.
const int paymentTokenMaxLength = 4096;

// A BOLT11 invoice is never shorter: its signature alone is 104 characters.
const int _invoiceMinLength = 100;
const int _addressMinLength = 26;

/// A payment request found in chat text: what the trade room shows as a card. Sending one is sending the
/// token as plain chat text.
sealed class PaymentRequest {
  const PaymentRequest();

  /// What identifies the request: the same id is the same payment.
  String get id;

  /// Whole satoshis asked for, or null for any amount.
  BigInt? get amountSats;

  /// Unix seconds after which it cannot be paid, or null when it does not expire.
  int? get expiresAt;

  /// False for a testnet, signet or regtest invoice.
  bool get mainnet;
}

/// A BOLT11 invoice, bare, as a `lightning:` link, or as the `lightning=` value of a `bitcoin:` link.
final class LightningPaymentRequest extends PaymentRequest {
  const LightningPaymentRequest._(this.invoice);

  /// The decoded invoice.
  final Invoice invoice;

  /// The lower-cased invoice.
  @override
  String get id => invoice.invoice;

  @override
  BigInt? get amountSats => invoice.amountSats;

  @override
  int get expiresAt => invoice.expiresAt;

  @override
  bool get mainnet => invoice.network == LnNetwork.mainnet;
}

/// A mainnet address, or a `bitcoin:` link to one.
final class OnchainPaymentRequest extends PaymentRequest {
  const OnchainPaymentRequest._(this.request);

  /// The address and amount.
  final OnchainRequest request;

  /// The address as [parseAddress] gives it: bech32 lower-cased, base58 as given.
  @override
  String get id => request.address;

  @override
  BigInt? get amountSats => request.sats == null ? null : BigInt.from(request.sats!.value);

  @override
  int? get expiresAt => null;

  @override
  bool get mainnet => true;
}

/// Whether [token] is worth decoding at all: at most [paymentTokenMaxLength] UTF-16 code units, and either
/// 100 or more starting with `ln` or `lightning:`, or a `bitcoin:` link, or 26 to 90 starting with `bc1`,
/// `1` or `3` (letters in any case).
bool isPaymentRequestCandidate(String token) {
  if (token.length > paymentTokenMaxLength) return false;
  if (token.length >= _invoiceMinLength && _looksLightning(token)) return true;
  if (startsWithIgnoringCase(token, 'bitcoin:')) return true;
  return token.length >= _addressMinLength &&
      token.length <= maxAddressLength &&
      (startsWithIgnoringCase(token, 'bc1') || token.startsWith('1') || token.startsWith('3'));
}

bool _looksLightning(String token) =>
    startsWithIgnoringCase(token, 'ln') || startsWithIgnoringCase(token, 'lightning:');

/// [token] as a payment request, or null. In this order: a BOLT11 invoice (bare or `lightning:`); a
/// `bitcoin:` link whose first `lightning=` value is an invoice (the unified link a wallet gives); a
/// mainnet address or a `bitcoin:` link to one ([parseOnchainRequest]).
PaymentRequest? paymentRequestOf(String token) {
  if (!isPaymentRequestCandidate(token)) return null;
  if (_looksLightning(token)) {
    final invoice = decodeInvoice(token);
    return invoice == null ? null : LightningPaymentRequest._(invoice);
  }
  if (startsWithIgnoringCase(token, 'bitcoin:')) {
    final first = invoiceCandidates(token).firstOrNull;
    final invoice = first == null ? null : decodeInvoice(first);
    if (invoice != null) return LightningPaymentRequest._(invoice);
  }
  final request = parseOnchainRequest(token);
  return request == null ? null : OnchainPaymentRequest._(request);
}

/// One part of a chat text: a run of white space or of anything else, and the payment request it is.
typedef TextPart = ({String text, PaymentRequest? request});

/// [text] cut into runs of white space and runs of anything else, in order, each read by
/// [paymentRequestOf]. The parts joined give [text] back; a card's position is its part's index.
List<TextPart> splitPaymentText(String text) => [
  for (final part in splitAtWhitespace(text, keepSeparators: true)) (text: part, request: paymentRequestOf(part)),
];

/// Whether [text] holds at least one payment request.
bool hasPaymentRequest(String text) => splitAtWhitespace(text).any((part) => paymentRequestOf(part) != null);
