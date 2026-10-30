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
