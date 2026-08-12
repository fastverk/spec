/**
 * The console is the only way to the log, and the agent has no other door.
 *
 * ⛔ THE AGENT HOLDS NO DATABASE CREDENTIAL AND CANNOT BE GIVEN ONE. Every write
 * goes through `POST /api/proposal/op`, the same route the browser posts to, so
 * every check that route performs — the closed op vocabulary, the capability
 * table, the parent read point, the canonical bytes, the append-only table
 * itself — applies to the agent unchanged and without being reimplemented.
 *
 * The alternative, giving the agent its own connection, would mean an LLM
 * holding INSERT on a log with no DELETE, and every one of those checks living
 * in a second place where it could silently differ.
 */
const BASE = (process.env["SPEC_CONSOLE_URL"] ?? "http://127.0.0.1:5177").replace(/\/$/, "");

export type Overlay = {
  corpus_version: string;
  requirements: Record<string, unknown>[];
  terms: Record<string, unknown>[];
  write_enabled: boolean;
  write_disabled_because: string;
};

async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // ⚠ The console's refusals are WORTH READING, so they are carried through
    // verbatim rather than flattened to "request failed". `E_OP_REJECTED` names
    // the field and the op; a model that sees the real reason stops, and a model
    // that sees "500" retries.
    const ops = Array.isArray(body["ops"])
      ? (body["ops"] as { reason?: string }[]).filter((o) => o.reason).map((o) => o.reason).join("; ")
      : "";
    throw new Error(ops || String(body["message"] ?? body["error"] ?? `${path} → ${res.status}`));
  }
  return body;
}

/** The corpus with pending proposals applied — the same view every pane reads. */
export async function overlay(): Promise<Overlay> {
  return (await json("/api/overlay", { cache: "no-store" } as RequestInit)) as unknown as Overlay;
}

/**
 * Submit one op.
 *
 * `surface` is `"Agent"` — a value `0001_schema.sql`'s CHECK has always accepted
 * and nothing has ever set. It is how a reader tells a row an agent drafted from
 * a row a person typed, and it costs nothing to record honestly.
 *
 * ⛔ `author` is NOT set here and cannot be. The console derives it from the
 * session, so a proposal is attributed to the human whose approval released it.
 * There is no agent principal anywhere in this design — `proposal.ts` rejects
 * every agent op that is not `assertNS` at R0, and rather than route around that
 * rule this agent never needs it.
 */
export async function submitOp(
  op: string,
  fields: Record<string, unknown>,
  parent: string,
): Promise<Record<string, unknown>> {
  return json("/api/proposal/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, parent, surface: "Agent", ...fields }),
  });
}
