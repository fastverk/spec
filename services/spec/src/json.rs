//! Proto → serde_json::Value helpers for SpecIndex responses.
//!
//! Single source of truth for the JSON shape the fastverk-web shell reads. Field
//! names match spec.proto exactly (snake_case) so the panels' `field_path` /
//! `rows_field` strings line up. Enums render as their SHORT name ("GREEN" /
//! "LEAN") so the table columns read cleanly (like forge's already-normalized
//! strings — no meridian ENUM_NAME formatting needed).

use crate::proto::{Citation, Contract, ModuleStatus, Spec, SpecLang, SpecStatus};
use serde_json::{json, Value};

fn status_name(v: i32) -> &'static str {
    match SpecStatus::try_from(v) {
        Ok(SpecStatus::Green) => "GREEN",
        Ok(SpecStatus::Sorry) => "SORRY",
        Ok(SpecStatus::Broken) => "BROKEN",
        Ok(SpecStatus::Unknown) => "UNKNOWN",
        _ => "UNSPECIFIED",
    }
}

fn lang_name(v: i32) -> &'static str {
    match SpecLang::try_from(v) {
        Ok(SpecLang::Lean) => "LEAN",
        Ok(SpecLang::Tla) => "TLA",
        Ok(SpecLang::Alloy) => "ALLOY",
        Ok(SpecLang::Dafny) => "DAFNY",
        Ok(SpecLang::Smt) => "SMT",
        Ok(SpecLang::Coq) => "COQ",
        _ => "UNSPECIFIED",
    }
}

pub fn spec(s: Spec) -> Value {
    json!({
        "repo": s.repo,
        "path": s.path,
        "lang": lang_name(s.lang),
        "kind": s.kind,
        "target": s.target,
        "module": s.module,
        "status": status_name(s.status),
        "sorry_count": s.sorry_count,
    })
}

pub fn contract(c: Contract) -> Value {
    json!({
        "repo": c.repo,
        "id": c.id,
        "name": c.name,
        "promise": c.promise,
        "module": c.module,
        "discharger": c.discharger,
        "cited": c.cited,
        "status": status_name(c.status),
    })
}

pub fn module_status(m: ModuleStatus) -> Value {
    json!({
        "repo": m.repo,
        "module": m.module,
        "target": m.target,
        "status": status_name(m.status),
        "sorry_count": m.sorry_count,
        "spec_count": m.spec_count,
    })
}

pub fn citation(c: Citation) -> Value {
    json!({ "path": c.path, "line": c.line })
}

pub fn list_specs_response(specs: Vec<Spec>, unreachable: Vec<String>) -> Value {
    json!({
        "specs": specs.into_iter().map(spec).collect::<Vec<_>>(),
        "unreachable_repos": unreachable,
    })
}

pub fn list_contracts_response(contracts: Vec<Contract>, unreachable: Vec<String>) -> Value {
    json!({
        "contracts": contracts.into_iter().map(contract).collect::<Vec<_>>(),
        "unreachable_repos": unreachable,
    })
}

pub fn list_module_status_response(modules: Vec<ModuleStatus>, unreachable: Vec<String>) -> Value {
    json!({
        "modules": modules.into_iter().map(module_status).collect::<Vec<_>>(),
        "unreachable_repos": unreachable,
    })
}

pub fn get_spec_response(s: Spec, source: String, sorry_lines: Vec<u32>) -> Value {
    json!({ "spec": spec(s), "source": source, "sorry_lines": sorry_lines })
}

pub fn get_contract_response(c: Contract, theorem_source: String, citations: Vec<Citation>) -> Value {
    json!({
        "contract": contract(c),
        "theorem_source": theorem_source,
        "citations": citations.into_iter().map(citation).collect::<Vec<_>>(),
    })
}
