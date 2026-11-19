@Tags(['web'])
library;

import 'package:ilchon_core/ilchon_core.dart';
import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

import 'support/shapes.dart';
import 'support/vector_runner.dart';
import 'vectors/pay.g.dart';

void main() {
  test('the token limit is the same as the vector file', () {
    expect(VectorFile.parse(payVectors).constants, {'PAY_TOKEN_MAX': paymentTokenMaxLength});
  });

  checkVectors(payVectors, {
    'isPayCandidate': Port((a) => isPaymentRequestCandidate(a.text('token'))),
    'payRefOf': Port((a) {
      final request = paymentRequestOf(a.text('token'));
      return request == null ? null : paymentRequestShape(request);
    }),
    'splitText': Port(
      (a) => [
        for (final part in splitPaymentText(a.text('text')))
          {'text': part.text, 'ref': part.request == null ? null : paymentRequestShape(part.request!)},
      ],
    ),
    'hasPayRef': Port((a) => hasPaymentRequest(a.text('text'))),
  });
}
