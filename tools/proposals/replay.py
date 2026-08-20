#!/usr/bin/env python3
"""Replay the log through one proposal, by its content address.

RFC-002 §12's P1 gate, in the form it can actually take today:

    spec replay <bootstrap-pid> reproduces the committed corpus TTL byte-identically

    python3 tools/proposals/replay.py --list
    python3 tools/proposals/replay.py --address sha256:… --project studio --check
    python3 tools/proposals/replay.py --address sha256:… --project studio --out /tmp/x

## Why replay is by id and not by re-running anything

RFC-002 §5, property 1: *"Replay is by id, never by re-running a model. A
chat-authored proposal replays because the ops are recorded, not because the LLM
is deterministic — which it is not."* That is the answer to "how can an
LLM-authored specification be reproducible", and it needs exactly two things: an
append-only log of ops, and a name for each record in it. The log has existed
since the console shipped. The name arrived with the door.

## ⛔ The address is RECOMPUTED, never trusted

Every record here is named by hashing its own `canonical` bytes, not by reading
the `address` field. The field is then compared to the recomputation, and a
disagreement is a hard error rather than a warning: a record that lies about its
own name is the one failure this tool exists to be able to detect. It is also why
records written before the door (which carry no `address` at all) replay
perfectly well — their name was always implied by their bytes.

## What "reproduces" means, precisely

`materialize.py` is run over the log PREFIX ending at the named record, and its
output is compared byte for byte with what is committed. Two things follow:

  * Replaying the LAST record must reproduce `corpus/<project>/proposals.ttl`
    exactly — which is what //corpus/<project>:proposals_ttl_matches_the_log
    already asserts, by a different route.
  * Replaying an EARLIER record reproduces the corpus as it stood after that
    proposal, which is not committed anywhere and is the point: it is how you
    answer "what did this change actually do" without trusting a diff.

⚠ The evaluation log is passed WHOLE, not truncated. It is a separate ordering —
measurements, not judgements — and a proposal's address says nothing about which
measurements had been taken when it was made. Pin it separately if that is ever
needed; pretending one address orders both logs would be inventing a fact.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

ADDRESS_PREFIX = "sha256:"


def canonical_json(v) -> str:
    """Deterministic JSON: keys sorted, no whitespace, no unrenderable numbers.

    A THIRD implementation of the same rule (console/lib/canonical.ts and
    services/spec/src/proposal.rs are the others), and written out here rather
    than delegated to `json.dumps(sort_keys=True)` for one reason that matters
    and one that does not:

      ⛔ `json.dumps` renders floats and large integers however Python feels, so
         it would happily produce a pre-image the other two refuse to write. The
         refusal has to be part of the canonicalizer or it is not a rule.
      ⚠  Python sorts `str` by code point and Rust sorts `String` by UTF-8 bytes,
         which agree everywhere — UTF-8 is order-preserving. JavaScript's default
         sort does NOT, which is why console/lib/canonical.ts has a comparator.
    """
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        # 2^53 − 1: the range where every implementation renders plain digits.
        if abs(v) > 9007199254740991:
            raise ValueError(f"{v} is not a safe integer")
        return str(v)
    if isinstance(v, float):
        raise ValueError(f"{v} is not a safe integer")
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-8"))
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(v[k])}" for k in keys) + "}"
    raise ValueError(f"cannot serialize {type(v).__name__}")


def address_of(body: dict) -> str:
    """The content address of a proposal body: sha256 over {author, ops, parent}.

    ⛔ THREE FIELDS. `surface` and `intent` are in the stored bytes and not in
    the pre-image, so a chat-authored and a click-authored change are one
    proposal with two provenance records (RFC-002 §4.1, §9.1).
    """
    pre = canonical_json(
        {"author": body["author"], "ops": body["ops"], "parent": body["parent"]}
    )
    return ADDRESS_PREFIX + hashlib.sha256(pre.encode("utf-8")).hexdigest()


class Record:
    def __init__(self, index: int, line: str, rec: dict, body: dict):
        self.index = index
        self.line = line
        self.rec = rec
        self.body = body
        self.address = address_of(body)

    @property
    def claimed(self):
        return self.rec.get("address")

    @property
    def verdict(self):
        return self.rec.get("verdict", "")

    def describe(self) -> str:
        ops = ",".join(op.get("op", "?") for op in self.body.get("ops", []))
        who = self.rec.get("author_email") or self.rec.get("author") or ""
        return f"{self.index}\t{self.address}\t{self.verdict or '-'}\t{who}\t{ops}"


def read(path: pathlib.Path):
    """Every record, in append order, each named by its own bytes.

    ⛔ split("\\n"), never splitlines(). Python splits on U+2028, U+2029 and
    U+0085 as well; JSON does not, and a proposal whose text carried a LINE
    SEPARATOR would become two unparseable fragments. Same reason as
    materialize.py, where it was measured rather than inferred.
    """
    out, problems = [], []
    if not path.exists():
        return out, problems
    for i, line in enumerate(path.read_text(encoding="utf-8").split("\n")):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            body = json.loads(rec["canonical"])
            r = Record(i, line, rec, body)
        except Exception as e:
            problems.append(f"record {i}: unreadable ({e})")
            continue
        # ⛔ A hard error, not a skip. Every other malformed-record case here is
        # survivable — one bad line must not hide the good ones. This one is not:
        # a record whose stored name is not the name of its own body means either
        # the log or the addressing rule has been changed under us, and replaying
        # the rest would produce a corpus attributed to bytes nobody wrote.
        if r.claimed is not None and r.claimed != r.address:
            problems.append(
                f"record {i} claims {r.claimed} but its bytes address to {r.address}"
            )
        out.append(r)
    return out, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default="logs/proposals.jsonl")
    ap.add_argument("--evaluations", default="logs/evaluations.jsonl")
    ap.add_argument("--address", help="the proposal to replay through; default the last record")
    ap.add_argument("--project")
    ap.add_argument("--corpus", help="the committed corpus dir, for --check")
    ap.add_argument("--out", help="write the replayed TTL here instead of comparing")
    ap.add_argument("--list", action="store_true", help="every record and its address")
    ap.add_argument("--check", action="store_true",
                    help="exit 1 unless the replay reproduces the committed TTL byte for byte")
    args = ap.parse_args()

    log = pathlib.Path(args.log)
    records, problems = read(log)
    for why in problems:
        print(f"  {log}: {why}", file=sys.stderr)
    if problems:
        return 1

    if args.list:
        print("#\taddress\tverdict\tauthor\tops")
        for r in records:
            print(r.describe())
        print(f"\n{len(records)} record(s) in {log}", file=sys.stderr)
        return 0

    if not records:
        # ⚠ Empty is not absent, and neither is an error. It means no proposal has
        # been promoted yet — see logs/README.md.
        print(f"{log} holds no records; there is nothing to replay.", file=sys.stderr)
        return 1

    if args.address:
        matches = [r for r in records if r.address == args.address]
        if not matches:
            print(f"no record in {log} addresses to {args.address}", file=sys.stderr)
            print("  (try --list; the address is recomputed from each record's bytes)", file=sys.stderr)
            return 1
        # ⚠ NOT an error. Two identical proposals from one author against one read
        # point have the same address BY CONSTRUCTION — that is what content
        # addressing means. Replay through the LAST of them: the log is ordered
        # and later wins.
        through = matches[-1]
    else:
        through = records[-1]

    if not args.project:
        print("--project is required (the log carries every project)", file=sys.stderr)
        return 1

    prefix = [r for r in records if r.index <= through.index]
    print(f"replaying {len(prefix)} of {len(records)} record(s), through {through.address}",
          file=sys.stderr)

    with tempfile.TemporaryDirectory() as tmp:
        staged = pathlib.Path(tmp) / "proposals.jsonl"
        staged.write_text("\n".join(r.line for r in prefix) + "\n", encoding="utf-8")
        out_dir = pathlib.Path(args.out) if args.out else pathlib.Path(tmp) / "corpus"
        out_dir.mkdir(parents=True, exist_ok=True)

        here = pathlib.Path(__file__).resolve().parent
        cmd = [
            sys.executable, str(here / "materialize.py"),
            "--log", str(staged),
            "--corpus", str(out_dir),
            "--project", args.project,
        ]
        if args.evaluations and pathlib.Path(args.evaluations).exists():
            cmd += ["--evaluations", args.evaluations]
        r = subprocess.run(cmd, capture_output=True, text=True)
        sys.stderr.write(r.stderr)
        if r.returncode != 0:
            return r.returncode

        replayed = (out_dir / "proposals.ttl").read_text(encoding="utf-8")

        if not args.check:
            print(out_dir / "proposals.ttl")
            return 0

        if not args.corpus:
            print("--check needs --corpus", file=sys.stderr)
            return 1
        committed_path = pathlib.Path(args.corpus) / "proposals.ttl"
        committed = committed_path.read_text(encoding="utf-8") if committed_path.exists() else ""
        if replayed != committed:
            print(f"DIFFERS — replaying through {through.address} does not reproduce "
                  f"{committed_path}", file=sys.stderr)
            if through.index != records[-1].index:
                print("  ⚠ this is not the last record in the log, so a difference is "
                      "EXPECTED unless the corpus was committed at exactly this point.",
                      file=sys.stderr)
            return 1
        print(f"byte-identical: {committed_path} is the replay of {through.address}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
