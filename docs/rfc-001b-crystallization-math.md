# RFC-001b — Crystallization as Graph Diffusion (formal note)

**Status:** Draft companion to [RFC-001](./rfc-001-unified-spec-graph.md) §2.

This note makes the "diffusion" framing of spec-graph refinement precise, and
marks exactly where the correspondence is literal versus analogical. The summary
claim: spec-graph refinement is a **training-free, energy-guided,
predictor–corrector annealed graph-diffusion sampler**. Each clause is justified
below.

---

## 1. State space

Let $\mathcal{G}$ be the set of typed attributed graphs $G=(V,E)$ where:

- each node $v\in V$ is a **claim** with categorical attributes
  $a(v)=(\text{modality},\text{tier},\text{sectionKind},\text{grounding})$,
  with $\text{modality}\in\{\textsf{MUST},\textsf{MUST\_NOT},\textsf{SHOULD},\textsf{SHOULD\_NOT},\textsf{MAY},\textsf{REQUIRED},\textsf{RECOMMENDED}\}$ and $\text{grounding}\in\{\textsf{grounded},\textsf{loose}\}$;
- each ordered pair $(u,v)$ carries an edge type $e(u,v)\in\mathcal{T}\cup\{\bot\}$,
  $\mathcal{T}=\{\textsf{refines},\textsf{dependsOn},\textsf{conflictsWith},\textsf{realizes},\textsf{benchmarkedAgainst},\textsf{livesIn},\dots\}$, $\bot=$ "no edge".

This is the categorical node/edge state space of **discrete graph diffusion**
(DiGress; D3PM). *(Literal: the data type is identical.)*

## 2. Forward (noising) process

A Markov chain with factorized categorical kernels
$$q(G_t\mid G_{t-1}) = \prod_{v} \mathrm{Cat}\big(a_t(v)\mid a_{t-1}(v)Q^V_t\big)\;\prod_{u,v}\mathrm{Cat}\big(e_t(u,v)\mid e_{t-1}(u,v)Q^E_t\big),$$
with $Q^V_t,Q^E_t$ chosen so the marginals relax toward a reference distribution
$m$ over attributes/types. The $t$-step marginal $q(G_t\mid G_0)$ is closed form
(matrix powers), as in D3PM.

**Prior.** $\pi_{\text{prior}}=\lim_{t\to T}q(G_t\mid G_0)$ is the max-entropy
**"claim gas"**: node attributes i.i.d. from $m$, all edges $\bot$, grounding
$\textsf{loose}$. Tractable to sample. *(Analogue of the Gaussian prior.)*

**Note (caveat C3).** In practice we seldom run this chain on a real document;
`decompose` directly produces a high-entropy seed $G_0'$ near $\pi_{\text{prior}}$
(atomized, loosely linked claims). Starting reverse sampling from a near-prior
state is standard in diffusion. So the forward chain is (i) a conceptual device,
(ii) an optional robustness/augmentation tool (train/evaluate correctors by
corrupting known-good graphs), not a daily component.

## 3. Target as a Gibbs measure (the bridge)

Define the spec energy
$$E(G)=w_1 R(G)+w_2 C(G)+w_3 D(G)+w_4 U(G)-w_5 L(G)-w_6 S(G),$$
where $R$=redundancy, $C$=contradictions, $D$=dangling/loose, $U$=under-specification
(the frontier), $L$=meaningful connectivity, $S$=symmetry compression (MDL gain).
All terms are SPARQL-computable over Jena today (`claim-contradiction.rq`,
`modality-conflict.rq`, `dangling-references.rq`, `dependency-graph.rq`, …).

The **target distribution** is the Gibbs/Boltzmann measure
$$\pi_\tau(G)\propto e^{-E(G)/\tau}.$$
The "data manifold of coherent specs" is its low-$E$ support. On a discrete state
space the role of the Stein/score $\nabla\log p$ is played by the **local
conditional ratios** $\pi_\tau(G')/\pi_\tau(G)$ for $G'$ a neighbor of $G$; an
edit lowering $E$ is a discrete score-ascent step (D3PM's discrete score).

## 4. Reverse process = predictor–corrector

We instantiate the reverse (denoising) dynamics as Song et al.'s
**predictor–corrector** sampler:

- **Predictor** $\mathsf{Pred}_{\tau_t}$ — the LLM ensemble
  (`decompose`→`ClaimPropose`→`CompositeMerge`→`Ensemble`→`Verify`). One reverse
  step: given the current (noisy) neighborhood, predict a cleaner graph
  $G_{t}\to \tilde G_{t-1}$. This is a **training-free, in-context** approximate
  denoiser, conditioned on the vision $y$ (guidance). *(Caveat C1: not score-matched.)*
- **Corrector** $P$ — the deterministic projection kernel: content-hash dedup,
  transitive reduction, symmetry/orbit collapse, canonicalization. Each pass is a
  **monotone projection onto the gate-passing manifold** $\mathcal{M}=\{G:\text{gates pass}\}$
  with the proven invariants
  $$P(G)\in\mathcal{M},\qquad P(P(G))=P(G),\qquad E(P(G))\le E(G),$$
  and a meaning-preservation homomorphism $G\to P(G)$ (modulo collapsed symmetry).
  These are $\tau{=}0$ corrector moves — always accepted.

One refinement round is $G_{t-1}=P\big(\mathsf{Pred}_{\tau_t}(G_t)\big)$, i.e.
**predict then project** — a proximal/splitting sampler.

## 5. Schedule and guidance

- **Schedule.** $\tau_t:\;T\to 0$ is the noise schedule: hot/broad exploration
  early (Haiku$\times$2 breadth, many parallel trajectories), cold/precise late
  (Sonnet→Opus verify, then deterministic projection).
- **Guidance.** Vision $y$ + grounding vocabulary enter as a guided target
  $$\pi_\tau(G\mid y)\propto \exp\!\Big(-\tfrac{1}{\tau}\big(E(G)+\lambda E_{\text{cond}}(G,y)\big)\Big),$$
  with the predictor prompted on $y$ (a conditional denoiser) and $\lambda$ the
  guidance weight — structurally classifier-free guidance.

## 6. Convergence (crystallization)

**Acceptance rule.** A predictor proposal $G\to G'$ is accepted iff
$\Delta E=E(G')-E(G)\le 0$, or with Metropolis probability
$\min\{1,e^{-\Delta E/\tau_t}\}$. Corrector steps (monotone projection) are always
accepted.

**Claim.** Under this rule $E(G_t)$ is a supermartingale (corrector: $\le 0$;
predictor: MH-reversible w.r.t. $\pi_{\tau_t}$), hence converges a.s.; and with
$\tau_t\to 0$ the chain concentrates on **local minima of $E$ within
$\mathcal{M}$**.

A **crystal** is a fixed point $G^\*$ with $P(G^\*)=G^\*$ and no accepted move
lowering $E$. We obtain descent + local optimality — the same guarantee practical
diffusion provides; neither reaches the global mode. *(Honest: local, not global.)*

## 7. Correspondence table

| Diffusion (generative AI) | Spec-graph crystallization | Fidelity |
|---|---|---|
| Categorical node/edge state (DiGress/D3PM) | typed claim/edge graph $\mathcal{G}$ | literal |
| Forward SDE / categorical corruption | $q(G_t\mid G_{t-1})$ via $Q^V_t,Q^E_t$ | literal (defined); rarely run (C3) |
| Gaussian / marginal prior $p_T$ | max-entropy "claim gas" $\pi_{\text{prior}}$ | literal |
| Data distribution $p_0$ | Gibbs $\pi_0\propto e^{-E/\tau_0}$ | analogical (energy, not data) |
| Score $\nabla\log p_t$ | discrete conditional ratios of $\pi_\tau$ | literal (discrete score) |
| Learned denoiser $\epsilon_\theta$ | LLM ensemble (in-context) | **analogical — training-free (C1)** |
| Predictor step | LLM propose/merge/verify | literal |
| Corrector (Langevin) step | deterministic projection $P$ | literal (proven monotone) |
| Noise schedule $\beta_t$ | temperature $\tau_t$ / ensemble tier | literal |
| Classifier-free guidance | vision + grounding $E_{\text{cond}}$, weight $\lambda$ | literal |
| Sample (a generated datum) | a crystallized spec graph | literal |

## 8. What we may and may not claim

- **May claim:** a *training-free, energy-guided, predictor–corrector annealed
  graph-diffusion sampler*; the deterministic projection is a proven corrector;
  the LLM ensemble is the predictor; crystallization = annealed descent to a local
  minimum of $E$ on the gate-passing manifold.
- **May not claim:** a *trained* diffusion model (no score matching, no learned
  $\epsilon_\theta$); a *learned* data manifold ($E$ is engineered/proven);
  global-optimality.

## 9. What this buys (beyond a nice metaphor)

1. **An objective.** $E(G)$ makes "better spec" measurable and gives the
   refinement a stopping criterion (a crystal).
2. **A schedule.** Principled hot→cold scaling of the agent fleet (where to spend
   Opus vs. Haiku, when to stop exploring).
3. **A correctness story.** The corrector's proven monotonicity is *why* parallel
   stochastic agents converge instead of thrash — the diffusion frame names the
   role the `ratio`-style proven kernel plays here.
4. **A research path.** If we later want a *trained* model: collect (corrupted,
   clean) graph pairs via §2's forward process and learn a graph-denoiser
   $\epsilon_\theta$ and/or an energy $E_\theta$ — turning the training-free
   sampler into an actual learned graph-diffusion model. The architecture is
   forward-compatible with that.

## References (concepts, for grounding the analogy)

- Ho, Jain, Abbeel. *Denoising Diffusion Probabilistic Models* (DDPM), 2020.
- Song, Sohl-Dickstein, Kingma, Kumar, Ermon, Poole. *Score-Based Generative
  Modeling through SDEs* (predictor–corrector; probability-flow ODE), 2021.
- Austin et al. *Structured Denoising Diffusion Models in Discrete State-Spaces*
  (D3PM), 2021.
- Vignac et al. *DiGress: Discrete Denoising Diffusion for Graph Generation*, 2022.
- Song, Ermon. *Generative Modeling by Estimating Gradients of the Data
  Distribution* (annealed Langevin), 2019.
- Ho, Salimans. *Classifier-Free Diffusion Guidance*, 2022.
