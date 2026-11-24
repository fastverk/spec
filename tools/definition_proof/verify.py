#!/usr/bin/env python3
"""Check a reviewed definition proof from source; never trust a saved verdict.

The caller owns claim identity and semantic review. This reusable checker binds
their bytes, compiles the complete restricted source closure, checks the exact
independently authored proposition AND nonempty-domain witness, then audits
kernel dependencies. It does not establish production implementation refinement.
"""
import argparse
from functools import cache
from hashlib import sha256
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory, text_format

ALLOWED_AXIOMS = frozenset({'propext', 'Classical.choice', 'Quot.sound'})
NAME = re.compile(r'[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')


def digest(data):
    return sha256(data).hexdigest()


@cache
def messages(schema=None):
    try:
        from spec.v1 import definition_proof_pb2
        return definition_proof_pb2
    except ModuleNotFoundError as error:
        if error.name not in {'spec', 'spec.v1', 'spec.v1.definition_proof_pb2'}:
            raise
    # Portable source use follows the same .proto contract as generated Bazel
    # types, rather than maintaining a second JSON/dataclass schema.
    schema = Path(schema or Path(__file__).resolve().parents[2] / 'proto/spec/v1/definition_proof.proto')
    with tempfile.TemporaryDirectory(prefix='definition-schema-') as directory:
        output = Path(directory) / 'schema.pb'
        subprocess.run(['protoc', '-I' + str(schema.parent), '--descriptor_set_out=' + str(output),
                        str(schema)], check=True, capture_output=True)
        pool = descriptor_pool.DescriptorPool()
        for descriptor in descriptor_pb2.FileDescriptorSet.FromString(output.read_bytes()).file:
            pool.Add(descriptor)
    class Messages:
        pass
    for name in ['DefinitionProofRequest', 'DefinitionProofReview', 'DefinitionProofCertificate']:
        setattr(Messages, name, message_factory.GetMessageClass(pool.FindMessageTypeByName('spec.v1.' + name)))
    return Messages


def parse(message_type, data):
    return text_format.Parse(data.decode('utf-8'), message_type())


def encoded(message):
    return message.SerializeToString(deterministic=True)


def code_only(source, strings=False):
    """Remove nested comments and, for token checks, string literal contents."""
    out = []; pos = 0; depth = 0; quoted = False; last_code_char = ''
    while pos < len(source):
        pair = source[pos:pos+2]; char = source[pos]
        if depth:
            if pair == '/-': depth += 1; pos += 2
            elif pair == '-/': depth -= 1; pos += 2
            else:
                out.append('\n' if char == '\n' else ' '); pos += 1
        elif quoted:
            if char == '\\':
                out.append(source[pos:pos+2] if strings else '  '); pos += 2
            else:
                out.append(char if strings else ('\n' if char == '\n' else ' '))
                if char == '"': quoted = False
                pos += 1
        elif pair == '--':
            end = source.find('\n', pos)
            if end < 0: end = len(source)
            out.append(' ' * (end-pos)); pos = end
        elif pair == '/-': depth = 1; out.append('  '); pos += 2
        else:
            # A quote character inside a Lean Char literal is not the start of
            # a String. Treating it as one could hide following declarations.
            before = source[pos-1] if pos else ''
            if char == "'" and (not before or not (before.isalnum() or before in "_'")):
                literal = re.match(r"'(?:[^'\\\r\n]|\\(?:[\\'\"nrt0]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}))'", source[pos:])
                if literal:
                    value = literal.group(0)
                    out.append(value if strings else ' ' * len(value))
                    pos += len(value); last_code_char = "'"; continue
            if char == '"':
                # Interpolation embeds executable Lean terms in the literal;
                # the closed model surface needs ordinary strings only. Raw
                # strings also have different escaping/delimiter semantics.
                if last_code_char == '!':
                    raise ValueError('unsupported interpolated Lean string')
                if re.search(r'\br#*\s*$', ''.join(out)):
                    raise ValueError('unsupported raw Lean string')
                quoted = True
            out.append(char if strings or char != '"' else ' ')
            if not char.isspace(): last_code_char = char
            pos += 1
    if depth or quoted:
        raise ValueError('unterminated Lean comment/string')
    return ''.join(out)


def check_source(source):
    code = code_only(source)
    # No extension commands, compiler execution shortcuts, native proofs,
    # custom trusted imports, or source-local changes to trust/checking policy.
    denied = r'\b(axiom|opaque|sorry|admit|native_decide|unsafe|implemented_by|extern|partial|elab|elab_rules|macro|macro_rules|syntax|initialize|builtin_initialize|run_[A-Za-z_0-9]+|simproc|dsimproc|simproc_decl|dsimproc_decl|builtin_simproc|builtin_dsimproc|attribute|include_str|include_bin|prelude|module|register_[A-Za-z_0-9]+|declare_[A-Za-z_0-9]+)\b'
    if re.search(denied, code) or re.search(r'\[\s*(?:extern|implemented_by)', code):
        raise ValueError('unsupported trusted/deferred/metaprogram declaration')
    if re.search(r'#(?!print\s+axioms\b)', code):
        raise ValueError('only #print axioms diagnostics are allowed')
    for match in re.finditer(r'\bset_option\s+([^\n]+)', code):
        if match.group(1).strip() != 'warningAsError true':
            raise ValueError('unsupported Lean checking option')
    # Attributes can install elaboration handlers without an `elab` command.
    # This closed proof surface needs only the standard simplifier attribute;
    # custom handlers/registrations are executable extensions, not proof data.
    for attribute in re.findall(r'@\[([^\]]*)\]', code):
        if attribute.strip() != 'simp':
            raise ValueError('unsupported Lean attribute')
    for deriving in re.finditer(r'\bderiving\s+([^\n]+)', code):
        if any(name.strip() not in {'DecidableEq', 'Repr', 'BEq', 'Inhabited'}
               for name in deriving.group(1).split(',')):
            raise ValueError('unsupported deriving handler')
    imports = []
    remainder = []
    for line in code.splitlines():
        if re.match(r'^\s*import\b', line):
            names = line.split()[1:]
            if not names or any(not NAME.fullmatch(name) for name in names):
                raise ValueError('malformed Lean import')
            imports.extend(names)
        else:
            remainder.append(line)
    # Modified/multiline imports must not silently disappear from the closure.
    # In particular `public import Lean` previously bypassed the line matcher.
    if re.search(r'\bimport\b', '\n'.join(remainder)):
        raise ValueError('unsupported Lean import syntax')
    return imports


def validate(request, review, read_input):
    if request.schema_version != 1 or review.schema_version != 1:
        raise ValueError('unsupported definition-proof schema')
    if any(not getattr(request, field).strip() for field in
           ['claim_id', 'claim_predicate', 'claim_modality', 'model_scope', 'lean_version']):
        raise ValueError('missing claim, scope, or compiler identity')
    if not re.fullmatch('[0-9a-f]{40}', request.lean_git_revision):
        raise ValueError('compiler revision must be immutable')
    for field in ['theorem_module', 'theorem', 'expected_module', 'expected_proposition',
                  'witness_module', 'domain_witness', 'expected_domain']:
        if not NAME.fullmatch(getattr(request, field)):
            raise ValueError('invalid Lean declaration/module identity: ' + field)
    if request.expected_module in {request.theorem_module, request.witness_module}:
        raise ValueError('expected proposition must be independently authored')
    if (review.request_sha256 != digest(encoded(request)) or review.verdict != 1 or
            not all([review.reviewer.strip(), review.rationale.strip(), review.policy_decision.strip()])):
        raise ValueError('missing, stale, or nonmatching semantic review')
    sources = {}; paths = set()
    for item in request.inputs:
        path = PurePosixPath(item.path)
        if path.is_absolute() or '..' in path.parts or str(path) != item.path or item.path in paths:
            raise ValueError('unsafe or duplicate source path')
        paths.add(item.path)
        if not HEX.fullmatch(item.sha256):
            raise ValueError('invalid source digest')
        data = read_input(item.path)
        if digest(data) != item.sha256:
            raise ValueError('stale source: ' + item.path)
        if item.module:
            if not NAME.fullmatch(item.module) or item.module in sources or item.module == 'DefinitionKernelControl':
                raise ValueError('invalid or duplicate source module')
            if item.module.split('.')[0] in {'Init', 'Std', 'Lean'}:
                raise ValueError('source cannot shadow a trusted compiler module')
            sources[item.module] = data.decode('utf-8')
    if not sources or not paths:
        raise ValueError('empty source population')
    imports = {name: check_source(source) for name, source in sources.items()}
    for name in [request.theorem_module, request.expected_module, request.witness_module]:
        if name not in sources:
            raise ValueError('root/expected/witness module missing from source closure')
    for deps in imports.values():
        for name in deps:
            if name not in sources and name not in {'Init', 'Std'} and not name.startswith(('Init.', 'Std.')):
                raise ValueError('undeclared/untrusted import: ' + name)
    ordered = []; active = set()
    def visit(name):
        if name in ordered: return
        if name in active: raise ValueError('cyclic Lean source imports')
        active.add(name)
        for dep in imports[name]:
            if dep in sources: visit(dep)
        active.remove(name); ordered.append(name)
    for name in sources: visit(name)
    return sources, ordered


def dependencies(output, declarations):
    all_deps = set()
    for declaration in declarations:
        pattern = r"'" + re.escape(declaration) + r"' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)"
        matches = list(re.finditer(pattern, output, re.S))
        if len(matches) != 1:
            raise ValueError('missing/ambiguous kernel dependency report: ' + declaration)
        deps = {part.strip() for part in (matches[0].group(1) or '').split(',') if part.strip()}
        if not deps <= ALLOWED_AXIOMS:
            raise ValueError('unapproved kernel dependency: ' + ', '.join(sorted(deps - ALLOWED_AXIOMS)))
        all_deps.update(deps)
    return sorted(all_deps)


def verify(request, review, read_input, lean, schema=None):
    sources, ordered = validate(request, review, read_input)
    pb = messages(schema)
    certificate = pb.DefinitionProofCertificate(schema_version=1,
        request_sha256=digest(encoded(request)), review_sha256=digest(encoded(review)),
        verifier_sha256=digest(Path(__file__).read_bytes()))
    certificate.request.ParseFromString(encoded(request))
    certificate.review.ParseFromString(encoded(review))
    schema = Path(schema or Path(__file__).resolve().parents[2] / 'proto/spec/v1/definition_proof.proto')
    certificate.schema_sha256 = digest(schema.read_bytes())
    lean = Path(lean).resolve(strict=True)
    certificate.compiler_sha256 = digest(lean.read_bytes())
    # No ambient LEAN_PATH, LEAN_OPTS, or user/precompiled consumer modules.
    env = {key: value for key, value in os.environ.items() if not key.startswith('LEAN_')}
    def run(args, cwd, final=False):
        result = subprocess.run([str(lean)] + args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=180)
        record = certificate.executions.add(argv=['lean'] + args, exit_code=result.returncode,
            output=result.stdout, output_sha256=digest(result.stdout))
        if result.returncode or b'uses \'sorry\'' in result.stdout:
            raise ValueError('actual Lean checking failed:\n' + result.stdout.decode('utf-8', errors='replace'))
        return record.output.decode('utf-8')
    with tempfile.TemporaryDirectory(prefix='verified-definition-') as directory:
        stage = Path(directory)
        env['LEAN_PATH'] = str(stage)
        certificate.compiler_version = run(['--version'], stage).strip()
        certificate.compiler_git_revision = run(['-g'], stage).strip()
        if (not re.search(r'\b' + re.escape(request.lean_version) + r'\b', certificate.compiler_version) or
                certificate.compiler_git_revision != request.lean_git_revision):
            raise ValueError('actual compiler differs from the reviewed toolchain')
        for name, source in sources.items():
            path = stage / (name.replace('.', '/') + '.lean')
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(source)
        for name in ordered:
            relative = name.replace('.', '/')
            run(['--trust=0', '-DwarningAsError=true', '-o', relative + '.olean', relative + '.lean'], stage)
        control = '\n'.join([
            'import ' + name for name in sorted({request.theorem_module, request.expected_module, request.witness_module})
        ]) + '\nset_option warningAsError true\n' + '\n'.join([
            'example : ' + request.expected_proposition + ' := @' + request.theorem,
            'example : ' + request.expected_domain + ' := @' + request.domain_witness,
            '#print axioms ' + request.theorem,
            '#print axioms ' + request.domain_witness,
        ]) + '\n'
        (stage / 'DefinitionKernelControl.lean').write_text(control)
        output = run(['--trust=0', '-DwarningAsError=true', 'DefinitionKernelControl.lean'], stage)
        certificate.logical_dependencies.extend(dependencies(output, [request.theorem, request.domain_witness]))
    certificate.verified_roots = 1
    return certificate


def file_reader(root):
    root = Path(root).resolve(strict=True)
    def read(path):
        target = (root / path).resolve(strict=True)
        if not target.is_relative_to(root): raise ValueError('source symlink escapes owned root')
        return target.read_bytes()
    return read


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, type=Path)
    parser.add_argument('--review', required=True, type=Path)
    parser.add_argument('--schema', type=Path)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--input', action='append', default=[], help='Bazel logical=physical source mapping')
    parser.add_argument('--lean', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    pb = messages(args.schema)
    request = parse(pb.DefinitionProofRequest, args.request.read_bytes())
    review = parse(pb.DefinitionProofReview, args.review.read_bytes())
    if args.input:
        mapping = {}
        for binding in args.input:
            key, value = binding.split('=', 1)
            if key in mapping: raise ValueError('duplicate physical source mapping')
            mapping[key] = Path(value).resolve(strict=True)
        if set(mapping) != {item.path for item in request.inputs}:
            raise ValueError('physical mapping differs from reviewed source inventory')
        read = lambda path: mapping[path].read_bytes()
    else:
        read = file_reader(args.root)
    certificate = verify(request, review, read, args.lean, args.schema)
    args.output.write_bytes(encoded(certificate))
    print('verified definition roots: 1; actual kernel-checked proposition and nonempty-domain witness; model scope only')


if __name__ == '__main__':
    main()
