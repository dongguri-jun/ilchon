import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../vectors.dart';

void main() {
  test('the vector files the core tests import are fresh copies of spec/vectors', () {
    final expected = renderVectors('.');
    expect(expected, isNotEmpty);
    final committed = {
      for (final f in Directory(vectorTarget).listSync().whereType<File>()) p.relative(f.path): f.readAsStringSync(),
    };
    expect(committed.keys.toSet(), expected.keys.toSet(), reason: 'run: dart run tool/vectors.dart');
    for (final MapEntry(key: path, value: text) in expected.entries) {
      expect(committed[path] == text, isTrue, reason: '$path differs; run: dart run tool/vectors.dart');
    }
  });
}
