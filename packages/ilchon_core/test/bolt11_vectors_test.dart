@Tags(['web'])
library;

import 'package:ilchon_core/ilchon_core.dart';
import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

import 'support/shapes.dart';
import 'support/vector_runner.dart';
import 'vectors/bolt11.g.dart';

void main() {
  test('the invoice constants are the same as the vector file', () {
    expect(VectorFile.parse(bolt11Vectors).constants, {
      'EXPIRING_SOON_SECONDS': expiringSoonSeconds,
      'EXPIRY_RECOUNT_SLACK_MS': expiryRecountSlackMs,
      'DEFAULT_EXPIRY_SECONDS': defaultExpirySeconds,
    });
  });

  const wholeMilliseconds = 'times are whole milliseconds in the core';
  checkVectors(bolt11Vectors, {
    'stripLightningScheme': Port((a) => stripLightningScheme(a.text('text'))),
    'decodeInvoice': Port((a) {
      final invoice = decodeInvoice(a.text('text'));
      return invoice == null ? null : invoiceShape(invoice);
    }),
    'invoiceCandidates': Port((a) => invoiceCandidates(a.text('text'))),
    'secondsLeft': Port((a) => secondsLeft(decodedInvoice(a), Instant(a.whole('nowMs')))),
    'msUntilRecount': Port(
      (a) => msUntilRecount(a.whole('expiresAt'), Instant(a.whole('nowMs')), a.whole('intervalMs')),
      refusals: [const Returned(null)],
      cannotExpress: {
        'interval fractional': wholeMilliseconds,
        'now fractional': wholeMilliseconds,
        'now NaN': wholeMilliseconds,
        'interval NaN': wholeMilliseconds,
        'interval Infinity': wholeMilliseconds,
      },
    ),
    'invoiceIssues': Port(
      (a) => [for (final issue in invoiceIssues(decodedInvoice(a), Instant(a.whole('nowMs')))) issue.name],
    ),
  });
}
