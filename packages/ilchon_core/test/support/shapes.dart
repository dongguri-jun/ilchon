import 'package:ilchon_core/ilchon_core.dart';

import 'vector_runner.dart';

Map<String, Object?> invoiceShape(Invoice invoice) => {
  'invoice': invoice.invoice,
  'network': invoice.network.name,
  'amountMsat': invoice.amountMsat,
  'amountSats': asJsNumber(invoice.amountSats),
  'createdAt': invoice.createdAt,
  'expiresAt': invoice.expiresAt,
  'description': invoice.description,
  'descriptionHash': invoice.descriptionHash,
};

Map<String, Object?> onchainRequestShape(OnchainRequest request) => {
  'address': request.address,
  'sats': request.sats?.value,
  'uri': request.uri,
};

Map<String, Object?> paymentRequestShape(PaymentRequest request) => {
  'kind': switch (request) {
    LightningPaymentRequest() => 'lightning',
    OnchainPaymentRequest() => 'onchain',
  },
  'id': request.id,
  'amountSats': asJsNumber(request.amountSats),
  'expiresAt': request.expiresAt,
  'mainnet': request.mainnet,
  ...switch (request) {
    LightningPaymentRequest(:final invoice) => {'invoice': invoiceShape(invoice)},
    OnchainPaymentRequest(:final request) => {'req': onchainRequestShape(request)},
  },
};

/// The invoice of a case that passes one as text: it must decode.
Invoice decodedInvoice(Args a) =>
    decodeInvoice(a.text('invoice')) ?? (throw StateError('the case invoice does not decode'));
