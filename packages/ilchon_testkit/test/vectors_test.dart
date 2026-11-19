@Tags(['web'])
library;

import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

void main() {
  test('tagged values come back as the Dart values they stand for', () {
    final file = VectorFile.parse('''
{"module":"m","functions":{"f":{"args":["x"],"cases":[
  {"name":"tags","input":{"x":[{"\$":"NaN"},{"\$":"-0"},{"\$":"Infinity"},{"\$":"undefined"},
    {"\$":"bigint","value":"123456789012345678901234567890"},{"\$":"int","value":"1000000000000000000000"}]},
   "expected":null},
  {"name":"threw","input":{},"error":"RangeError","outOfDomain":true}]}}}
''');
    final [tags, threw] = file.functions['f']!.cases;
    final values = tags.input['x']! as List<Object?>;
    expect((values[0]! as double).isNaN, isTrue);
    expect((values[1]! as double).isNegative, isTrue);
    expect(values.sublist(2), [double.infinity, undefined, BigInt.parse('123456789012345678901234567890'), 1e21]);
    expect(tags.outcome, isA<Returned>().having((r) => r.value, 'value', isNull));
    expect(threw.outcome, const Threw('RangeError'));
    expect(threw.outOfDomain, isTrue);
    expect(threw.input.containsKey('x'), isFalse);
    expect(file.caseCount, 2);
  });
}
