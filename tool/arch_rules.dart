/// The dependency rules of the Dart workspace, as data. `check_arch.dart` enforces them.
///
/// A workspace member that has no row in [packageRules] is itself a violation, so adding a package
/// means adding its row here and nowhere else.
library;

/// What one workspace member may depend on and import.
class PackageRule {
  const PackageRule({
    required this.dependencies,
    this.devDependencies = const {},
    this.pure = false,
    this.flutter = false,
  });

  /// Names allowed under `dependencies` and importable from `lib/`. Workspace members and outside packages alike.
  final Set<String> dependencies;

  /// Names also allowed under `dev_dependencies` and importable from everything but `lib/`.
  final Set<String> devDependencies;

  /// Pure Dart: none of [forbiddenInPure], no Flutter SDK dependency.
  final bool pure;

  /// May depend on the Flutter SDK.
  final bool flutter;
}

/// Key `ilchon_workspace` is the root package: it owns `tool/`.
const Map<String, PackageRule> packageRules = {
  'ilchon_workspace': PackageRule(dependencies: {}, devDependencies: {'analyzer', 'lints', 'path', 'test', 'yaml'}),
  'ilchon_core': PackageRule(
    dependencies: {'meta', 'collection', 'crypto'},
    devDependencies: {'ilchon_testkit', 'test'},
    pure: true,
  ),
  'ilchon_testkit': PackageRule(dependencies: {'ilchon_core', 'meta'}, devDependencies: {'test'}, pure: true),
};

/// Libraries pure packages may not import, directly or through a re-export (matched by prefix).
const Set<String> forbiddenInPure = {
  'dart:io',
  'dart:html',
  'dart:js',
  'dart:js_interop',
  'dart:js_interop_unsafe',
  'dart:js_util',
  'dart:ffi',
  'dart:isolate',
  'dart:mirrors',
  'dart:ui',
  'dart:web_audio',
  'dart:web_gl',
  'dart:web_sql',
  'dart:indexed_db',
  'dart:svg',
  'package:web',
  'package:flutter',
  'package:flutter_test',
  'package:http',
};

/// Source layers of `ilchon_core/lib/src/`. Any other folder or loose file there is a violation.
const Set<String> coreLayers = {'domain', 'application'};

/// Which other zones of `domain/` a zone may see, through `<zone>/<zone>.dart` only.
/// Every zone may also use `shared` and `wire` freely.
const Map<String, Set<String>> zoneMap = {
  'relationship': {},
  'channel': {'relationship'},
  'matching': {'relationship', 'channel'},
  'trade': {'relationship', 'channel', 'matching'},
  'recovery': {'relationship', 'channel'},
  'payments': {},
  'identity': {},
  'protection': {},
  'preferences': {},
  'support_log': {},
  'shared': {},
  'wire': {},
};

/// Zones every zone may use without a row in [zoneMap].
const Set<String> openZones = {'shared', 'wire'};

/// The only Dart files directly under `ilchon_core/lib/`.
const Set<String> coreEntryPoints = {'ilchon_core.dart', 'testing.dart'};

/// Declarations whose use is forbidden, as `<library>::<Name>` or `<library>::<Type>.<member>`.
/// `Random` and `Timer` are matched by type, so every constructor and member counts.
const Set<String> forbiddenInDomain = {
  'dart:core::DateTime.now',
  'dart:core::DateTime.timestamp',
  'dart:core::Stopwatch',
  'dart:core::print',
  'dart:math::Random',
  'dart:async::Timer',
  'dart:async::Future.delayed',
  'dart:async::StreamController',
};

/// Same, for `application/`: time and randomness come in as arguments there too.
const Set<String> forbiddenInApplication = {
  'dart:core::DateTime.now',
  'dart:core::DateTime.timestamp',
  'dart:core::Stopwatch',
  'dart:math::Random',
};
