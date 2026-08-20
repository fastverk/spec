/**
 * The console is the only way to the log, and the agent has no other door.
 *
 * ⛔ THE AGENT HOLDS NO DATABASE CREDENTIAL AND CANNOT BE GIVEN ONE. Every write
 * goes through `POST /api/proposal/op` — the same route the browser posts to,
 * reaching the same `lib/door.ts` — so every check that door performs applies to
 * the agent unchanged and without being reimplemented: the closed op vocabulary,
 * the capability table, the canonical bytes, the content address, and the
 * append-only table itself.
 *
 * ⚠ `parent` is NOT among them, and this list used to say it was. The door
 * requires a `parent` and records it; it does not verify that the string names a
 * real bitemporal read point — RFC-002 §7.1 has said so under "cannot, today"
 * since P0, and §13 files it as open. It matters more now than it did: the read
 * point is part of the content address, so two agents that spell the same read
 * point differently produce two proposals rather than one.
 *
 * The alternative, giving the agent its own connection, would mean an LLM
 * holding INSERT on a log with no DELETE, and every one of those checks living
 * in a second place where it could silently differ.
 */
// ⚠ 5175 is the port `console/package.json`'s `dev` script actually binds
// (`next dev -H 127.0.0.1 -p 5175`). The default was 5177, so an agent started
// without SPEC_CONSOLE_URL failed every tool call with a connection refused
// against a port nothing has ever served.
const BASE = (process.env["SPEC_CONSOLE_URL"] ?? "http://127.0.0.1:5175").replace(/\/$/, "");

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
 *
 * The 202 carries `address` — the proposal's content address — and `verdict`.
 * ⚠ The address does NOT see `surface`, so an op an agent drafted and the same
 * op a person typed have the SAME name and differ only in the provenance record
 * beside it. That is RFC-002 §9.1 working as intended and not a collision: what
 * an agent produced is answered by the log's `surface` column, never by the id.
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
