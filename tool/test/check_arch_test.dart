import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import '../check_arch.dart';

/// What of the checkout a copy of the Dart workspace needs, with its resolved `.dart_tool` (not the web app).
const workspaceEntries = ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', '.dart_tool', 'packages', 'tool'];

/// A copy of the Dart workspace in a temporary folder, removed after the test.
Future<Directory> copyWorkspace() async {
  final tmp = Directory.systemTemp.createTempSync('check_arch');
  addTearDown(() => tmp.deleteSync(recursive: true));
  final copy = await Process.run('cp', ['-R', ...workspaceEntries, tmp.path]);
  expect(copy.exitCode, 0, reason: '${copy.stderr}');
  return tmp;
}

/// Copies the workspace, writes [plant] into the copy and returns what the check finds.
Future<List<Violation>> violationsAfter(Map<String, String> plant, {bool resolve = false}) async {
  final tmp = await copyWorkspace();
  for (final MapEntry(key: path, value: text) in plant.entries) {
    File(p.join(tmp.path, path))
      ..parent.createSync(recursive: true)
      ..writeAsStringSync(text);
  }
  return check(tmp.path, resolve: resolve);
}

Future<Set<String>> rulesAfter(Map<String, String> plant, {bool resolve = false}) async => {
  for (final v in await violationsAfter(plant, resolve: resolve)) v.rule,
};

const core = 'packages/ilchon_core';
const domain = '$core/lib/src/domain';
const application = '$core/lib/src/application';

void main() {
  group('layers', () {
    test('domain may not import application, by relative path or package uri', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "import '../../application/ports.dart';"}), {'layer'});
      expect(
        await rulesAfter({'$domain/payments/x.dart': "import 'package:ilchon_core/src/application/ports.dart';"}),
        {'layer'},
      );
    });

    test('a re-export does not hide application, however deep', () async {
      expect(
        await rulesAfter({
          '$application/ports.dart': '',
          '$domain/shared/via.dart': "export '../../application/ports.dart';",
          '$domain/shared/deeper.dart': "export 'via.dart';",
          '$domain/payments/x.dart': "import '../shared/deeper.dart';",
        }),
        {'layer'},
      );
    });

    test('a conditional import is read like any other', () async {
      expect(
        await rulesAfter({
          '$domain/payments/x.dart': "import 'dart:async' if (dart.library.io) '../../application/ports.dart';",
        }),
        {'layer'},
      );
    });

    test('application may use a zone only through its own file', () async {
      expect(await rulesAfter({'$application/use.dart': "import '../domain/matching/mint/disclosure.dart';"}), {
        'zone',
      });
      expect(await rulesAfter({'$application/use.dart': "import '../domain/matching/matching.dart';"}), isEmpty);
    });
  });

  group('zones', () {
    test('a zone off the map is refused, an allowed one only through its own file', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "import '../matching/matching.dart';"}), {'zone'});
      expect(await rulesAfter({'$domain/trade/trade.dart': "import '../matching/mint/disclosure.dart';"}), {'zone'});
      expect(await rulesAfter({'$domain/trade/trade.dart': "import '../matching/matching.dart';"}), isEmpty);
    });

    test('shared is open to every zone', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "import '../shared/lang.dart';"}), isEmpty);
    });

    test('a zone file that re-exports a zone its importer may not see is refused', () async {
      expect(
        await rulesAfter({
          '$domain/matching/matching.dart': "export '../recovery/recovery.dart';",
          '$domain/recovery/recovery.dart': '',
          '$domain/trade/trade.dart': "import '../matching/matching.dart';",
        }),
        {'zone'},
      );
    });
  });

  group('forbidden libraries', () {
    for (final lib in [
      'dart:io',
      'dart:js_interop',
      'dart:html',
      'dart:ffi',
      'package:web/web.dart',
      'package:flutter/widgets.dart',
    ]) {
      test('core may not import $lib', () async {
        expect(await rulesAfter({'$domain/payments/x.dart': "import '$lib';"}), contains('forbidden-lib'));
      });
    }

    test('nor export them, nor reach them through a conditional import or a re-export', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "export 'dart:io';"}), {'forbidden-lib'});
      expect(
        await rulesAfter({
          '$domain/payments/x.dart': "import 'dart:async' if (dart.library.js_interop) 'dart:js_interop';",
        }),
        {'forbidden-lib'},
      );
      expect(
        await rulesAfter({
          '$domain/shared/io.dart': "export 'dart:io';",
          '$domain/payments/x.dart': "import '../shared/io.dart';",
        }),
        {'forbidden-lib'},
      );
    });

    test('the testkit is pure too, and its tests', () async {
      expect(await rulesAfter({'packages/ilchon_testkit/lib/x.dart': "import 'dart:io';"}), {'forbidden-lib'});
      expect(await rulesAfter({'packages/ilchon_testkit/test/x.dart': "import 'dart:js_interop';"}), {'forbidden-lib'});
    });

    test('comments and strings never count', () async {
      expect(
        await rulesAfter({'$domain/payments/x.dart': "// import 'dart:io';\nconst s = \"import 'dart:html';\";"}),
        isEmpty,
      );
    });
  });

  group('folders named like tool output', () {
    test('build/ or a hidden folder inside lib/ is read like any other folder', () async {
      expect(
        await rulesAfter({
          '$domain/payments/build/clock.dart': "import 'dart:io';",
          '$domain/payments/.hidden/app.dart': "import '../../../application/ports.dart';",
          '$application/ports.dart': '',
        }),
        {'forbidden-lib', 'layer'},
      );
    });

    test('the same folders are searched for forbidden identifiers', () async {
      final found = await violationsAfter({
        '$domain/payments/build/clock.dart': 'final a = DateTime.now();',
      }, resolve: true);
      expect({for (final v in found) '${p.basename(v.path)} ${v.rule}'}, {'clock.dart identifier'});
    });

    test('only the tool output folders of a member are skipped', () async {
      expect(
        await rulesAfter({'$core/build/x.dart': "import 'dart:io';", '$core/.dart_tool/x.dart': "import 'dart:io';"}),
        isEmpty,
      );
    });
  });

  group('parts', () {
    test('part and part of are refused', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "part 'y.dart';"}), {'part'});
      expect(await rulesAfter({'$domain/payments/y.dart': "part of 'x.dart';"}), {'part'});
    });

    test('a part file cannot smuggle domain code into application rules', () async {
      expect(
        await rulesAfter({
          '$domain/payments/x.dart': "part '../../application/helper.dart';",
          '$application/helper.dart': "part of '../domain/payments/x.dart';\nfinal _t = DateTime.now();",
        }),
        {'part'},
      );
    });
  });

  group('layout and public surface', () {
    test('lib/src holds domain and application only', () async {
      expect(await rulesAfter({'$core/lib/src/infrastructure/x.dart': ''}), {'layout'});
      expect(await rulesAfter({'$core/lib/src/loose.dart': ''}), {'layout'});
    });

    test('lib/ holds the two entry files only', () async {
      expect(await rulesAfter({'$core/lib/extra.dart': ''}), {'surface'});
      expect(await rulesAfter({'$core/lib/more/extra.dart': ''}), {'surface'});
    });

    test('the entry file shows what it exports and exports only from src', () async {
      expect(await rulesAfter({'$core/lib/ilchon_core.dart': "export 'src/domain/payments/money.dart';"}), {'surface'});
      expect(await rulesAfter({'$core/lib/ilchon_core.dart': "export 'package:meta/meta.dart' show immutable;"}), {
        'surface',
      });
    });

    test('another package may not use lib/src of core', () async {
      expect(
        await rulesAfter({
          'packages/ilchon_testkit/lib/x.dart': "import 'package:ilchon_core/src/domain/payments/money.dart';",
        }),
        {'surface'},
      );
    });

    test('testing.dart belongs to the testkit and to tests', () async {
      expect(await rulesAfter({'$domain/payments/x.dart': "import '../../../testing.dart';"}), {'testing'});
      expect(await rulesAfter({'$core/lib/ilchon_core.dart': "export 'testing.dart' show testTicket;"}), {
        'testing',
        'surface',
      });
      expect(
        await rulesAfter({'packages/ilchon_testkit/lib/x.dart': "import 'package:ilchon_core/testing.dart';"}),
        isEmpty,
      );
      expect(await rulesAfter({'$core/test/x.dart': "import 'package:ilchon_core/testing.dart';"}), isEmpty);
    });

    test('a path out of the package or a foreign uri scheme is refused', () async {
      expect(
        await rulesAfter({
          '$domain/payments/x.dart': "import '../../../../../ilchon_testkit/lib/ilchon_testkit.dart';",
        }),
        {'uri'},
      );
      expect(await rulesAfter({'$domain/payments/x.dart': "import 'file:///tmp/x.dart';"}), {'uri'});
    });
  });

  group('packages', () {
    String pubspec(String name) => File('packages/$name/pubspec.yaml').readAsStringSync();
    String withDependency(String pubspec, String entry) => pubspec.contains('\ndependencies:\n')
        ? pubspec.replaceFirst('\ndependencies:\n', '\ndependencies:\n$entry\n')
        : '${pubspec}dependencies:\n$entry\n';

    test('a Flutter dependency, a new package, a git source or an override are refused', () async {
      final core = pubspec('ilchon_core');
      expect(
        await rulesAfter({'packages/ilchon_core/pubspec.yaml': withDependency(core, '  flutter:\n    sdk: flutter')}),
        isNotEmpty,
      );
      expect(await rulesAfter({'packages/ilchon_core/pubspec.yaml': withDependency(core, '  http: ^1.0.0')}), {
        'dependency',
      });
      expect(
        await rulesAfter({
          'packages/ilchon_core/pubspec.yaml': withDependency(core, '  meta:\n    git: https://example.com/meta.git'),
        }),
        {'dependency'},
      );
      expect(await rulesAfter({'packages/ilchon_core/pubspec.yaml': '${core}dependency_overrides:\n  meta: any\n'}), {
        'dependency',
      });
      expect(
        await rulesAfter({
          'packages/ilchon_core/pubspec.yaml': core.replaceFirst('sdk: ^3.14.0', 'sdk: ^3.14.0\n  flutter: ">=3.0.0"'),
        }),
        {'dependency'},
      );
      expect(
        await rulesAfter({
          'packages/ilchon_testkit/pubspec.yaml': withDependency(pubspec('ilchon_testkit'), '  ilchon_extra: any'),
        }),
        {'dependency'},
      );
      expect(
        await rulesAfter({
          'packages/ilchon_new/pubspec.yaml': 'name: ilchon_new\nresolution: workspace\nenvironment:\n  sdk: ^3.14.0\n',
        }),
        {'dependency'},
      );
    });

    test('core may not depend on a workspace member, the testkit may depend on core', () async {
      final core = pubspec('ilchon_core');
      expect(await rulesAfter({'packages/ilchon_core/pubspec.yaml': withDependency(core, '  ilchon_testkit: any')}), {
        'dependency',
      });
    });
  });

  group('forbidden identifiers (resolved tree)', () {
    test('time, randomness, printing, timers and async in domain; clean look-alikes pass', () async {
      const bad = {
        'now': 'final a = DateTime.now();',
        'now_tearoff': 'final a = DateTime.now;',
        'random': "import 'dart:math';\nfinal a = Random();",
        'random_prefixed': "import 'dart:math' as m;\nfinal a = m.Random.secure();",
        'print': "void f() => print('x');",
        'timer': "import 'dart:async';\nfinal a = Timer;",
        'delayed': 'final a = Future.delayed;',
        'async': 'Future<void> f() async {}',
        'stopwatch': 'final s = Stopwatch();',
      };
      const clean = {
        'local_print': "void print(String s) {}\nvoid f() => print('x');",
        'comments_and_strings': "// DateTime.now()\nconst s = 'Random()';",
        'fixed_date': 'final a = DateTime(2026);',
      };
      final plant = {
        for (final MapEntry(:key, :value) in {...bad, ...clean}.entries) '$domain/payments/$key.dart': value,
        '$application/clock.dart': 'final a = DateTime.now();',
        '$application/asynchronous.dart': 'Future<void> f() async {}',
      };
      final found = await violationsAfter(plant, resolve: true);
      expect(found.where((v) => v.rule == 'identifier').map((v) => p.basename(v.path)).toSet(), {
        for (final k in bad.keys) '$k.dart',
        'clock.dart',
      });
    });
  });

  group('code that must not compile', () {
    // A ticket in the shape the matching zone uses: a final class whose constructor is private to its file.
    const ticket = '''
/// Proof that something was checked.
final class Ticket {
  const Ticket._();
}

/// The only way to get a [Ticket].
Ticket? issue({required bool checked}) => checked ? const Ticket._() : null;
''';
    const ticketFile = '$domain/matching/mint/ticket.dart';
    const ticketUri = 'package:ilchon_core/src/domain/matching/mint/ticket.dart';

    test('a fixture passes only when the analyzer reports its expected code', () async {
      final found = await violationsAfter({
        ticketFile: ticket,
        '$core/test/no_compile/forge_private_constructor.dart':
            "// expect: new_with_undefined_constructor\nimport '$ticketUri';\nfinal t = Ticket._();\n",
        '$core/test/no_compile/forge_by_implementing.dart':
            "// expect: invalid_use_of_type_outside_library\nimport '$ticketUri';\nclass Fake implements Ticket {}\n",
        '$core/test/no_compile/forge_by_extending.dart':
            "// expect: invalid_use_of_type_outside_library\nimport '$ticketUri';\nclass Fake extends Ticket {}\n",
        '$core/test/no_compile/ok.dart': '// expect: some_error\nvoid main() {}',
        '$core/test/no_compile/none.dart': 'void main() {}',
      }, resolve: true);
      expect(found.map((v) => '${p.basename(v.path)} ${v.rule}').toSet(), {
        'ok.dart must-not-compile',
        'none.dart must-not-compile',
      });
    });

    test('another library of the same package cannot build a ticket, even from inside lib/src', () async {
      final tmp = await copyWorkspace();
      File(p.join(tmp.path, ticketFile))
        ..parent.createSync(recursive: true)
        ..writeAsStringSync(ticket);
      final forge = File(p.join(tmp.path, '$domain/matching/forge.dart'))
        ..writeAsStringSync("import 'mint/ticket.dart';\nfinal forged = Ticket._();\n");
      final collection = AnalysisContextCollection(includedPaths: [forge.path]);
      final result = await collection.contextFor(forge.path).currentSession.getErrors(forge.path);
      await collection.dispose();
      expect(result, isA<ErrorsResult>());
      expect([
        for (final d in (result as ErrorsResult).diagnostics) d.diagnosticCode.lowerCaseName,
      ], contains('new_with_undefined_constructor'));
    });
  });
}
