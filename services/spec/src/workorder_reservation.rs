//! Native single-order reservation, before fleet admission. The gateway principal
//! authorizes this source-side dispatch; a fleet receipt alone is not permission
//! to keep writing. The worker must still check the current source observation.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn validate(body: &Value) -> Result<(), &'static str> {
    let o = body.as_object().ok_or("reservation must be an object")?;
    let fields = [
        "order_id",
        "as_of",
        "intent_sha256",
        "requester_uid",
        "idempotency_key",
    ];
    if o.len() != fields.len() || !o.keys().all(|k| fields.contains(&k.as_str())) {
        return Err("exact reservation fields required");
    }
    for field in fields {
        let s = body[field]
            .as_str()
            .ok_or("reservation fields must be strings")?;
        if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) || s.trim() != s {
            return Err("invalid reservation field");
        }
    }
    let digest = body["intent_sha256"].as_str().unwrap();
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("intent_sha256 must be a lowercase SHA-256 digest");
    }
    let key = body["idempotency_key"].as_str().unwrap();
    if key.len() > 128
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("invalid reservation replay key");
    }
    Ok(())
}

pub fn receipt(body: &Value, approver: &str) -> Value {
    let identity =
        crate::proposal::canonical_json(&json!({"request":body,"approved_by_uid":approver}));
    json!({"request":body,"approved_by_uid":approver,
        "reservation_id":format!("{:x}", Sha256::digest(identity.as_bytes()))})
}

pub fn valid_receipt(value: &Value) -> bool {
    let Some(actor) = value["approved_by_uid"].as_str() else {
        return false;
    };
    !actor.is_empty()
        && !actor.chars().any(char::is_control)
        && validate(&value["request"]).is_ok()
        && receipt(&value["request"], actor) == *value
}

/// The HTTP projection uses canonical ProtoJSON: uint64 fence epochs are strings.
/// This is an attestation by the authenticated trusted gateway, not a fleet proof
/// verifier. Only the documented canceled/FINAL-zero slice may use this door.
pub fn validate_release(body: &Value) -> Result<(), &'static str> {
    let o = body.as_object().ok_or("release must be an object")?;
    let fields = ["order_id", "reservation_id", "execution_id", "fence_epoch",
        "drain_receipt_sha256", "fence_evidence_sha256", "idempotency_key"];
    if o.len() != fields.len() || !o.keys().all(|k| fields.contains(&k.as_str())) {
        return Err("exact canceled release fields required");
    }
    for field in fields {
        let value = body[field].as_str().ok_or("release fields must be strings")?;
        if value.is_empty() || value.len() > 256 || value.trim() != value || value.chars().any(char::is_control) {
            return Err("invalid canceled release field");
        }
    }
    for field in ["reservation_id", "drain_receipt_sha256", "fence_evidence_sha256"] {
        let hash = body[field].as_str().unwrap();
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err("lowercase SHA-256 release references required");
        }
    }
    let epoch = body["fence_epoch"].as_str().unwrap();
    if !epoch.parse::<u64>().is_ok_and(|n| n > 0 && n.to_string() == epoch) {
        return Err("canonical positive cancellation fence required");
    }
    let key = body["idempotency_key"].as_str().unwrap();
    if key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
        return Err("invalid release replay key");
    }
    Ok(())
}
pub fn release_receipt(body: &Value, actor: &str) -> Value {
    let identity = crate::proposal::canonical_json(&json!({"request":body,"released_by_uid":actor}));
    json!({"request":body,"released_by_uid":actor,
        "release_id":format!("{:x}", Sha256::digest(identity.as_bytes()))})
}
pub fn valid_release_receipt(value: &Value) -> bool {
    let Some(actor) = value["released_by_uid"].as_str() else { return false };
    !actor.is_empty() && !actor.chars().any(char::is_control)
        && validate_release(&value["request"]).is_ok()
        && release_receipt(&value["request"], actor) == *value
}

/// The two terminal fleet states a completed release covers. Canceled attempts
/// keep their own door (`validate_release`), whose evidence differs.
pub const TERMINAL_SUCCEEDED: &str = "EXECUTION_STATE_SUCCEEDED";
pub const TERMINAL_FAILED: &str = "EXECUTION_STATE_FAILED";

/// `spec.v1.ReleaseCompletedWorkOrderRequest` in canonical ProtoJSON: uint64 and
/// int64 travel as decimal strings. This is still an attestation by the trusted
/// gateway; the native rule it adds is spend coverage, checked against the log
/// (`Running::spent_since_reservation`), not against anything the caller says.
pub fn validate_completed_release(body: &Value) -> Result<(), &'static str> {
    let o = body.as_object().ok_or("release must be an object")?;
    let fields = ["order_id", "reservation_id", "execution_id", "terminal_state", "fence_epoch",
        "final_consumed_tokens", "drain_receipt_sha256", "idempotency_key"];
    if o.len() != fields.len() || !o.keys().all(|k| fields.contains(&k.as_str())) {
        return Err("exact completed release fields required");
    }
    for field in fields {
        let value = body[field].as_str().ok_or("release fields must be strings")?;
        if value.is_empty() || value.len() > 256 || value.trim() != value || value.chars().any(char::is_control) {
            return Err("invalid completed release field");
        }
    }
    for field in ["reservation_id", "drain_receipt_sha256"] {
        let hash = body[field].as_str().unwrap();
        if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err("lowercase SHA-256 release references required");
        }
    }
    if !matches!(body["terminal_state"].as_str().unwrap(), TERMINAL_SUCCEEDED | TERMINAL_FAILED) {
        return Err("terminal state must be EXECUTION_STATE_SUCCEEDED or EXECUTION_STATE_FAILED");
    }
    // Unlike a cancellation fence, zero is the normal epoch of an execution
    // that was never canceled.
    let epoch = body["fence_epoch"].as_str().unwrap();
    if !epoch.parse::<u64>().is_ok_and(|n| n.to_string() == epoch) {
        return Err("canonical drain fence required");
    }
    // Zero is a legitimate FINAL (a no-provider worker); negative is not.
    let tokens = body["final_consumed_tokens"].as_str().unwrap();
    if !tokens.parse::<i64>().is_ok_and(|n| n >= 0 && n.to_string() == tokens) {
        return Err("canonical nonnegative FINAL consumed tokens required");
    }
    let key = body["idempotency_key"].as_str().unwrap();
    if key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
        return Err("invalid release replay key");
    }
    Ok(())
}

/// Canonical ProtoJSON omits zero-valued scalars, and the two numeric fields
/// here are routinely zero: an un-canceled execution's fence and a no-provider
/// FINAL. Spell them out, so a standard encoder is accepted and the stored
/// receipt (and its id) never depends on which encoder the gateway used.
pub fn normalize_completed_release(body: &Value) -> Value {
    let mut body = body.clone();
    if let Some(o) = body.as_object_mut() {
        for field in ["fence_epoch", "final_consumed_tokens"] {
            o.entry(field).or_insert_with(|| json!("0"));
        }
    }
    body
}

/// FINAL consumed tokens of a validated completed release.
pub fn final_tokens(body: &Value) -> i64 {
    body["final_consumed_tokens"].as_str().and_then(|t| t.parse().ok()).unwrap_or(i64::MAX)
}

pub fn completed_release_receipt(body: &Value, actor: &str) -> Value {
    let identity = crate::proposal::canonical_json(
        &json!({"kind":"completed","request":body,"released_by_uid":actor}));
    json!({"request":body,"released_by_uid":actor,
        "release_id":format!("{:x}", Sha256::digest(identity.as_bytes()))})
}

pub fn valid_completed_release_receipt(value: &Value) -> bool {
    let Some(actor) = value["released_by_uid"].as_str() else { return false };
    !actor.is_empty() && !actor.chars().any(char::is_control)
        && validate_completed_release(&value["request"]).is_ok()
        && completed_release_receipt(&value["request"], actor) == *value
}
