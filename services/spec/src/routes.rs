//! routes — the plugin's web routing contract, as data.
//!
//! The `web_routes` list in `/describe` is the *entire* public routing surface of a
//! fastverk plugin: the shell's `registerRoutes` folds it into a
//! `(service, method) -> (verb, path)` table, and both a panel's
//! `populate.service/.method` and a form's `submit.service/.method` resolve through
//! it. A plugin therefore owns its own RPC→REST mapping, and adding a route never
//! edits the console.
//!
//! This lives in its own module, with no `axum` dependency, for two reasons:
//!
//!   1. **It is checkable.** `readmodel::routes_match_describe` asserts at startup
//!      that every route the router serves is declared here; `tools/readmodel/
//!      check_wiring.py` asserts the same thing statically against the emitted
//!      payloads and the panel descriptors. Both need the list, neither needs a web
//!      framework.
//!   2. **The failure it prevents is invisible otherwise.** A served-but-undeclared
//!      route renders in the browser as *"no gateway route for
//!      spec.v1.Authoring/ListEnvelopes — plugin 'spec' didn't declare it in
//!      web_routes"*, which reads as a console bug rather than a plugin one. Nothing
//!      in the type system connects a `.route("/envelopes", …)` to its declaration,
//!      so the connection is made here and asserted twice.

use serde_json::{json, Value};

use crate::AUTHORING_SERVICE;

/// The read-only spec index — `spec.v1.SpecIndex`, shipped since v1.
pub const INDEX_ROUTES: &[(&str, &str, &str)] = &[
    ("ListSpecs", "GET", "specs"),
    ("ListContracts", "GET", "contracts"),
    ("ListModuleStatus", "GET", "status"),
    ("GetSpec", "GET", "spec"),
    ("GetContract", "GET", "contract"),
];

/// The RFC-002 authoring reads, in nav order. The `path` column is also the file
/// stem under `$SPEC_READMODEL_DIR` and the `panel_id` in `ui/panels.textproto`;
/// `readmodel::ROUTES` pairs each path with its `rows_field`.
pub const AUTHORING_READS: &[(&str, &str, &str)] = &[
    ("ListConflicts", "GET", "conflicts"),
    ("ListEnvelopes", "GET", "envelopes"),
    ("ListStalls", "GET", "frontier"),
    ("ListDisciplines", "GET", "disciplines"),
    ("ListClaims", "GET", "claims"),
    ("GetConflictWitness", "GET", "witness"),
    ("ListRequirements", "GET", "requirements"),
];

/// The authoring write path. Declared unconditionally, even when
/// `$SPEC_PROPOSAL_LOG` is unset and the routes answer 503: a declared route that
/// explains why it refuses is a better failure than an undeclared one, which the
/// shell reports as a missing route and the author reads as a broken console.
pub const AUTHORING_WRITES: &[(&str, &str, &str)] = &[
    ("SubmitProposal", "POST", "proposal"),
    ("PreviewProposal", "POST", "proposal/verdict-preview"),
    // The flat, one-op form a meridian `FormPanel` can submit. This is what makes a
    // write affordance DECLARATIVE — see `proposal::from_flat`, and RFC-002a §5 for
    // why that turned out to matter more than the adhoc route.
    ("SubmitOp", "POST", "proposal/op"),
];

/// The full `web_routes` array for `/describe`.
pub fn describe_web_routes() -> Vec<Value> {
    let mut out = Vec::new();
    for (method, verb, path) in INDEX_ROUTES {
        out.push(route("spec.v1.SpecIndex", method, verb, path));
    }
    for (method, verb, path) in AUTHORING_READS.iter().chain(AUTHORING_WRITES) {
        out.push(route(AUTHORING_SERVICE, method, verb, path));
    }
    out
}

fn route(service: &str, method: &str, verb: &str, path: &str) -> Value {
    json!({ "service": service, "method": method, "http_method": verb, "path": path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_is_fully_specified_and_relative() {
        let routes = describe_web_routes();
        assert_eq!(routes.len(), INDEX_ROUTES.len() + AUTHORING_READS.len() + AUTHORING_WRITES.len());
        for r in &routes {
            for key in ["service", "method", "http_method", "path"] {
                let v = r[key].as_str().unwrap_or_default();
                assert!(!v.is_empty(), "{key} is empty in {r}");
            }
            // The shell builds `/api/gw/spec/<path>` and strips leading slashes; a
            // leading slash here would be silently tolerated there, so keep the
            // declaration in the one form that reads unambiguously.
            assert!(
                !r["path"].as_str().unwrap().starts_with('/'),
                "path must be relative: {r}"
            );
            assert!(
                matches!(r["http_method"].as_str().unwrap(), "GET" | "POST"),
                "unexpected verb in {r}"
            );
        }
    }

    #[test]
    fn no_two_routes_share_a_service_and_method() {
        let routes = describe_web_routes();
        let mut keys: Vec<String> = routes
            .iter()
            .map(|r| format!("{}/{}", r["service"].as_str().unwrap(), r["method"].as_str().unwrap()))
            .collect();
        keys.sort();
        let before = keys.len();
        keys.dedup();
        // `registerRoutes` is last-write-wins, so a duplicate would silently shadow
        // the earlier declaration rather than error.
        assert_eq!(keys.len(), before, "duplicate (service, method) in web_routes");
    }

    #[test]
    fn no_two_routes_share_a_verb_and_path() {
        let routes = describe_web_routes();
        let mut keys: Vec<String> = routes
            .iter()
            .map(|r| format!("{} {}", r["http_method"].as_str().unwrap(), r["path"].as_str().unwrap()))
            .collect();
        keys.sort();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before, "duplicate (verb, path) in web_routes");
    }
}
