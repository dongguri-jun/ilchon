/// Checks the dependency rules of the Dart workspace (`tool/arch_rules.dart`).
///
///   dart run tool/check_arch.dart [<workspace root>]
///
/// Prints one line per violation, `path:line rule message`, and exits 1 if there is any.
///
/// Imports, exports and parts are read from the syntax tree of each file, so comments and strings never
/// match. What a file can see is followed through `export` chains and conditional imports, so
/// re-exporting a forbidden library does not hide it. Forbidden identifiers (`DateTime.now`, ...) need
/// the resolved tree and are looked up only in `ilchon_core/lib/src`.
library;

import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

import 'arch_rules.dart';

/// One broken rule.
class Violation {
  Violation(this.path, this.line, this.rule, this.message);

  final String path;
  final int line;
  final String rule;
  final String message;

  @override
  String toString() => '$path:$line $rule $message';
}

Future<void> main(List<String> args) async {
  final clock = Stopwatch()..start();
  final root = p.normalize(p.absolute(args.isEmpty ? '.' : args.first));
  final found = {for (final v in await check(root)) v.toString()}.toList()..sort();
  found.forEach(stdout.writeln);
  stdout.writeln('check_arch: ${found.length} violation(s), ${clock.elapsedMilliseconds} ms');
  exitCode = found.isEmpty ? 0 : 1;
}

/// Runs every rule over the workspace at [root]. [resolve] false skips the rules that need the resolved tree.
Future<List<Violation>> check(String root, {bool resolve = true}) async {
  final workspace = _Workspace.load(root);
  final out = <Violation>[];
  for (final member in workspace.members) {
    out.addAll(_checkPubspec(workspace, member));
    out.addAll(_checkFiles(workspace, member));
  }
  if (resolve) {
    for (final member in workspace.members.where((m) => m.name == 'ilchon_core')) {
      out.addAll(await _checkIdentifiers(workspace, member));
    }
    out.addAll(await _checkMustNotCompile(workspace));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Workspace and files

class _Member {
  _Member(this.dir, this.name, this.pubspec);

  final String dir;
  final String name;
  final YamlMap pubspec;

  /// The root package owns `tool/`; every other member owns its whole folder.
  bool get isRoot => name == 'ilchon_workspace';
  String get lib => p.join(dir, 'lib');
}

class _Workspace {
  _Workspace(this.root, this.members);

  final String root;
  final List<_Member> members;

  static _Workspace load(String root) {
    final rootPubspec = _readYaml(p.join(root, 'pubspec.yaml'));
    final members = [_Member(root, rootPubspec['name'] as String, rootPubspec)];
    for (final entry in (rootPubspec['workspace'] as YamlList? ?? YamlList()).cast<String>()) {
      final dirs = entry.endsWith('/*')
          ? (Directory(p.join(root, entry.substring(0, entry.length - 2)))
                .listSync()
                .whereType<Directory>()
                .map((d) => d.path)
                .toList()
              ..sort())
          : [p.join(root, entry)];
      for (final dir in dirs) {
        final file = p.join(dir, 'pubspec.yaml');
        if (!File(file).existsSync()) continue;
        final pubspec = _readYaml(file);
        members.add(_Member(dir, pubspec['name'] as String, pubspec));
      }
    }
    return _Workspace(root, members);
  }

  _Member? memberNamed(String name) => members.where((m) => m.name == name).firstOrNull;

  /// The member whose folder holds [file] (the root only for `tool/`).
  _Member? memberOf(String file) {
    _Member? best;
    for (final m in members) {
      if (m.isRoot) continue;
      if (p.isWithin(m.dir, file) && (best == null || m.dir.length > best.dir.length)) best = m;
    }
    if (best == null && p.isWithin(p.join(root, 'tool'), file)) return members.first;
    return best;
  }

  String rel(String file) => p.relative(file, from: root);
}

YamlMap _readYaml(String file) => loadYaml(File(file).readAsStringSync()) as YamlMap;

/// Folders directly under a member that hold tool output, not source. Nowhere else is a folder skipped:
/// a `build/` or `.hidden/` folder inside `lib/` is scanned like any other.
const _outputFolders = {'build', '.dart_tool'};

/// The folder of [member] that is scanned: `tool/` for the root, the whole folder for every other member.
String _scannedFolder(_Member member) => member.isRoot ? p.join(member.dir, 'tool') : member.dir;

/// Dart files that belong to [member], without its tool output and the must-not-compile fixtures.
List<String> _dartFiles(_Member member) {
  final base = _scannedFolder(member);
  if (!Directory(base).existsSync()) return const [];
  return [
    for (final f in Directory(base).listSync(recursive: true))
      if (f is File && f.path.endsWith('.dart'))
        if (!_isOutput(member, base, f.path)) f.path,
  ]..sort();
}

bool _isOutput(_Member member, String base, String file) {
  final parts = p.split(p.relative(file, from: base));
  if (_outputFolders.contains(parts.first)) return true;
  return !member.isRoot && p.isWithin(p.join(base, 'test', 'no_compile'), file);
}

// ---------------------------------------------------------------------------------------------
// pubspec.yaml: which packages a member may name

Iterable<Violation> _checkPubspec(_Workspace ws, _Member member) sync* {
  final at = ws.rel(p.join(member.dir, 'pubspec.yaml'));
  final rule = packageRules[member.name];
  if (rule == null) {
    yield Violation(at, 1, 'dependency', '${member.name} has no row in tool/arch_rules.dart');
    return;
  }
  if (!member.isRoot && member.pubspec['resolution'] != 'workspace') {
    yield Violation(at, 1, 'dependency', '${member.name} must say "resolution: workspace"');
  }
  if (!member.isRoot && member.pubspec['dependency_overrides'] != null) {
    yield Violation(at, 1, 'dependency', '${member.name} may not override dependencies; only the root can');
  }
  final env = member.pubspec['environment'];
  if ((rule.pure || !rule.flutter) && env is YamlMap && env.containsKey('flutter')) {
    yield Violation(at, 1, 'dependency', '${member.name} may not require the Flutter SDK ("environment: flutter")');
  }
  for (final (key, allowed) in [
    ('dependencies', rule.dependencies),
    ('dev_dependencies', {...rule.devDependencies}),
  ]) {
    final deps = member.pubspec[key];
    if (deps is! YamlMap) continue;
    for (final MapEntry(key: name, value: spec) in deps.entries) {
      final onFlutterSdk = spec is YamlMap && spec['sdk'] == 'flutter';
      if (onFlutterSdk && !rule.flutter) {
        yield Violation(at, 1, 'dependency', '${member.name} may not depend on the Flutter SDK ($name)');
      } else if (!allowed.contains(name) && !onFlutterSdk) {
        yield Violation(at, 1, 'dependency', '${member.name} may not list $name under $key');
      }
      if (spec is YamlMap && (spec.containsKey('git') || spec.containsKey('path') || spec.containsKey('hosted'))) {
        yield Violation(
          at,
          1,
          'dependency',
          '$name: only plain version constraints; git, path and hosted urls are not allowed',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Directives: the import graph

/// One import, export or part, with the line it is on. A conditional import or export gives one edge per uri.
class _Edge {
  _Edge(this.kind, this.uri, this.line);

  /// `import`, `export`, `part` or `part of`.
  final String kind;
  final String uri;
  final int line;
}

final Map<String, List<_Edge>> _edgeCache = {};

List<_Edge> _edgesOf(String file) => _edgeCache.putIfAbsent(file, () {
  final content = File(file).readAsStringSync();
  final unit = parseString(content: content, path: file, throwIfDiagnostics: false).unit;
  final edges = <_Edge>[];
  for (final d in unit.directives) {
    final line = unit.lineInfo.getLocation(d.offset).lineNumber;
    switch (d) {
      case ImportDirective():
        edges.add(_Edge('import', d.uri.stringValue ?? '', line));
        for (final c in d.configurations) {
          edges.add(_Edge('import', c.uri.stringValue ?? '', line));
        }
      case ExportDirective():
        edges.add(_Edge('export', d.uri.stringValue ?? '', line));
        for (final c in d.configurations) {
          edges.add(_Edge('export', c.uri.stringValue ?? '', line));
        }
      case PartDirective():
        edges.add(_Edge('part', d.uri.stringValue ?? '', line));
      case PartOfDirective():
        edges.add(_Edge('part of', d.uri?.stringValue ?? d.libraryName?.toSource() ?? '', line));
      default:
        break;
    }
  }
  return edges;
});

/// Where a uri points.
sealed class _Target {}

/// `dart:io`, `package:flutter`: a library outside the workspace, named by its first segment.
class _Outside extends _Target {
  _Outside(this.key);
  final String key;
}

/// A Dart file in the workspace.
class _Inside extends _Target {
  _Inside(this.file, this.member);
  final String file;
  final _Member member;
}

/// A uri the checker refuses to follow (`file:`, `http:`, `data:`, a relative path out of the package).
class _Unfollowable extends _Target {
  _Unfollowable(this.why);
  final String why;
}

_Target _resolve(_Workspace ws, _Member from, String file, String uri) {
  final u = Uri.tryParse(uri);
  if (u == null) return _Unfollowable('not a uri: $uri');
  if (u.scheme == 'dart') return _Outside('dart:${u.path.split('/').first}');
  if (u.scheme == 'package') {
    final name = u.pathSegments.first;
    final other = ws.memberNamed(name);
    if (other == null) return _Outside('package:$name');
    return _Inside(p.joinAll([other.lib, ...u.pathSegments.skip(1)]), other);
  }
  if (u.hasScheme) return _Unfollowable('uri scheme ${u.scheme}: is not allowed');
  final target = p.normalize(p.join(p.dirname(file), uri));
  final base = from.isRoot ? p.join(from.dir, 'tool') : from.dir;
  if (!p.isWithin(base, target)) return _Unfollowable('$uri leaves the package folder');
  return _Inside(target, from);
}

/// What importing [target] puts in the importer's reach: the target itself and everything it re-exports,
/// followed through every `export` and every conditional `export`.
/// Each entry says where it came from ([_Reach.via]) so a message can name the re-exporting file.
class _Reach {
  _Reach(this.target, this.via);
  final _Target target;
  final String? via;
}

List<_Reach> _reach(_Workspace ws, _Member from, _Target start) {
  final out = <_Reach>[];
  final seen = <String>{};
  void visit(_Target t, String? via) {
    final key = switch (t) {
      _Outside(:final key) => key,
      _Inside(:final file) => file,
      _Unfollowable(:final why) => why,
    };
    if (!seen.add(key)) return;
    out.add(_Reach(t, via));
    if (t is _Inside && File(t.file).existsSync()) {
      for (final e in _edgesOf(t.file)) {
        if (e.kind == 'export') visit(_resolve(ws, t.member, t.file, e.uri), ws.rel(t.file));
      }
    }
  }

  visit(start, null);
  return out;
}

/// `lib/src/<layer>/<zone>/...` of ilchon_core, or null parts when [file] is not under `lib/src`.
({String? layer, String? zone, String relInZone}) _place(_Member core, String file) {
  final parts = p.split(p.relative(file, from: p.join(core.lib, 'src')));
  if (parts.first == '..') return (layer: null, zone: null, relInZone: '');
  final layer = parts.length > 1 ? parts[0] : null;
  final zone = layer == 'domain' && parts.length > 2 ? parts[1] : null;
  return (layer: layer, zone: zone, relInZone: parts.skip(layer == 'domain' ? 2 : 1).join('/'));
}

Iterable<Violation> _checkFiles(_Workspace ws, _Member member) sync* {
  final rule = packageRules[member.name];
  if (rule == null) return;
  final core = member.name == 'ilchon_core';
  if (core) yield* _checkLayout(ws, member);

  for (final file in _dartFiles(member)) {
    final at = ws.rel(file);
    final inLib = p.isWithin(member.lib, file);
    final allowedPackages = {member.name, ...rule.dependencies, if (!inLib) ...rule.devDependencies};
    for (final e in _edgesOf(file)) {
      if (e.kind == 'part' || e.kind == 'part of') {
        yield Violation(at, e.line, 'part', 'part files hide a file\'s real layer; use a library per file');
        continue;
      }
      final target = _resolve(ws, member, file, e.uri);
      if (target is _Unfollowable) {
        yield Violation(at, e.line, 'uri', target.why);
        continue;
      }
      for (final reach in _reach(ws, member, target)) {
        final through = reach.via == null ? '' : ' (re-exported by ${reach.via})';
        final what = switch (reach.target) {
          _Outside(:final key) => key,
          _Inside(:final file) => ws.rel(file),
          _Unfollowable(:final why) => why,
        };
        yield* _checkReach(
          ws,
          member,
          rule,
          file,
          at,
          e,
          inLib,
          allowedPackages,
          reach,
          what,
          through,
          isDirect: reach.via == null,
        );
        if (core && inLib) {
          yield* _checkLayers(ws, member, file, at, e, reach, what, through, isDirect: reach.via == null);
        }
      }
    }
  }
}

/// Rules that look at what is reachable, wherever the file is in a member.
Iterable<Violation> _checkReach(
  _Workspace ws,
  _Member member,
  PackageRule rule,
  String file,
  String at,
  _Edge e,
  bool inLib,
  Set<String> allowedPackages,
  _Reach reach,
  String what,
  String through, {
  required bool isDirect,
}) sync* {
  final target = reach.target;
  if (target is _Unfollowable) {
    yield Violation(at, e.line, 'uri', '${target.why}$through');
    return;
  }
  if (rule.pure && target is _Outside && forbiddenInPure.contains(target.key)) {
    yield Violation(at, e.line, 'forbidden-lib', '${member.name} may not reach ${target.key}$through');
  }
  if (target is _Outside && target.key.startsWith('package:') && isDirect) {
    final name = target.key.substring('package:'.length);
    if (!allowedPackages.contains(name)) {
      yield Violation(at, e.line, 'dependency', '${member.name} may not import $name here');
    }
  }
  final isCoreEntry = member.name == 'ilchon_core' && p.equals(file, p.join(member.lib, 'ilchon_core.dart'));
  if (isCoreEntry && e.kind == 'export' && isDirect && target is _Outside) {
    yield Violation(at, e.line, 'surface', 'ilchon_core.dart exports only files under lib/src');
  }
  if (target is _Inside) {
    final other = target.member;
    final otherSrc = p.join(other.lib, 'src');
    if (isDirect && other != member && p.isWithin(otherSrc, target.file)) {
      yield Violation(at, e.line, 'surface', 'package:${other.name}/src is private to ${other.name}');
    }
    if (isDirect &&
        other != member &&
        other.name == 'ilchon_core' &&
        target.file == p.join(other.lib, 'testing.dart')) {
      final fromTests = !inLib;
      if (!(fromTests || member.name == 'ilchon_testkit')) {
        yield Violation(at, e.line, 'testing', 'testing.dart is for ilchon_testkit and test/ folders only');
      }
    }
    if (other == member && member.name == 'ilchon_core' && inLib && target.file == p.join(other.lib, 'testing.dart')) {
      yield Violation(at, e.line, 'testing', 'ilchon_core code may not use or re-export testing.dart$through');
    }
    if (isCoreEntry && e.kind == 'export' && isDirect) {
      if (!p.isWithin(p.join(member.lib, 'src'), target.file)) {
        yield Violation(at, e.line, 'surface', 'ilchon_core.dart exports only files under lib/src');
      }
    }
  }
}

/// `lib/` holds two files; `lib/src/` holds `domain/` and `application/`; the public file shows what it exports.
Iterable<Violation> _checkLayout(_Workspace ws, _Member core) sync* {
  final lib = Directory(core.lib);
  if (!lib.existsSync()) return;
  for (final f in lib.listSync()) {
    final name = p.basename(f.path);
    if (f is File && name.endsWith('.dart') && !coreEntryPoints.contains(name)) {
      yield Violation(ws.rel(f.path), 1, 'surface', 'only ${coreEntryPoints.join(' and ')} may sit directly in lib/');
    }
    if (f is Directory && name != 'src') {
      yield Violation(ws.rel(f.path), 1, 'surface', 'lib/ holds src/ and the entry files only');
    }
  }
  final src = Directory(p.join(core.lib, 'src'));
  if (src.existsSync()) {
    for (final f in src.listSync()) {
      final name = p.basename(f.path);
      if (f is Directory && coreLayers.contains(name)) continue;
      yield Violation(ws.rel(f.path), 1, 'layout', 'lib/src holds only ${coreLayers.join(' and ')}');
    }
  }
  final entry = File(p.join(core.lib, 'ilchon_core.dart'));
  if (entry.existsSync()) {
    final unit = parseString(content: entry.readAsStringSync(), path: entry.path, throwIfDiagnostics: false).unit;
    for (final d in unit.directives.whereType<ExportDirective>()) {
      if (!d.combinators.any((c) => c is ShowCombinator)) {
        yield Violation(
          ws.rel(entry.path),
          unit.lineInfo.getLocation(d.offset).lineNumber,
          'surface',
          'every export of ilchon_core.dart names what it shows',
        );
      }
    }
  }
}

/// Layer and zone rules for imports and re-exports between files of ilchon_core.
Iterable<Violation> _checkLayers(
  _Workspace ws,
  _Member core,
  String file,
  String at,
  _Edge e,
  _Reach reach,
  String what,
  String through, {
  required bool isDirect,
}) sync* {
  final target = reach.target;
  if (target is! _Inside || target.member != core) return;
  final from = _place(core, file);
  final to = _place(core, target.file);
  if (from.layer == null || to.layer == null) return;

  if (from.layer == 'domain' && to.layer == 'application') {
    yield Violation(at, e.line, 'layer', 'domain may not reach application: $what$through');
    return;
  }
  if (from.layer == 'domain' && to.layer == 'domain' && from.zone != to.zone) {
    final z = to.zone;
    if (z == null || openZones.contains(z)) return;
    if (!(zoneMap[from.zone] ?? const {}).contains(z)) {
      yield Violation(at, e.line, 'zone', 'zone ${from.zone} may not use zone $z: $what$through');
    } else if (to.relInZone != '$z.dart') {
      yield Violation(at, e.line, 'zone', 'zone ${from.zone} may use only $z/$z.dart of zone $z: $what$through');
    }
  }
  if (from.layer == 'application' && to.layer == 'domain') {
    final z = to.zone;
    if (z != null && !openZones.contains(z) && to.relInZone != '$z.dart') {
      yield Violation(at, e.line, 'zone', 'application may use only $z/$z.dart of zone $z: $what$through');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Forbidden identifiers: the resolved tree

Future<List<Violation>> _checkIdentifiers(_Workspace ws, _Member core) async {
  final src = p.join(core.lib, 'src');
  if (!Directory(src).existsSync()) return const [];
  final out = <Violation>[];
  final collection = AnalysisContextCollection(includedPaths: [src]);
  for (final file in _dartFiles(core).where((f) => p.isWithin(src, f))) {
    final layer = _place(core, file).layer;
    final banned = switch (layer) {
      'domain' => forbiddenInDomain,
      'application' => forbiddenInApplication,
      _ => const <String>{},
    };
    final result = await collection.contextFor(file).currentSession.getResolvedUnit(file);
    if (result is! ResolvedUnitResult) continue;
    final at = ws.rel(file);
    result.unit.accept(
      _ForbiddenUse(banned, layer == 'domain', (offset, what) {
        out.add(
          Violation(at, result.lineInfo.getLocation(offset).lineNumber, 'identifier', '$layer may not use $what'),
        );
      }),
    );
  }
  await collection.dispose();
  return out;
}

class _ForbiddenUse extends RecursiveAstVisitor<void> {
  _ForbiddenUse(this.banned, this.noAsync, this.report);

  final Set<String> banned;
  final bool noAsync;
  final void Function(int offset, String what) report;

  void _element(Element? e, int offset) {
    if (e == null) return;
    final lib = e.library?.uri.toString() ?? '';
    final owner = e.enclosingElement;
    final keys = {'$lib::${e.name}', if (owner is InterfaceElement) '$lib::${owner.name}.${e.name}'};
    for (final k in keys) {
      if (banned.contains(k)) report(offset, k.split('::').last);
    }
  }

  @override
  void visitSimpleIdentifier(SimpleIdentifier node) {
    _element(node.element, node.offset);
    super.visitSimpleIdentifier(node);
  }

  @override
  void visitNamedType(NamedType node) {
    _element(node.element, node.offset);
    super.visitNamedType(node);
  }

  @override
  void visitConstructorName(ConstructorName node) {
    _element(node.element, node.offset);
    super.visitConstructorName(node);
  }

  @override
  void visitBlockFunctionBody(BlockFunctionBody node) {
    if (noAsync && node.isAsynchronous) report(node.offset, 'async functions');
    super.visitBlockFunctionBody(node);
  }

  @override
  void visitExpressionFunctionBody(ExpressionFunctionBody node) {
    if (noAsync && node.isAsynchronous) report(node.offset, 'async functions');
    super.visitExpressionFunctionBody(node);
  }
}

// ---------------------------------------------------------------------------------------------
// Code that must not compile

/// Every `packages/*/test/no_compile/*.dart` starts with `// expect: <error code>`; the analyzer must
/// report that code for the file. A fixture that compiles, or fails for another reason, fails the check.
Future<List<Violation>> _checkMustNotCompile(_Workspace ws) async {
  final out = <Violation>[];
  final files = [
    for (final m in ws.members.where((m) => !m.isRoot))
      if (Directory(p.join(m.dir, 'test', 'no_compile')).existsSync())
        for (final f in Directory(p.join(m.dir, 'test', 'no_compile')).listSync())
          if (f is File && f.path.endsWith('.dart')) f.path,
  ]..sort();
  if (files.isEmpty) return out;
  final collection = AnalysisContextCollection(includedPaths: files);
  for (final file in files) {
    final at = ws.rel(file);
    final want = RegExp(r'^// expect: (\w+)').firstMatch(File(file).readAsStringSync())?.group(1);
    final result = await collection.contextFor(file).currentSession.getErrors(file);
    final got = result is ErrorsResult
        ? {for (final d in result.diagnostics) d.diagnosticCode.lowerCaseName}
        : <String>{};
    if (want == null) {
      out.add(Violation(at, 1, 'must-not-compile', 'the first line must be "// expect: <error code>"'));
    } else if (!got.contains(want)) {
      out.add(
        Violation(
          at,
          1,
          'must-not-compile',
          'expected $want, the analyzer reported ${got.isEmpty ? 'nothing' : got.join(', ')}',
        ),
      );
    }
  }
  await collection.dispose();
  return out;
}
