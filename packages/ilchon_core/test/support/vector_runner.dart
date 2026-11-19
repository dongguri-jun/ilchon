import 'package:ilchon_core/ilchon_core.dart';
import 'package:ilchon_testkit/ilchon_testkit.dart';
import 'package:test/test.dart';

/// Thrown by [Args] when a vector input cannot be put in the Dart type a function takes: text where a
/// number is wanted, a fraction where a whole number is, an amount outside [Money] or [Sats].
final class NotExpressible implements Exception {
  NotExpressible(this.why);

  /// What did not fit.
  final String why;

  @override
  String toString() => 'not expressible: $why';
}

/// The input of one case, read into Dart types.
final class Args {
  Args(this._values);

  final Map<String, Object?> _values;

  Object? _raw(String name) => _values[name];

  /// Whether the argument was passed with a value (not absent, not `undefined`).
  bool has(String name) => _values.containsKey(name) && _values[name] != undefined;

  /// A text argument.
  String text(String name) => switch (_raw(name)) {
    final String s => s,
    final other => throw NotExpressible('$name is $other, not text'),
  };

  /// A text argument that may be absent, `undefined` or null.
  String? optionalText(String name) => has(name) && _raw(name) != null ? text(name) : null;

  /// A whole number in the range every compile target holds exactly (up to 2^53 - 1).
  int whole(String name) {
    final value = _raw(name);
    if (value is num && value.isFinite && value == value.truncateToDouble() && value.abs() <= 9007199254740991) {
      return value.toInt();
    }
    throw NotExpressible('$name is $value, not a whole number up to 2^53 - 1');
  }

  /// Any number, `NaN` and infinities included.
  double number(String name) => switch (_raw(name)) {
    final num n => n.toDouble(),
    final other => throw NotExpressible('$name is $other, not a number'),
  };

  /// A number that may be absent or `undefined`.
  double? optionalNumber(String name) => has(name) ? number(name) : null;

  /// A currency code.
  Currency currency(String name) =>
      Currency.tryParse(text(name)) ?? (throw NotExpressible('${_raw(name)} is not a currency'));

  /// A currency that may be absent.
  Currency? optionalCurrency(String name) => has(name) ? currency(name) : null;

  /// An amount in minor units.
  Money money(String name) => Money.fromMinor(whole(name)) ?? (throw NotExpressible('${_raw(name)} is not a Money'));

  /// An on-chain amount.
  Sats sats(String name) => Sats.fromInt(whole(name)) ?? (throw NotExpressible('${_raw(name)} is not a Sats'));

  /// An on-chain amount that may be absent, `undefined` or null.
  Sats? optionalSats(String name) => has(name) && _raw(name) != null ? sats(name) : null;

  /// A boolean that may be absent or `undefined` (false then).
  bool flag(String name) => switch (_raw(name)) {
    final bool b => b,
    null || Undefined() => false,
    final other => throw NotExpressible('$name is $other, not a boolean'),
  };

  /// A list of text.
  List<String> texts(String name) => switch (_raw(name)) {
    final List<Object?> list => [
      for (final item in list) item is String ? item : throw NotExpressible('$item in $name'),
    ],
    final other => throw NotExpressible('$name is $other, not a list'),
  };

  /// A nested object.
  Args object(String name) => switch (_raw(name)) {
    final Map<String, Object?> map => Args(map),
    final other => throw NotExpressible('$name is $other, not an object'),
  };
}

/// How one function is checked against its vectors.
final class Port {
  Port(this.run, {this.refusals = const [], this.cannotExpress = const {}, this.excused = 0});

  /// Calls the Dart function with the case input and returns its result in the shape of the vector file.
  final Object? Function(Args args) run;

  /// Results of the other implementation that mean "not a valid input": a case the Dart types cannot
  /// express passes when its expected outcome is one of these.
  final List<Outcome> refusals;

  /// Cases the Dart types cannot express although their result is not a refusal, by case name, with why.
  final Map<String, String> cannotExpress;

  /// How many cases are expected to go unchecked: those the Dart types cannot take or refuse, either
  /// marked out of domain, answered by a [refusals] outcome, or listed in [cannotExpress]. The run fails
  /// when the real number differs, so a reader that refuses too much cannot pass unnoticed.
  final int excused;
}

/// Checks every case of the vector file [json] against [ports], one test per function, and that every case
/// line of the file was read and checked.
void checkVectors(String json, Map<String, Port> ports) {
  final file = VectorFile.parse(json);

  test('${file.module}: every function of the file has a port and every port a function', () {
    expect(ports.keys.toSet(), file.functions.keys.toSet());
  });

  test('${file.module}: every case of the file is read', () {
    final caseLines = RegExp(r'^\s*\{"name":', multiLine: true).allMatches(json).length;
    expect(file.caseCount, caseLines);
  });

  for (final function in file.functions.values) {
    final port = ports[function.name];
    if (port == null) continue;
    test('${file.module}.${function.name}: ${function.cases.length} cases', () {
      final failures = <String>[];
      var excused = 0;
      for (final c in function.cases) {
        final verdict = _check(port, c);
        if (verdict.excused) excused++;
        final failure = verdict.failure;
        if (failure != null) failures.add('${c.name}: $failure');
      }
      expect(failures, isEmpty);
      expect(
        excused,
        port.excused,
        reason: 'cases excused from comparison; ${function.cases.length - excused} compared',
      );
      expect(
        port.cannotExpress.keys.where((n) => !function.cases.any((c) => c.name == n)),
        isEmpty,
        reason: 'cannotExpress names a case the file does not have',
      );
    });
  }
}

typedef _Verdict = ({String? failure, bool excused});

_Verdict _check(Port port, VectorCase c) {
  final Outcome actual;
  try {
    actual = Returned(port.run(Args(c.input)));
  } on NotExpressible catch (e) {
    final excused =
        c.outOfDomain || port.refusals.any((r) => _sameOutcome(r, c.outcome)) || port.cannotExpress.containsKey(c.name);
    return (
      failure: excused ? null : 'Dart cannot take this input ($e) but the expected ${c.outcome} is not a refusal',
      excused: excused,
    );
  } on ArgumentError catch (e) {
    return (failure: c.outOfDomain ? null : 'Dart refused an input real callers pass: $e', excused: c.outOfDomain);
  }
  if (port.cannotExpress.containsKey(c.name)) {
    return (failure: 'listed as not expressible, but Dart took it and gave $actual', excused: false);
  }
  return (failure: _sameOutcome(actual, c.outcome) ? null : 'expected ${c.outcome}, got $actual', excused: false);
}

bool _sameOutcome(Outcome a, Outcome b) => switch ((a, b)) {
  (Returned(value: final x), Returned(value: final y)) => _same(x, y),
  (Threw(error: final x), Threw(error: final y)) => x == y,
  _ => false,
};

bool _same(Object? actual, Object? expected) => switch ((actual, expected)) {
  (final num a, final num b) when a.isNaN || b.isNaN => a.isNaN && b.isNaN,
  (final num a, final num b) => a == b && (a == 0 ? a.toDouble().isNegative == b.toDouble().isNegative : true),
  (final List<Object?> a, final List<Object?> b) =>
    a.length == b.length && [for (var i = 0; i < a.length; i++) _same(a[i], b[i])].every((ok) => ok),
  (final Map<String, Object?> a, final Map<String, Object?> b) =>
    a.length == b.length && a.keys.every((k) => b.containsKey(k) && _same(a[k], b[k])),
  _ => actual == expected,
};

/// A [BigInt] as the JavaScript number the other implementation held for it (exact up to 2^53).
double? asJsNumber(BigInt? value) => value?.toDouble();
