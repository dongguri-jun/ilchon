@Tags(['web'])
library;

import 'package:ilchon_core/ilchon_core.dart';
import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

import 'support/shapes.dart';
import 'support/vector_runner.dart';
import 'vectors/onchain.g.dart';

void main() {
  test('the address and amount limits are the same as the vector file', () {
    expect(VectorFile.parse(onchainVectors).constants, {
      'MAX_ADDRESS': maxAddressLength,
      'SATS_PER_BTC': satsPerBtc,
      'MAX_SATS': maxSats,
    });
  });

  const rangeError = Threw('RangeError');
  checkVectors(onchainVectors, {
    'parseAddress': Port((a) {
      final parsed = parseAddress(a.text('text'));
      return parsed == null ? null : {'address': parsed.address, 'kind': parsed.kind.name};
    }),
    'addressProblem': Port((a) => addressProblem(a.text('text'))?.name),
    'btcText': Port((a) => btcText(a.sats('sats')), refusals: [rangeError]),
    'bip21': Port((a) => bip21(a.text('address'), a.optionalSats('sats')), refusals: [rangeError]),
    'parseOnchainRequest': Port((a) {
      final request = parseOnchainRequest(a.text('token'));
      return request == null ? null : onchainRequestShape(request);
    }),
    'onchainCardValues': Port((a) {
      final req = a.object('req');
      final values = onchainCardValues(OnchainRequest(req.text('address'), req.optionalSats('sats')));
      return {'address': values.address, 'btc': values.btc, 'link': values.link};
    }, refusals: [rangeError]),
  });
}
