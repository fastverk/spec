/**
 * The tenant gate, shown to REJECT.
 *
 * ⛔ RFC-003 §10, verbatim: *"The OAuth flow has since been run end to end
 * against the live deployment by a `savvifi.com` account. What is still
 * unverified is the refusal: no sign-in has been attempted from outside the
 * hosted domain, so `GOOGLE_ALLOWED_DOMAIN` is proved to admit and not yet
 * proved to reject."*
 *
 * A gate that has only ever been shown to admit is an assertion. That is the
 * same sentence this repository applies to `//rdf` fixtures, to `db/verify.mjs`,
 * and to the conformance suite; identity had been the exception, because the rule
 * lived inside a function that talks to Google's token endpoint first.
 *
 * It matters more for #52 than it did for one deployment: per-tenant consoles
 * make this the ONLY thing standing between one consumer's log and another
 * consumer's account.
 *
 * ⚠ What these cases do NOT prove: that Google's signature verification works
 * (jose's, and unchanged), or that a real account at another domain is turned
 * away by the live deployment. The RULE is proved to reject; the deployment is
 * still proved only to admit. Both sentences are true and only one of them was
 * true before.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import { checkClaims, googleConfig, type GoogleConfig, type IdClaims } from "../lib/auth/google";

const NONCE = "n-0S6_WzA2Mj";
const cfg: GoogleConfig = {
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "https://console.example/api/auth/callback",
  allowedDomain: "savvifi.com",
};

/** A verified Workspace account — the positive control every case is measured against. */
const good: IdClaims = {
  sub: "110452103958871",
  email: "ada@savvifi.com",
  email_verified: true,
  hd: "savvifi.com",
  name: "Ada",
  nonce: NONCE,
};

const check = (over: Partial<IdClaims> = {}, nonce = NONCE) =>
  checkClaims({ ...good, ...over }, cfg, nonce);

afterEach(() => vi.unstubAllEnvs());

describe("the tenant gate admits", () => {
  it("a verified account in the Workspace", () => {
    const r = check();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.sub).toBe("110452103958871");
      expect(r.session.email).toBe("ada@savvifi.com");
    }
  });

  it("and lower-cases the address, because the log is forever", () => {
    const r = check({ email: "Ada@Savvifi.com" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.email).toBe("ada@savvifi.com");
  });

  it("and falls back to the address when Google sends no name", () => {
    const r = check({ name: undefined });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.name).toBe("ada@savvifi.com");
  });
});

describe("the tenant gate refuses", () => {
  it("⛔ a consumer account wearing the right address and no `hd`", () => {
    // THE CASE THE MODULE HEADER EXISTS FOR: "a consumer Google account can carry
    // an arbitrary alternate address, and `email` alone would let one in."
    // Anyone can add ada@savvifi.com as an alternate on a personal account; only
    // Google can assert `hd`. This is the attack, and until now nothing ran it.
    const r = check({ hd: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("limited to savvifi.com");
  });

  it("⛔ an account from another Workspace entirely", () => {
    const r = check({ hd: "example.com", email: "ada@example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("ada@example.com");
  });

  it("⛔ the other half of the belt: the right `hd`, an address somewhere else", () => {
    // Neither check substitutes for the other, so each must be shown to refuse
    // on its own. Without this case, deleting the suffix check would pass.
    const r = check({ hd: "savvifi.com", email: "ada@example.com" });
    expect(r.ok).toBe(false);
  });

  it("⛔ an address that merely ENDS with the domain", () => {
    // `ada@notsavvifi.com` ends with the substring `savvifi.com`. The suffix
    // check includes the `@` and this is the case that says so — with `hd` set
    // CORRECTLY, so the hd check cannot be what refuses it and the assertion is
    // about the suffix and nothing else.
    const r = check({ hd: "savvifi.com", email: "ada@notsavvifi.com" });
    expect(r.ok).toBe(false);
    // The same address with a real `@` boundary is admitted, which is what makes
    // the case above a statement about the boundary rather than about the string.
    expect(check({ hd: "savvifi.com", email: "ada@savvifi.com" }).ok).toBe(true);
  });

  it("an unverified address", () => {
    const r = check({ email_verified: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("verified email");
  });

  it("a token minted for a different sign-in attempt", () => {
    const r = check({}, "a-different-nonce");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("could not be matched");
  });

  it("a token carrying no identity at all", () => {
    expect(check({ sub: undefined }).ok).toBe(false);
    expect(check({ email: undefined }).ok).toBe(false);
  });
});

describe("the domain allow-list fails CLOSED", () => {
  const configured = {
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REDIRECT_URI: "https://console.example/api/auth/callback",
  };

  it("⛔ throws rather than admitting everybody when the domain is unset", () => {
    // Exactly like SPEC_KERNEL_SUBS: an unset allow-list means nobody, never
    // everybody. A console that let the whole internet author permanent records
    // because one variable was missing is not a console anybody can trust the
    // log of — and for a per-tenant deployment it is one variable per tenant.
    for (const [k, v] of Object.entries(configured)) vi.stubEnv(k, v);
    vi.stubEnv("GOOGLE_ALLOWED_DOMAIN", undefined);
    expect(() => googleConfig()).toThrow(/fails closed/);
  });

  it("…and is null, not a throw, when no provider is configured at all", () => {
    // "No identity provider" and "you are not signed in" are different answers;
    // local development is the first.
    for (const k of Object.keys(configured)) vi.stubEnv(k, undefined);
    vi.stubEnv("GOOGLE_ALLOWED_DOMAIN", undefined);
    expect(googleConfig()).toBeNull();
  });

  it("reads the domain from THIS deployment's environment", () => {
    // What makes one console per consumer an arrangement rather than a hope.
    for (const [k, v] of Object.entries(configured)) vi.stubEnv(k, v);
    vi.stubEnv("GOOGLE_ALLOWED_DOMAIN", "consumer.example");
    expect(googleConfig()?.allowedDomain).toBe("consumer.example");
  });
});
