import 'dart:convert';

/// A file of reference vectors: the input and the result of each function, as another implementation of
/// the same rules produced them.
///
/// The file format is described in `spec/vectors/README.md`. Values JSON cannot carry come tagged and are
/// read back as Dart values: `{"$":"NaN"}` as [double.nan], `{"$":"-0"}` as `-0.0`, `{"$":"undefined"}` as
/// [undefined], `{"$":"bigint"}` as a [BigInt], and `{"$":"int"}` (a whole JavaScript number past 2^53) as
/// the [double] that number is.
final class VectorFile {
  VectorFile._(this.module, this.constants, this.functions);

  /// Reads the text of a vector file.
  factory VectorFile.parse(String json) {
    final root = jsonDecode(json) as Map<String, Object?>;
    final functions = <String, VectorFunction>{};
    for (final MapEntry(key: name, value: raw) in (root['functions'] as Map<String, Object?>).entries) {
      final body = raw as Map<String, Object?>;
      functions[name] = VectorFunction._(
        name,
        [for (final arg in body['args'] as List<Object?>) arg as String],
        [for (final c in body['cases'] as List<Object?>) VectorCase._read(c as Map<String, Object?>)],
      );
    }
    return VectorFile._(root['module'] as String, readTagged(root['constants'] ?? const {}), functions);
  }

  /// The module the vectors were written for.
  final String module;

  /// Named constants of the module, read like case values.
  final Object? constants;

  /// Every function of the file by name, in file order.
  final Map<String, VectorFunction> functions;

  /// How many cases the file holds over all its functions.
  int get caseCount => functions.values.fold(0, (sum, f) => sum + f.cases.length);
}

/// The cases of one function.
final class VectorFunction {
  VectorFunction._(this.name, this.args, this.cases);

  /// The function's name in the other implementation.
  final String name;

  /// Argument names in call order.
  final List<String> args;

  /// The cases in file order.
  final List<VectorCase> cases;
}

/// One call and what it gave.
final class VectorCase {
  VectorCase._(this.name, this.input, this.outcome, {required this.outOfDomain});

  factory VectorCase._read(Map<String, Object?> raw) {
    final input = readTagged(raw['input']) as Map<String, Object?>;
    final outcome = raw.containsKey('error') ? Threw(raw['error'] as String) : Returned(readTagged(raw['expected']));
    return VectorCase._(raw['name'] as String, input, outcome, outOfDomain: raw['outOfDomain'] == true);
  }

  /// A name unique within its function.
  final String name;

  /// Argument values by name. An argument that was not passed is absent; one passed as `undefined` is [undefined].
  final Map<String, Object?> input;

  /// What the call returned or threw.
  final Outcome outcome;

  /// An input real callers never pass. An implementation may refuse it instead of matching the result.
  final bool outOfDomain;
}

/// What a call did.
sealed class Outcome {
  const Outcome();
}

/// The call returned [value].
final class Returned extends Outcome {
  /// The returned value.
  const Returned(this.value);

  /// The value, read like case input.
  final Object? value;

  @override
  String toString() => 'returned $value';
}

/// The call threw an error of the class named [error] (`RangeError`, `TypeError`).
final class Threw extends Outcome {
  /// The error class name.
  const Threw(this.error);

  /// The error class name.
  final String error;

  @override
  bool operator ==(Object other) => other is Threw && other.error == error;

  @override
  int get hashCode => error.hashCode;

  @override
  String toString() => 'threw $error';
}

/// JavaScript's `undefined`, where a vector passes or returns it.
const Undefined undefined = Undefined._();

/// The type of [undefined].
final class Undefined {
  const Undefined._();

  @override
  String toString() => 'undefined';
}

/// Reads a JSON value of a vector file, replacing the tags for values JSON cannot carry.
Object? readTagged(Object? json) => switch (json) {
  {r'$': 'NaN'} => double.nan,
  {r'$': 'Infinity'} => double.infinity,
  {r'$': '-Infinity'} => double.negativeInfinity,
  {r'$': '-0'} => -0.0,
  {r'$': 'undefined'} => undefined,
  {r'$': 'int', 'value': final String digits} => double.parse(digits),
  {r'$': 'bigint', 'value': final String digits} => BigInt.parse(digits),
  final Map<String, Object?> map => {for (final MapEntry(:key, :value) in map.entries) key: readTagged(value)},
  final List<Object?> list => [for (final item in list) readTagged(item)],
  _ => json,
};
