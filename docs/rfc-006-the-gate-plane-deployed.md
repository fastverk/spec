# RFC-006 — the gate plane, deployed

Status: **proposed**. Follows RFC-005 (which engine answers) and RFC-004 §4.3
(what the service should offer). This one is about where it runs and what it
costs, and it is much cheaper than RFC-004 assumed because most of it already
exists.

---

## 1. What is already running

Verified against the `fastverk` EKS cluster in account `491117466965`, not
inferred:

| | |
|---|---|
| `plugin-spec` | **running 1/1**, image `491117466965.dkr.ecr.us-east-1.amazonaws.com/spec:ee840289f3b2`, ports `http/8080` + `grpc/50056`, ClusterIP |
| the fleet | 16 plugins, every one `http/8080` + a named `grpc` port. gRPC is already the east-west idiom here |
| `/mcp` | already served — `services/spec/src/http.rs:96-98` mounts `crate::mcp::router(...)` |
| images | pushed per commit; newest `ef7ddbb9d1d9` (2026-08-11). The pod is simply behind |
| the front door | ALB group `fastverk-public`, internet-facing, HTTPS:443, `target-type: ip` |

**RFC-004 §4.3 budgets ≈$38/mo for a new Fargate task and says "AWS gets nothing
in Phases 0–5."** AWS already has something, it is already paid for, and the
marginal cost of adding RPCs to a pod that exists is zero. That section should be
read as superseded on cost, not on design.

Two corrections, both recorded because I got them wrong in sequence.

`ci.yml:75-90` reads like a live 401 against the private `fastverk-plugin-crates`
repo, and `MODULE.bazel` says the OCI image "could not be built by CI and had to
be produced by hand." Both describe problems that were **fixed** — the block
documents the App-token mint, and ECR shows a fresh image per commit.

⛔ **But that does not mean a NEW image is cheap, and I then over-generalized it
into "the image path is not a risk."** It is not: **nothing in this repository
builds or pushes an image at all.** `ci.yml` has exactly two jobs, `gate` and
`console`, and neither touches ECR — a grep suggesting otherwise was matching
"s-ecr-ets". The `spec:<sha>` tags are pushed by the platform build-runner, per
the Dockerfile's own note that "the platform's canonical build is the bazel
`rules_fastverk_plugin` macro / `//services/spec:spec-image`; this Dockerfile is
the pragmatic cross-arch path until the build-runner bakes the bazel image on a
linux worker."

So §3's sidecar needs a JVM image, and **producing one is work in `fastverk/build`,
not here.** The three options, none free: teach the build-runner a second image;
add an image build to spec's CI, duplicating a pipeline the platform deliberately
centralised; or bundle a JRE into the existing `spec-server` image, which is
distroless today and would grow by ~180 MB for a process most deployments will
never call. **This is the open question gating deployment, and it is not
answerable from inside this repo.**

## 2. The front door shares an ALB, and that is the whole cost story

**No new load balancer.** The AWS Load Balancer Controller merges every Ingress
carrying the same `alb.ingress.kubernetes.io/group.name` onto one ALB, and
`fastverk-public` has room:

```
rules      6 / 100
certs      4 / 25
hosts      app · hooks · mcp · mirror .fastverk.com
```

A second ALB would be ~$16–22/mo of base charge before a byte moves, for nothing
that the existing one cannot do. So:

```yaml
alb.ingress.kubernetes.io/group.name: fastverk-public   # ⛔ share, do not create
alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
alb.ingress.kubernetes.io/target-type: ip
alb.ingress.kubernetes.io/backend-protocol-version: GRPC
alb.ingress.kubernetes.io/certificate-arn: <new cert for spec.fastverk.com>
```

`backend-protocol-version` is a **per-target-group** setting, so a gRPC backend
coexists with the four HTTP/1.1 backends already on that ALB. Sharing costs
nothing in capability.

**DNS.** One public `fastverk.com` zone in this account
(`Z01797023FIJ030ZIGZEA`, 60 records), live and delegated — `app.fastverk.com`
resolves. `spec.fastverk.com` is free. `external-dns` is running in the
`fastverk` namespace with `--domain-filter=fastverk.com --provider=aws
--aws-zone-type=public`, so the record follows the Ingress with no manual step.

⚠ It runs `--policy=upsert-only`, which means it **never deletes**. Removing the
Ingress later leaves `spec.fastverk.com` resolving at an ALB that no longer
routes it — a name that answers and a service that is gone are harder to debug
than a name that does not resolve. Deleting the record is a manual step, and
nothing will remind anyone.

⚠ The existing ACM cert covers `app.fastverk.com` with a single SAN and no
wildcard, so a new hostname needs its own cert. Certs are immutable; four are
already attached to that listener, which is the established pattern.

⚠ A gRPC target group's health check cannot be a plain `GET /healthz` — it needs
`healthcheck-protocol-version: GRPC` with a gRPC health service, or an HTTP check
with `success-codes: 0-99` (gRPC status codes, not HTTP). Getting this wrong
produces a target group that never goes healthy while every container is fine.

**Total marginal infrastructure cost: one ACM certificate ($0) and one Route 53
record set (~$0).**

## 3. Where the JVM runs

**A second container in the pod that already exists**, not a new Deployment.
`plugin-spec` already runs exactly two containers — `spec-server` and `git-sync`
(verified on the live Deployment) — so multi-container is established here and
the chart has a place to put a third.

The Rust process keeps the front door and reaches the JVM on loopback. That is
RFC-004 §4.3's own instinct — *"gRPC is kept between the Rust and JVM containers
on loopback, where it is free, and off the internet-facing hop, where it costs
the auth story"* — and it survives unchanged.

What that buys over a separate Deployment: no second Service, no second
ArgoCD-managed workload, no cross-pod hop, and the JVM's lifecycle is the
plugin's. What it costs: the two scale together. At one replica that is not a
trade-off yet.

⚠ Sizing is unmeasured. The corpus is 220 KB of Turtle and `gate_cli` runs four
gates in 0.52s on a laptop, but no one has measured the JVM's resident set under
a warm Jena `Model`. Set a request, watch it, and do not copy RFC-004 §4.3's
"1 vCPU / 2 GB" — that number was sized for a Fargate task nobody is now
building.

## 4. Auth: verified in the service, not at the front door

RFC-004 §4.3 rules out gRPC on the internet-facing hop because "ALB has no SigV4
authorizer" and "gRPC and Vercel-OIDC meet at no AWS front door except VPC
Lattice." **That argument is about making the front door do the authenticating,
and it dissolves when the service does it.**

The console sends `getVercelOidcToken({ audience: 'https://spec.fastverk.com' })`
in gRPC metadata; the plugin verifies it against the `oidc.vercel.com` JWKS with
`aud` **and** `environment:production` pinned. The ALB routes and terminates TLS
and authenticates nothing. No SigV4, no mTLS, no client certificate in Vercel's
environment, no key to rotate.

⛔ **Not the default-audience token.** Vercel's default OIDC `aud` is
`https://vercel.com/<team-slug>` and its `sub` is
`owner:<team>:project:<project>:environment:<env>` — precisely the claims an AWS
trust policy pins for `sts:AssumeRoleWithWebIdentity`. Forwarding the raw token
hands a service, on every call, a credential replayable against STS for any role
in the account trusting that project. Audience-scoping is one parameter.

⚠ The fleet's existing mechanism is a **shared** bearer token
(`builds-secrets/plugin-token`, validated as `require_gateway_token`). It would
work today with no new code, and it is weaker: one static secret, shared across
every plugin, with no per-caller identity. Acceptable as a stopgap; it should not
be the answer once a permanent record can be attributed to the caller.

## 5. What the service may answer, and what it may not

`Derivation.RunGates` and `Derivation.Preflight`, per `derivation.proto`. Both
carry counts and never rows, and the proto imports nothing so
`//proto/spec/v1:data_boundary_test` extends unchanged.

**An MCP facade for the read plane, and only the read plane.** `/mcp` is already
mounted, so `preflight` and `run_gates` are handlers to add rather than a service
to stand up — and their value is that agents which are *not* eve get them too.

⛔ **No write tool over MCP.** `propose_requirement` parks on an `always()`
approval and takes its `author` from `ctx.session.auth.current` — the approving
human. MCP has no approval semantics and no session principal, so a write tool
there has nobody to attribute to, and "a machine did it" is nobody. That is
invariant ⑤, and it is the same boundary RFC-004 §3.3 draws when it makes
`record_evaluation` a console form rather than a tool.

## 6. Order, and the honest stopping point

1. ✅ `//java:gate_binary` — a long-lived wrapper over `gate_cli`'s library,
   holding a warm `Model`. Local, no AWS. **Done.**
2. ✅ **UNBLOCKED, and done.** This read "BLOCKED on §1's second correction — the
   sidecar needs a JVM image and this repo cannot produce one." It can now:
   `//java:gate_image` builds here and `ci.yml`'s `image` job pushes it to
   `spec-gate` per-sha. The tag nothing populated is populated. The chart's
   sidecar is in `deploy/charts/plugin-spec`, disabled by default.
3. The Ingress above, sharing `fastverk-public`, plus the cert and record.
4. Vercel OIDC verification in the plugin.
5. The console calls `Preflight` before submitting a proposal.
6. The agent gets a `preflight` tool — **last**, and only with
   `EXAMINED_NOTHING` in the response, because a tool that returns "PASSED" over
   an unexamined population is worse than no tool.

**Steps 1–2 are the ones that matter.** They make preflight callable at all. 3–4
only make it callable *from Vercel*, and if that stalls on a certificate or a
DNS delegation, everything before it still works from inside the cluster and from
CI.

⭐ **A step this list never had, now done: the service itself.** The numbering
above jumps from the sidecar to the Ingress as though `Derivation` were free —
§5 names the two RPCs and nothing was going to serve them. `services/spec` now
does, on the same gRPC port as the nav plane, proxying to the sidecar on
loopback. The numbering is left alone so existing references still resolve; read
this as 2½, and note what it means for **step 3**: the Ingress now has something
to expose that is not `LayoutService`.

The service also answers what §5 left implicit — what happens when the plane is
asked something it cannot honestly answer. Three refusals, each in place of a
confident wrong answer: `removals_turtle` (the sidecar has no removal channel,
so the result would be the proposal minus its deletions), a pinned
`parent_corpus_version` (unverifiable — the sidecar reports no version), and a
gate name that is not in the suite (silently dropping it makes a typo read as a
gate that passed).

✅ The stale-chart warning that stood here is resolved:
`deploy/charts/plugin-spec/values.yaml` pointed at the **aion-dev** ECR
(`042825952740`) while the live pod ran from fastverk's own (`491117466965`),
which would have moved the image backwards on the first sync. It now names
fastverk's, with both image tags supplied by the deploying pipeline and
`required` — an empty tag used to render `spec:` and fail in the cluster, which
is the same class of mistake one layer further out.
