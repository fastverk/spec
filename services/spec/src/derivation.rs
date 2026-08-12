//! `spec.v1.Derivation` — the gate plane, served.
//!
//! RFC-006 §5: `RunGates` and `Preflight`, both carrying counts and never rows.
//! The work happens in the JVM sidecar on loopback ([`crate::gate`]); this is the
//! typed front door, and its job is to refuse the questions the plane behind it
//! cannot honestly answer rather than to pass them through and dress up whatever
//! comes back.
//!
//! There are three of those refusals, and each one exists because the alternative
//! is a confident wrong answer:
//!
//!   * **`removals_turtle`** — `/preflight` has no removal channel. Ignoring
//!     removals would preflight the proposal MINUS its deletions and report the
//!     result as the proposal's. Loudly incomplete beats silently wrong; this is
//!     the exact sentence `GateServer`'s javadoc ends on.
//!   * **`parent_corpus_version`** — the sidecar parses whatever its image baked
//!     and never says which. A pinned read point cannot be checked here, and a
//!     preflight answered against a different corpus than the caller believes is
//!     a verdict about somebody else's graph.
//!   * **an unknown gate name in the filter** — silently returning fewer gates
//!     makes a typo read as "that gate passed", by absence.

use std::sync::Arc;

use tonic::{Request, Response, Status};

use crate::derivation_proto::derivation_server::{Derivation, DerivationServer};
use crate::derivation_proto::{
    GateReport, GateStatus, PreflightRequest, PreflightResponse, RunGatesRequest,
};
use crate::gate::{GateClient, GateError};

pub struct DerivationService {
    gate: Arc<GateClient>,
}

impl DerivationService {
    pub fn new(gate: Arc<GateClient>) -> Self {
        Self { gate }
    }

    pub fn into_server(self) -> DerivationServer<Self> {
        DerivationServer::new(self)
    }

    /// ⛔ ONE CORPUS. The plane holds exactly one, parsed at startup from what its
    /// image baked, and this process cannot see which — so a request naming a
    /// project is honoured only against a name somebody configured
    /// (`$SPEC_GATE_PROJECT`). Answering over whichever corpus happens to be
    /// loaded would attribute one project's verdict to another with nothing in
    /// the response to reveal it.
    fn check_project(&self, project: &str) -> Result<(), Status> {
        let asked = project.trim();
        if asked.is_empty() {
            return Ok(());
        }
        match self.gate.serves_project() {
            Some(serves) if serves == asked => Ok(()),
            Some(serves) => Err(Status::failed_precondition(format!(
                "this gate plane serves the `{serves}` corpus; `{asked}` would need a \
                 differently-baked sidecar image"
            ))),
            None => Err(Status::failed_precondition(format!(
                "this gate plane cannot confirm which corpus it holds, so it will not \
                 answer for `{asked}` — the sidecar parses whatever its image baked and \
                 reports no version. Set $SPEC_GATE_PROJECT to the project that image \
                 bakes, or send an empty `project` to mean \"whatever this plane holds\""
            ))),
        }
    }
}

#[tonic::async_trait]
impl Derivation for DerivationService {
    async fn run_gates(
        &self,
        request: Request<RunGatesRequest>,
    ) -> Result<Response<GateReport>, Status> {
        let req = request.into_inner();
        self.check_project(&req.project)?;
        let report = self.gate.gates().await.map_err(to_status)?;
        Ok(Response::new(select_gates(report, &req.gates)?))
    }

    async fn preflight(
        &self,
        request: Request<PreflightRequest>,
    ) -> Result<Response<PreflightResponse>, Status> {
        let req = request.into_inner();

        if !req.removals_turtle.is_empty() {
            return Err(Status::unimplemented(
                "this gate plane has no removal channel: /preflight takes additions only, so \
                 a preflight carrying removals would measure the proposal minus its \
                 deletions and report that as the proposal's verdict. Every one of the 17 \
                 authoring constructors materializes as appended triples today \
                 (tools/proposals/materialize.py has no `.remove(`), so this is reachable \
                 only by a caller that has gone past that vocabulary",
            ));
        }
        if !req.parent_corpus_version.trim().is_empty() {
            return Err(Status::failed_precondition(
                "this gate plane cannot honour a pinned parent_corpus_version: the sidecar \
                 holds whatever corpus its image baked and reports no version, so the pin \
                 cannot be checked — and a preflight answered against a corpus the caller \
                 did not name is a verdict about a different graph. Send it empty to mean \
                 \"whatever this plane holds\"",
            ));
        }

        // ⛔ Not an empty delta. A preflight of nothing is not a measurement, and
        // answering "admissible" to it would tell a caller their proposal is safe
        // when no proposal arrived. The sidecar refuses this too; refusing here
        // as well keeps the message typed and saves the hop.
        let turtle = req.additions_turtle.join("\n");
        if turtle.trim().is_empty() {
            return Err(Status::invalid_argument(
                "additions_turtle is empty — a preflight of nothing is not a result",
            ));
        }

        Ok(Response::new(
            self.gate.preflight(&turtle).await.map_err(to_status)?,
        ))
    }
}

/// Restrict a report to the named gates, or return it whole when none are named.
///
/// ⛔ THE COUNTS ARE RECOMPUTED, and they have to be. `failed`,
/// `examined_nothing` and `clean` describe the SUITE; leaving them beside a
/// filtered `gates` list would state a summary about gates the response does not
/// contain — including `clean: false` for a subset in which nothing failed, and
/// the reverse.
///
/// ⛔ And `clean` keeps the engine's rule: no failures AND nothing blind. Not
/// `failed == 0`. A subset of gates that all examined nothing has no failures and
/// has checked nothing, and calling that clean is the vacuous pass this system
/// exists to refuse.
fn select_gates(report: GateReport, want: &[String]) -> Result<GateReport, Status> {
    if want.is_empty() {
        return Ok(report);
    }
    let missing: Vec<&str> = want
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty() && !report.gates.iter().any(|g| g.name == *w))
        .collect();
    if !missing.is_empty() {
        // Silently dropping these would make a typo read as a gate that passed.
        let have: Vec<&str> = report.gates.iter().map(|g| g.name.as_str()).collect();
        return Err(Status::invalid_argument(format!(
            "no such gate(s): {} — this suite has: {}",
            missing.join(", "),
            have.join(", ")
        )));
    }
    // Suite order, not request order: the engine's order is the one the gates
    // were declared in, and reordering by request would make two callers see the
    // same suite differently.
    let gates: Vec<_> = report
        .gates
        .into_iter()
        .filter(|g| want.iter().any(|w| w.trim() == g.name))
        .collect();
    let failed = gates
        .iter()
        .filter(|g| g.status == GateStatus::Failed as i32)
        .count() as i64;
    let blind = gates
        .iter()
        .filter(|g| g.status == GateStatus::ExaminedNothing as i32)
        .count() as i64;
    Ok(GateReport {
        gates,
        corpus_version: report.corpus_version,
        failed,
        examined_nothing: blind,
        clean: failed == 0 && blind == 0,
    })
}

/// ⚠ The distinction between "not deployed" and "not answering" is kept, because
/// the two want different reactions: FAILED_PRECONDITION says stop and change the
/// deployment, UNAVAILABLE says the sidecar may still be coming up and a retry is
/// reasonable. Collapsing both into UNAVAILABLE would have a caller retry forever
/// against a pod that has no gate container in it.
fn to_status(e: GateError) -> Status {
    match e {
        GateError::NotConfigured => Status::failed_precondition(e.to_string()),
        GateError::Unreachable { .. } => Status::unavailable(e.to_string()),
        // The engine's own 400 is a verdict on the caller's Turtle, so it stays
        // the caller's error rather than becoming this service's.
        GateError::Refused { code: 400, .. } => Status::invalid_argument(e.to_string()),
        GateError::Refused { .. } => Status::internal(e.to_string()),
        GateError::Malformed(_) => Status::internal(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derivation_proto::{GateResult, PopulationSource};

    fn gate(name: &str, status: GateStatus, rows: i64, examined: i64) -> GateResult {
        GateResult {
            name: name.to_string(),
            status: status as i32,
            rows,
            examined,
            population_source: PopulationSource::Authored as i32,
            note: String::new(),
            first_row: String::new(),
        }
    }

    /// The authoring suite's real shape: one real pass, two blind, one failing.
    fn suite() -> GateReport {
        GateReport {
            gates: vec![
                gate("ladder_integrity", GateStatus::Passed, 0, 40),
                gate("envelope_unrecorded", GateStatus::ExaminedNothing, 0, 0),
                gate("vacuous_invariant", GateStatus::ExaminedNothing, 0, 0),
                gate("conflict_hygiene_strict", GateStatus::Failed, 3, 12),
            ],
            corpus_version: String::new(),
            failed: 1,
            examined_nothing: 2,
            clean: false,
        }
    }

    #[test]
    fn no_filter_returns_the_suite_untouched() {
        let r = select_gates(suite(), &[]).expect("whole suite");
        assert_eq!(r.gates.len(), 4);
        assert_eq!(r.failed, 1);
        assert_eq!(r.examined_nothing, 2);
        assert!(!r.clean);
    }

    /// The summary must describe what came back, not the suite it was cut from.
    #[test]
    fn filtering_recomputes_the_counts() {
        let r = select_gates(suite(), &["ladder_integrity".into()]).expect("subset");
        assert_eq!(r.gates.len(), 1);
        assert_eq!(r.failed, 0, "the failing gate was not asked for");
        assert_eq!(r.examined_nothing, 0);
        assert!(r.clean, "one real pass, nothing blind");
    }

    /// A subset of blind gates has no failures and has checked nothing. `clean`
    /// must be false, which `failed == 0` would get wrong.
    #[test]
    fn a_subset_of_blind_gates_is_not_clean() {
        let r = select_gates(
            suite(),
            &["envelope_unrecorded".into(), "vacuous_invariant".into()],
        )
        .expect("subset");
        assert_eq!(r.failed, 0);
        assert_eq!(r.examined_nothing, 2);
        assert!(
            !r.clean,
            "no failures and nothing examined is the vacuous pass, not a clean run"
        );
    }

    /// A typo must not read as a gate that passed by absence.
    #[test]
    fn an_unknown_gate_name_is_refused_not_dropped() {
        let err = select_gates(suite(), &["ladder_integrty".into()]).expect_err("refuses");
        assert_eq!(err.code(), tonic::Code::InvalidArgument);
        assert!(err.message().contains("ladder_integrty"));
        assert!(
            err.message().contains("ladder_integrity"),
            "the message should name what the suite does have"
        );
    }

    #[test]
    fn filtering_keeps_suite_order_not_request_order() {
        let r = select_gates(
            suite(),
            &["conflict_hygiene_strict".into(), "ladder_integrity".into()],
        )
        .expect("subset");
        let names: Vec<&str> = r.gates.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["ladder_integrity", "conflict_hygiene_strict"]);
    }

    #[test]
    fn not_configured_and_unreachable_are_different_codes() {
        assert_eq!(
            to_status(GateError::NotConfigured).code(),
            tonic::Code::FailedPrecondition
        );
        assert_eq!(
            to_status(GateError::Unreachable {
                addr: "http://127.0.0.1:8081".into(),
                why: "connection refused".into()
            })
            .code(),
            tonic::Code::Unavailable
        );
    }

    #[test]
    fn the_engines_own_400_stays_the_callers_error() {
        assert_eq!(
            to_status(GateError::Refused {
                code: 400,
                body: "bad turtle".into()
            })
            .code(),
            tonic::Code::InvalidArgument
        );
        assert_eq!(
            to_status(GateError::Refused {
                code: 500,
                body: "boom".into()
            })
            .code(),
            tonic::Code::Internal
        );
    }
}
