"use client";

import { useCallback, useEffect, useState } from "react";

import type { Row } from "../lib/overlay";

export type Overlay = {
  corpus_version: string;
  requirements: Row[];
  terms: Row[];
  proposals: Row[];
  evaluations: Row[];
  records: number;
  write_enabled: boolean;
  write_disabled_because: string;
};

/**
 * The pending overlay, fetched separately from the corpus.
 *
 * ⛔ `error` is a THIRD state, not an empty result. The corpus is rendered from
 * the build and stays readable; when this fails the page says "could not read
 * pending proposals — showing the corpus only", which is a different statement
 * from "nothing is pending". Collapsing the two is how a console tells someone
 * their write did not land.
 *
 * `cache: "no-store"`: the overlay is rebuilt on read rather than invalidated, so
 * a write is visible on the very next request.
 */
export function useOverlay() {
  const [data, setData] = useState<Overlay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/overlay", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || `overlay → ${res.status}`);
      setData(body as Overlay);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

/** Submit one op. `parent` is the read point — there is no default. */
export async function submitOp(
  op: string,
  fields: Record<string, unknown>,
  parent: string,
): Promise<Record<string, unknown>> {
  const res = await fetch("/api/proposal/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, parent, surface: "Meridian", ...fields }),
  });
  const body = await res.json();
  if (!res.ok) {
    const ops = Array.isArray(body.ops)
      ? body.ops.filter((o: { reason?: string }) => o.reason).map((o: { reason: string }) => o.reason).join("; ")
      : "";
    throw new Error(ops || body.message || body.error || `write → ${res.status}`);
  }
  return body;
}
