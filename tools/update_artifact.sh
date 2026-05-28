#!/usr/bin/env bash
# Generic source-tree write-back for a single emitted artifact.
#
# Usage (called by a consumer's sh_binary via args):
#   update_artifact.sh <gen_rel> <dst_rel>
#
# Where:
#   gen_rel  repo-relative path of the generated file under bazel-bin
#            (e.g. lean/axioms.ttl, lean/RFC-0036-spec.md).
#   dst_rel  repo-relative destination in the source tree
#            (e.g. kg/turtle/axioms.ttl, docs/rfc-0036/spec.md). When the
#            destination lives in a different workspace (e.g. a sibling
#            repo's runfiles tree), the caller resolves that path.
#
# Consumer-agnostic: locates the generated file under the bzlmod-canonical
# `_main` runfiles prefix (with a `__main__` WORKSPACE-mode fallback), so it
# works from any consuming module. Idempotent: a no-op if the destination is
# already byte-equal.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: update_artifact.sh <gen_rel> <dst_rel>" >&2
  exit 2
fi
GEN_REL="$1"
DST_REL="$2"

if [[ -z "${BUILD_WORKSPACE_DIRECTORY:-}" ]]; then
  echo "ERROR: must be invoked via 'bazel run //<pkg>:update_<artifact>'" >&2
  exit 1
fi
cd "${BUILD_WORKSPACE_DIRECTORY}"

RUNFILES="${RUNFILES_DIR:-${0}.runfiles}"
SRC=""
for prefix in "${RUNFILES}/_main" "${RUNFILES}/__main__"; do
  if [[ -f "${prefix}/${GEN_REL}" ]]; then SRC="${prefix}/${GEN_REL}"; break; fi
done

if [[ -z "${SRC}" ]]; then
  echo "ERROR: could not locate generated ${GEN_REL} in runfiles" >&2
  echo "       searched under: ${RUNFILES}" >&2
  exit 1
fi

if [[ ! -f "${DST_REL}" ]] || ! cmp -s "${SRC}" "${DST_REL}"; then
  cp "${SRC}" "${DST_REL}"
  echo "  updated ${DST_REL}"
else
  echo "  already up to date: ${DST_REL}"
fi
