use crate::state::{AppState, PendingReconnect, Upv2LoginKey, Upv2Session, Upv2Challenge, LoginAttempt, PendingRequest, SigningHistoryEntry};
use crate::nip46::find_existing_by_name;
use nostr_sdk::prelude::*;
use nostr_sdk::nips::{nip04, nip44};
use ::hkdf::Hkdf;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{info, warn, error};

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn emit_log(app: &AppHandle, msg: &str) {
    let _ = app.emit("log-event", msg.to_string());
}

fn emit_signer_state(app: &AppHandle, state: &State<'_, AppState>) {
    let payload = state.to_signer_payload();
    if let Err(e) = app.emit("signer-state", &payload) {
        error!("Failed to emit signer state: {}", e);
    }
}

/// First 8 hex chars of a pubkey for display
fn fingerprint(pk: &str) -> String {
    if pk.len() >= 8 { pk[..8].to_string() } else { pk.to_string() }
}

/// Derive login keypair from password + npub using HKDF-SHA256
/// Matches PWANS: login_sk = HKDF(password, salt = npub || "NIP-UPV2")
fn derive_login_pk(password: &str, npub: &str) -> Result<String, String> {
    let salt = format!("{}NIP-UPV2", npub);
    let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), password.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"", &mut okm)
        .map_err(|e| format!("HKDF expand failed: {}", e))?;

    // Derive the public key from the secret key bytes
    let secret_key = SecretKey::from_slice(&okm)
        .map_err(|e| format!("Invalid derived key: {}", e))?;
    let keys = Keys::new(secret_key);
    Ok(keys.public_key().to_hex())
}

const CHALLENGE_EXPIRY_SECS: u64 = 60;
const RATE_LIMIT_SECS: u64 = 5;

// --- Tauri Commands ---

/// Set up UPV2 password: derive login_pk and save
#[tauri::command]
pub fn set_upv2_password(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    npub: String,
) -> Result<String, String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }

    let login_pk = derive_login_pk(&password, &npub)?;
    let fp = fingerprint(&login_pk);

    // Store keyed by the active keypair's pubkey hex
    let active_pubkey = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    {
        let mut keys = state.upv2_login_key.lock().unwrap();
        keys.insert(active_pubkey, Upv2LoginKey {
            login_pk: login_pk.clone(),
            fingerprint: fp.clone(),
            enabled: true,
            created_at: now_secs(),
        });
    }

    // Clear existing sessions (new password = new login key)
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        sessions.clear();
    }

    state.save_upv2_login_key()?;
    state.save_upv2_sessions()?;

    info!("[UPV2] Password set, login key: {}…", fp);
    emit_log(&app, &format!("[UPV2] ✓ Password login enabled (key: {}…)", fp));
    emit_signer_state(&app, &state);
    Ok(login_pk)
}
/// Toggle UPV2 enabled/disabled
#[tauri::command]
pub async fn toggle_upv2_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let active_pubkey = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    let new_enabled;
    {
        let mut keys = state.upv2_login_key.lock().unwrap();
        match keys.get_mut(&active_pubkey) {
            Some(k) => {
                k.enabled = !k.enabled;
                new_enabled = k.enabled;
            }
            None => return Err("No UPV2 password configured".to_string()),
        }
    }
    state.save_upv2_login_key()?;

    if !new_enabled {
        // Disabling: record last_online so we know when we stopped processing
        record_last_online(&app, &active_pubkey);
    } else {
        // Re-enabling: check for attempts that happened while disabled
        let signer_keys = crate::keys::get_active_keys(&state);
        let client = state.signer_client.lock().unwrap().clone();
        if let (Ok(keys), Some(c)) = (signer_keys, client) {
            check_offline_attempts(&app, &keys, &c).await;
            record_last_online(&app, &keys.public_key().to_hex());
        }
    }

    emit_log(&app, &format!("[UPV2] Password login {}", if new_enabled { "enabled" } else { "disabled" }));
    emit_signer_state(&app, &state);
    Ok(new_enabled)
}

/// Delete UPV2 password and invalidate all sessions
#[tauri::command]
pub fn delete_upv2_password(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let active_pubkey = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    {
        let mut keys = state.upv2_login_key.lock().unwrap();
        keys.remove(&active_pubkey);
    }
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        sessions.clear();
    }
    state.save_upv2_login_key()?;
    state.save_upv2_sessions()?;
    emit_log(&app, "[UPV2] Password login removed — all sessions invalidated");
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn list_upv2_sessions(state: State<'_, AppState>) -> Vec<Upv2Session> {
    state.upv2_sessions.lock().unwrap().clone()
}

#[tauri::command]
pub fn revoke_upv2_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        sessions.retain(|s| s.session_id != session_id);
    }
    state.save_upv2_sessions()?;
    emit_log(&app, &format!("[UPV2] Revoked session: {}…", &session_id[..8.min(session_id.len())]));
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn get_upv2_login_key(state: State<'_, AppState>) -> Option<Upv2LoginKey> {
    let active = state.active_keypair.lock().unwrap().clone()?;
    let keys = state.upv2_login_key.lock().unwrap();
    keys.get(&active).cloned()
}

#[tauri::command]
pub fn dismiss_login_attempt(
    app: AppHandle,
    state: State<'_, AppState>,
    attempt_id: String,
) -> Result<(), String> {
    {
        let mut attempts = state.login_attempts.lock().unwrap();
        if let Some(a) = attempts.iter_mut().find(|a| a.id == attempt_id) {
            a.dismissed = true;
        }
    }
    let _ = state.save_login_attempts();
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn dismiss_all_offline_attempts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut attempts = state.login_attempts.lock().unwrap();
        for a in attempts.iter_mut() {
            if a.status == "offline_missed" {
                a.dismissed = true;
            }
        }
    }
    let _ = state.save_login_attempts();
    emit_signer_state(&app, &state);
    Ok(())
}

/// Set the approval policy for a UPV2 session
#[tauri::command]
pub fn set_upv2_session_policy(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    policy: String,
) -> Result<(), String> {
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.session_id == session_id) {
            match policy.as_str() {
                "auto_approve" | "auto_reject" | "custom" | "manual" => {
                    session.policy = policy.clone();
                }
                _ => return Err("Invalid policy".to_string()),
            }
        } else {
            return Err("Session not found".to_string());
        }
    }
    state.save_upv2_sessions()?;
    emit_log(&app, &format!("[UPV2] Set session policy to '{}'", policy));
    emit_signer_state(&app, &state);
    Ok(())
}

/// Set a custom rule for a specific method on a UPV2 session
#[tauri::command]
pub fn set_upv2_custom_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    method: String,
    action: String,
) -> Result<(), String> {
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.session_id == session_id) {
            session.custom_rules.insert(method.clone(), action.clone());
        } else {
            return Err("Session not found".to_string());
        }
    }
    state.save_upv2_sessions()?;
    emit_log(&app, &format!("[UPV2] Set custom rule: {} → {}", method, action));
    emit_signer_state(&app, &state);
    Ok(())
}

/// Remove a custom rule for a specific method on a UPV2 session
#[tauri::command]
pub fn remove_upv2_custom_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    method: String,
) -> Result<(), String> {
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.session_id == session_id) {
            session.custom_rules.remove(&method);
        } else {
            return Err("Session not found".to_string());
        }
    }
    state.save_upv2_sessions()?;
    emit_log(&app, &format!("[UPV2] Removed custom rule for: {}", method));
    emit_signer_state(&app, &state);
    Ok(())
}

// --- Event Handler ---

/// Handle an incoming kind 24134 (NIP-UPV2) event
pub async fn handle_upv2_event(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    event: &Event,
) {
    let sender_pubkey = event.pubkey;
    let sender_hex = sender_pubkey.to_hex();
    let state: tauri::State<'_, AppState> = app.state();

    info!("[UPV2] ⚡ Received kind 24134 event from {}", fingerprint(&sender_hex));
    emit_log(app, &format!("[UPV2] Received event from {}…", fingerprint(&sender_hex)));

    // Check if UPV2 is enabled for the signer's keypair and the sender matches
    // NOTE: Use signer_keys (not active_keypair) because the signer loop is bound
    // to a specific keypair, even if the user switches accounts in the UI.
    let signer_pk_hex = signer_keys.public_key().to_hex();
    let (is_enabled, login_pk_match, stored_pk) = {
        let keys = state.upv2_login_key.lock().unwrap();
        match keys.get(&signer_pk_hex) {
            Some(k) => (k.enabled, k.login_pk == sender_hex, Some(k.login_pk.clone())),
            None => (false, false, None),
        }
    };

    if !is_enabled {
        warn!("[UPV2] UPV2 not enabled, ignoring event");
        emit_log(app, "[UPV2] ⚠️ Event ignored — UPV2 not enabled");
        return;
    }

    // Signer-side staleness check: drop events older than 15 seconds
    let event_age = now_secs().saturating_sub(event.created_at.as_u64());
    emit_log(app, &format!("[UPV2] Event age: {}s (created_at={}, now={})", event_age, event.created_at.as_u64(), now_secs()));
    if event_age > 15 {
        warn!("[UPV2] Ignoring stale event ({}s old)", event_age);
        emit_log(app, &format!("[UPV2] ⚠️ DROPPED: event too old ({}s > 15s limit)", event_age));
        return;
    }

    if !login_pk_match {
        // Show both keys for debugging
        let stored_fp = stored_pk.as_deref().map(fingerprint).unwrap_or_else(|| "none".to_string());
        warn!("[UPV2] Key mismatch! sender={} stored={}", fingerprint(&sender_hex), stored_fp);
        emit_log(app, &format!("[UPV2] ⚠️ Key mismatch: sender={}… stored={}…", fingerprint(&sender_hex), stored_fp));
        return;
    }

    // Try NIP-44 decrypt first, then NIP-04 fallback — track which one worked
    let (decrypted, use_nip44): (String, bool) = match nip44::decrypt(signer_keys.secret_key(), &sender_pubkey, &event.content) {
        Ok(text) => (text, true),
        Err(_) => {
            match nip04::decrypt(signer_keys.secret_key(), &sender_pubkey, &event.content) {
                Ok(text) => (text, false),
                Err(e) => {
                    warn!("[UPV2] Failed to decrypt kind 24134 event (NIP-44 + NIP-04): {}", e);
                    return;
                }
            }
        }
    };
    let enc_label = if use_nip44 { "NIP-44" } else { "NIP-04" };

    // Extract action and session_id from tags
    let action = event.tags.iter()
        .find(|tag| tag.as_slice().first().map(|s| s.as_str()) == Some("a"))
        .and_then(|tag| tag.as_slice().get(1).map(|s| s.to_string()));

    let session_id = event.tags.iter()
        .find(|tag| tag.as_slice().first().map(|s| s.as_str()) == Some("s"))
        .and_then(|tag| tag.as_slice().get(1).map(|s| s.to_string()));

    let action = match action {
        Some(a) => a,
        None => { warn!("[UPV2] Missing action tag"); return; }
    };

    let session_id = match session_id {
        Some(s) => s,
        None => { warn!("[UPV2] Missing session tag"); return; }
    };

    let fp = fingerprint(&sender_hex);
    info!("[UPV2] action='{}' from {} session={}… ({})", action, fp, &session_id[..8.min(session_id.len())], enc_label);
    emit_log(app, &format!("[UPV2] → action='{}' session={}… ({})", action, &session_id[..8.min(session_id.len())], enc_label));

    match action.as_str() {
        "request_challenge" => {
            handle_request_challenge(app, signer_keys, client, &sender_pubkey, &sender_hex, &session_id, &decrypted, use_nip44).await;
        }
        "login" => {
            handle_login(app, signer_keys, client, &sender_pubkey, &sender_hex, &session_id, &decrypted, &event.id.to_hex(), use_nip44).await;
        }
        "sign_event" => {
            handle_sign_event(app, signer_keys, client, &sender_pubkey, &sender_hex, &session_id, &decrypted, use_nip44).await;
        }
        "nip04_encrypt" | "nip04_decrypt" | "nip44_encrypt" | "nip44_decrypt" => {
            handle_encrypt_decrypt(app, signer_keys, client, &sender_pubkey, &sender_hex, &session_id, &decrypted, &action, use_nip44).await;
        }
        _ => { warn!("[UPV2] Unknown action: {}", action); }
    }

    emit_signer_state(app, &state);
}

// --- Action Handlers ---

async fn handle_request_challenge(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    sender_pubkey: &PublicKey,
    sender_hex: &str,
    session_id: &str,
    _decrypted: &str,
    use_nip44: bool,
) {
    let state: tauri::State<'_, AppState> = app.state();
    let fp = fingerprint(sender_hex);

    // Rate limit
    let rate_limited = {
        let challenges = state.upv2_challenges.lock().unwrap();
        challenges.iter().any(|c| {
            c.login_pk == sender_hex && (now_secs() - (c.expires_at.saturating_sub(CHALLENGE_EXPIRY_SECS))) < RATE_LIMIT_SECS
        })
    };

    if rate_limited {
        warn!("[UPV2] Rate limited challenge from {}", fp);
        emit_log(app, &format!("[UPV2] ⚠️ DROPPED: rate limited ({})", fp));
        return;
    }

    // Issue challenge automatically (the login_pk already matches our stored key)
    issue_challenge(app, signer_keys, client, sender_pubkey, session_id, sender_hex, use_nip44).await;
}

async fn issue_challenge(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    recipient: &PublicKey,
    session_id: &str,
    login_pk: &str,
    use_nip44: bool,
) {
    let state: tauri::State<'_, AppState> = app.state();

    let nonce = hex::encode(rand::random::<[u8; 32]>());
    let expires_at = now_secs() + CHALLENGE_EXPIRY_SECS;

    {
        let mut challenges = state.upv2_challenges.lock().unwrap();
        let now = now_secs();
        challenges.retain(|c| c.expires_at > now);
        challenges.push(Upv2Challenge {
            nonce: nonce.clone(),
            session_id: session_id.to_string(),
            login_pk: login_pk.to_string(),
            expires_at,
        });
    }

    let challenge_payload = serde_json::json!({
        "challenge": nonce,
        "expires_at": expires_at,
    });

    emit_log(app, &format!("[UPV2] Sending challenge response to {}… session={}…", fingerprint(login_pk), &session_id[..8.min(session_id.len())]));
    send_upv2_response(signer_keys, client, recipient, session_id, "challenge", &challenge_payload.to_string(), None, use_nip44).await;
    emit_log(app, "[UPV2] ✅ Challenge response sent to relays");

    let fp = fingerprint(login_pk);
    info!("[UPV2] Challenge issued to {} ({}s expiry)", fp, CHALLENGE_EXPIRY_SECS);
    emit_log(app, &format!("[UPV2] Challenge issued to {}… ({}s)", fp, CHALLENGE_EXPIRY_SECS));
}

async fn handle_login(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    sender_pubkey: &PublicKey,
    sender_hex: &str,
    session_id: &str,
    decrypted: &str,
    event_id: &str,
    use_nip44: bool,
) {
    let state: tauri::State<'_, AppState> = app.state();
    let fp = fingerprint(sender_hex);

    let payload: serde_json::Value = match serde_json::from_str(decrypted) {
        Ok(v) => v,
        Err(e) => { warn!("[UPV2] Invalid login payload: {}", e); return; }
    };

    let challenge_sig = payload.get("challenge_signature")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let client_name = payload.get("client")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();

    let instance_id = payload.get("instance_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Validate challenge
    let valid_challenge = {
        let mut challenges = state.upv2_challenges.lock().unwrap();
        let now = now_secs();
        if let Some(idx) = challenges.iter().position(|c| {
            c.login_pk == sender_hex && c.expires_at > now
        }) {
            if !challenge_sig.is_empty() {
                Some(challenges.remove(idx))
            } else {
                None
            }
        } else {
            None
        }
    };

    if valid_challenge.is_none() {
        // Record as a suspicious login attempt
        let attempt = LoginAttempt {
            id: format!("suspect-{}-{}", fp, now_secs()),
            event_id: event_id.to_string(),
            login_pk: sender_hex.to_string(),
            timestamp: now_secs(),
            client_name: Some(client_name.clone()),
            instance_id: Some(instance_id.clone()),
            status: "offline_missed".to_string(),
            dismissed: false,
        };
        {
            let mut attempts = state.login_attempts.lock().unwrap();
            attempts.push(attempt);
            // Keep last 200
            if attempts.len() > 200 { let start = attempts.len() - 200; *attempts = attempts.split_off(start); }
        }
        let _ = state.save_login_attempts();
        warn!("[UPV2] Login without valid challenge from {}", fp);
        emit_log(app, &format!("[UPV2] ⚠️ Suspicious login from {}… — no valid challenge", fp));
        return;
    }

    // Create or refresh session
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(existing) = sessions.iter_mut().find(|s| {
            s.login_pk == sender_hex && s.instance_id == instance_id
        }) {
            // Same exact session — just refresh
            existing.last_active = now_secs();
            info!("[UPV2] Session refreshed for '{}' ({})", client_name, fp);
        } else {
            drop(sessions); // Release lock before cross-protocol check

            let new_session = Upv2Session {
                session_id: session_id.to_string(),
                login_pk: sender_hex.to_string(),
                client_name: client_name.clone(),
                instance_id: instance_id.clone(),
                created_at: now_secs(),
                last_active: now_secs(),
                policy: "manual".to_string(),
                custom_rules: std::collections::HashMap::new(),
                signer_pubkey: signer_keys.public_key().to_hex(),
            };

            // Check for existing connection/session with same name (cross-protocol)
            let existing = find_existing_by_name(&state, &client_name, &signer_keys.public_key().to_hex());

            // Always save the new session so the client handshake works
            {
                let mut sessions = state.upv2_sessions.lock().unwrap();
                sessions.push(new_session);
            }
            info!("[UPV2] New session for '{}' ({})", client_name, fp);

            if let Some((existing_id, existing_source, _policy, _rules)) = existing {
                // Prompt user: do you want to remove the OLD connection?
                let pending = PendingReconnect {
                    new_connection_id: None,
                    new_session_id: Some(session_id.to_string()),
                    existing_id,
                    existing_source: existing_source.clone(),
                    app_name: client_name.clone(),
                };
                *state.pending_reconnect.lock().unwrap() = Some(pending.clone());
                let _ = app.emit("reconnect-prompt", &pending);
                emit_log(app, &format!("[UPV2] '{}' is reconnecting (existing {} connection found) — awaiting user decision", client_name, existing_source));
            }
        }
    }
    let _ = state.save_upv2_sessions();

    let confirm_payload = serde_json::json!({
        "status": "ok",
        "session_id": session_id,
        "expires_at": (now_secs() + 86400) * 1000, // 24h from now, in milliseconds for JS Date
    });

    send_upv2_response(signer_keys, client, sender_pubkey, session_id, "session_created", &confirm_payload.to_string(), None, use_nip44).await;

    // Record successful login attempt
    {
        let attempt = LoginAttempt {
            id: format!("login-{}-{}", fp, now_secs()),
            event_id: event_id.to_string(),
            login_pk: sender_hex.to_string(),
            timestamp: now_secs(),
            client_name: Some(client_name.clone()),
            instance_id: Some(instance_id.clone()),
            status: "processed".to_string(),
            dismissed: false,
        };
        let mut attempts = state.login_attempts.lock().unwrap();
        attempts.push(attempt);
        if attempts.len() > 200 { let start = attempts.len() - 200; *attempts = attempts.split_off(start); }
    }
    let _ = state.save_login_attempts();

    emit_log(app, &format!("[UPV2] ✓ Login confirmed for '{}' ({}…)", client_name, fp));
}

async fn handle_sign_event(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    sender_pubkey: &PublicKey,
    sender_hex: &str,
    session_id: &str,
    decrypted: &str,
    use_nip44: bool,
) {
    let state: tauri::State<'_, AppState> = app.state();
    let fp = fingerprint(sender_hex);

    // Get session info + policy
    let session_info = {
        let sessions = state.upv2_sessions.lock().unwrap();
        sessions.iter().find(|s| s.login_pk == sender_hex).map(|s| {
            (s.client_name.clone(), s.policy.clone(), s.custom_rules.clone())
        })
    };

    let (client_name, session_policy, custom_rules) = match session_info {
        Some(info) => info,
        None => {
            warn!("[UPV2] Sign request without session from {}", fp);
            emit_log(app, &format!("[UPV2] ⚠️ Sign without session from {}…", fp));
            let err = serde_json::json!({ "error": "No active session" });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), None, use_nip44).await;
            return;
        }
    };

    let payload: serde_json::Value = match serde_json::from_str(decrypted) {
        Ok(v) => v,
        Err(e) => { warn!("[UPV2] Invalid sign_event payload: {}", e); return; }
    };

    // Extract the client-provided nonce for request-response matching
    let request_nonce = payload.get("nonce").and_then(|n| n.as_str()).map(|s| s.to_string());

    // Extract event JSON and kind
    let event_json = match payload.get("event") {
        Some(ev) => ev.to_string(),
        None => { warn!("[UPV2] Missing event in sign_event payload"); return; }
    };

    let event_kind: Option<u32> = payload.get("event")
        .and_then(|v| v.get("kind"))
        .and_then(|k| k.as_u64())
        .map(|k| k as u32);

    // Check policy (same logic as NIP-46)
    let custom_rule = if session_policy == "custom" {
        if let Some(kind) = event_kind {
            let kind_key = format!("sign_event:{}", kind);
            custom_rules.get(&kind_key).cloned()
                .or_else(|| custom_rules.get("sign_event").cloned())
        } else {
            custom_rules.get("sign_event").cloned()
        }
    } else {
        None
    };

    let should_auto_approve = session_policy == "auto_approve"
        || custom_rule.as_deref() == Some("approve");
    let should_auto_reject = session_policy == "auto_reject"
        || custom_rule.as_deref() == Some("reject");

    if should_auto_reject {
        let err = serde_json::json!({ "error": "Request auto-rejected by signer policy" });
        send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
        info!("[UPV2] Auto-rejected sign_event from '{}' ({})", client_name, fp);
        emit_log(app, &format!("[UPV2] ✗ Auto-rejected sign from '{}' ({}…)", client_name, fp));

        // Record in signing history
        state.record_signing_history(SigningHistoryEntry {
            id: format!("upv2-reject-{}-{}", session_id, now_secs()),
            timestamp: now_secs(),
            method: "sign_event".to_string(),
            kind: event_kind,
            app_name: client_name.clone(),
            source: "upv2".to_string(),
            outcome: "auto_rejected".to_string(),
            raw_event_json: Some(event_json.clone()),
        });

        return;
    }

    // Pre-compute the signed event (needed for both auto-approve and pending)
    let signed_json = match sign_event_from_json(signer_keys, &event_json) {
        Ok(s) => s,
        Err(e) => {
            error!("[UPV2] Sign failed: {}", e);
            let err = serde_json::json!({ "error": format!("Signing failed: {}", e) });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
            return;
        }
    };

    // Update session last_active
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.login_pk == sender_hex) {
            session.last_active = now_secs();
        }
    }
    let _ = state.save_upv2_sessions();

    if should_auto_approve {
        // Auto-approve: sign and respond immediately
        let response = serde_json::json!({
            "event": serde_json::from_str::<serde_json::Value>(&signed_json).unwrap_or_default(),
        });
        send_upv2_response(signer_keys, client, sender_pubkey, session_id, "signed_event", &response.to_string(), request_nonce.as_deref(), use_nip44).await;
        info!("[UPV2] ✓ Auto-approved sign_event for '{}' ({})", client_name, fp);
        emit_log(app, &format!("[UPV2] ✓ Auto-signed for '{}' ({}…)", client_name, fp));

        // Record in signing history
        state.record_signing_history(SigningHistoryEntry {
            id: format!("upv2-approve-{}-{}", session_id, now_secs()),
            timestamp: now_secs(),
            method: "sign_event".to_string(),
            kind: event_kind,
            app_name: client_name.clone(),
            source: "upv2".to_string(),
            outcome: "auto_approved".to_string(),
            raw_event_json: Some(event_json.clone()),
        });
    } else {
        // Manual approval: queue as PendingRequest
        let kind_label = event_kind.map(|k| format!("kind {}", k)).unwrap_or_else(|| "unknown kind".to_string());
        let params_preview = format!("[UPV2] sign_event ({})", kind_label);

        let response_json = serde_json::json!({
            "event": serde_json::from_str::<serde_json::Value>(&signed_json).unwrap_or_default(),
        }).to_string();

        let pending = PendingRequest {
            id: format!("upv2-{}-{}", session_id, now_secs()),
            connection_id: session_id.to_string(),
            app_name: client_name.clone(),
            method: "sign_event".to_string(),
            params_preview,
            raw_event_json: Some(event_json.clone()),
            event_id: String::new(),
            client_pubkey: sender_hex.to_string(),
            created_at: now_secs(),
            kind: event_kind,
            response_json: Some(response_json),
            use_nip44,
            source: "upv2".to_string(),
            upv2_session_id: Some(session_id.to_string()),
            upv2_nonce: request_nonce.clone(),
        };

        {
            let mut pending_requests = state.pending_requests.lock().unwrap();
            pending_requests.push(pending);
        }

        info!("[UPV2] Pending approval: sign_event from '{}' ({})", client_name, fp);
        emit_log(app, &format!("[UPV2] ⏳ Pending sign from '{}' ({}…) — awaiting approval", client_name, fp));
    }

    // Always emit state update so UI refreshes with pending requests
    emit_signer_state(app, &state);
}

async fn handle_encrypt_decrypt(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    sender_pubkey: &PublicKey,
    sender_hex: &str,
    session_id: &str,
    decrypted: &str,
    method: &str,
    use_nip44: bool,
) {
    let state: tauri::State<'_, AppState> = app.state();
    let fp = fingerprint(sender_hex);

    // Get session info + policy
    let session_info = {
        let sessions = state.upv2_sessions.lock().unwrap();
        sessions.iter().find(|s| s.login_pk == sender_hex).map(|s| {
            (s.client_name.clone(), s.policy.clone(), s.custom_rules.clone())
        })
    };

    let (client_name, session_policy, custom_rules) = match session_info {
        Some(info) => info,
        None => {
            warn!("[UPV2] {} request without session from {}", method, fp);
            emit_log(app, &format!("[UPV2] ⚠️ {} without session from {}…", method, fp));
            let err = serde_json::json!({ "error": "No active session" });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), None, use_nip44).await;
            return;
        }
    };

    let payload: serde_json::Value = match serde_json::from_str(decrypted) {
        Ok(v) => v,
        Err(e) => { warn!("[UPV2] Invalid {} payload: {}", method, e); return; }
    };

    let request_nonce = payload.get("nonce").and_then(|n| n.as_str()).map(|s| s.to_string());

    let pubkey_hex = match payload.get("pubkey").and_then(|v| v.as_str()) {
        Some(pk) => pk,
        None => {
            let err = serde_json::json!({ "error": "Missing 'pubkey' parameter" });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
            return;
        }
    };

    let target_pk = match PublicKey::from_hex(pubkey_hex) {
        Ok(pk) => pk,
        Err(e) => {
            let err = serde_json::json!({ "error": format!("Invalid pubkey: {}", e) });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
            return;
        }
    };

    // Check policy
    let custom_rule = if session_policy == "custom" {
        custom_rules.get(method).cloned()
    } else {
        None
    };

    let _should_auto_approve = session_policy == "auto_approve"
        || custom_rule.as_deref() == Some("approve");
    let should_auto_reject = session_policy == "auto_reject"
        || custom_rule.as_deref() == Some("reject");

    if should_auto_reject {
        let err = serde_json::json!({ "error": "Request auto-rejected by signer policy" });
        send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
        info!("[UPV2] Auto-rejected {} from '{}' ({})", method, client_name, fp);
        emit_log(app, &format!("[UPV2] ✗ Auto-rejected {} from '{}' ({}…)", method, client_name, fp));
        return;
    }

    // For encrypt/decrypt, auto-approve if policy allows (same as NIP-46 behavior)
    // If manual policy, also auto-approve since encrypt/decrypt are lower-risk than signing
    let is_encrypt = method.ends_with("_encrypt");
    let content_key = if is_encrypt { "plaintext" } else { "ciphertext" };
    let content = match payload.get(content_key).and_then(|v| v.as_str()) {
        Some(c) => c,
        None => {
            let err = serde_json::json!({ "error": format!("Missing '{}' parameter", content_key) });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
            return;
        }
    };

    let result = match method {
        "nip04_encrypt" => nip04::encrypt(signer_keys.secret_key(), &target_pk, content)
            .map_err(|e| format!("NIP-04 encrypt failed: {}", e)),
        "nip04_decrypt" => nip04::decrypt(signer_keys.secret_key(), &target_pk, content)
            .map_err(|e| format!("NIP-04 decrypt failed: {}", e)),
        "nip44_encrypt" => nip44::encrypt(signer_keys.secret_key(), &target_pk, content, nip44::Version::default())
            .map_err(|e| format!("NIP-44 encrypt failed: {}", e)),
        "nip44_decrypt" => nip44::decrypt(signer_keys.secret_key(), &target_pk, content)
            .map_err(|e| format!("NIP-44 decrypt failed: {}", e)),
        _ => Err(format!("Unknown method: {}", method)),
    };

    match result {
        Ok(output) => {
            let response = serde_json::json!({ "result": output });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, method, &response.to_string(), request_nonce.as_deref(), use_nip44).await;
            info!("[UPV2] ✓ {} for '{}' ({})", method, client_name, fp);
            emit_log(app, &format!("[UPV2] ✓ {} for '{}' ({}…)", method, client_name, fp));
        }
        Err(e) => {
            let err = serde_json::json!({ "error": e });
            send_upv2_response(signer_keys, client, sender_pubkey, session_id, "error", &err.to_string(), request_nonce.as_deref(), use_nip44).await;
            warn!("[UPV2] {} failed for '{}': {}", method, client_name, e);
            emit_log(app, &format!("[UPV2] ✗ {} failed for '{}': {}", method, client_name, e));
        }
    }

    // Update session last_active
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.login_pk == sender_hex) {
            session.last_active = now_secs();
        }
    }
    let _ = state.save_upv2_sessions();
}

// --- Helpers ---

async fn send_upv2_response(
    signer_keys: &Keys,
    client: &Client,
    recipient: &PublicKey,
    session_id: &str,
    action: &str,
    payload: &str,
    nonce: Option<&str>,
    use_nip44: bool,
) {
    let encrypted = if use_nip44 {
        match nip44::encrypt(
            signer_keys.secret_key(), recipient, payload, nip44::Version::default(),
        ) {
            Ok(e) => e,
            Err(err) => { error!("[UPV2] NIP-44 encrypt failed: {}", err); return; }
        }
    } else {
        match nip04::encrypt(signer_keys.secret_key(), recipient, payload) {
            Ok(e) => e,
            Err(err) => { error!("[UPV2] NIP-04 encrypt failed: {}", err); return; }
        }
    };

    let mut event_builder = EventBuilder::new(Kind::Custom(24134), encrypted)
        .tag(Tag::public_key(*recipient))
        .tag(Tag::custom(TagKind::from("a"), vec![action.to_string()]))
        .tag(Tag::custom(TagKind::from("s"), vec![session_id.to_string()]));

    // Include client nonce so responses can be matched to requests
    if let Some(n) = nonce {
        event_builder = event_builder.tag(Tag::custom(TagKind::from("n"), vec![n.to_string()]));
    }

    match client.send_event_builder(event_builder).await {
        Ok(output) => {
            info!("[UPV2] Published {} response, event_id={}", action, output.id().to_hex());
        }
        Err(e) => {
            error!("[UPV2] Failed to publish response: {}", e);
        }
    }
}

fn sign_event_from_json(signer_keys: &Keys, event_json: &str) -> Result<String, String> {
    let unsigned: serde_json::Value = serde_json::from_str(event_json)
        .map_err(|e| format!("Invalid event JSON: {}", e))?;

    let kind = unsigned.get("kind")
        .and_then(|v| v.as_u64())
        .ok_or("Missing kind")?;

    let content = unsigned.get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let tags: Vec<Tag> = if let Some(tags_arr) = unsigned.get("tags").and_then(|v| v.as_array()) {
        tags_arr.iter().filter_map(|t| {
            let items: Vec<String> = t.as_array()?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if items.is_empty() { return None; }
            Some(Tag::custom(
                TagKind::from(items[0].as_str()),
                items[1..].to_vec(),
            ))
        }).collect()
    } else {
        vec![]
    };

    let builder = EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags);

    let event = builder.sign_with_keys(signer_keys)
        .map_err(|e| format!("Signing failed: {}", e))?;

    serde_json::to_string(&event)
        .map_err(|e| format!("Serialize signed event failed: {}", e))
}

// --- Offline Attempt Detection ---

/// Check for login attempts that happened while the signer was offline.
/// Called once when the signer loop starts, after connecting to relays.
pub async fn check_offline_attempts(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
) {
    let state: tauri::State<'_, AppState> = app.state();

    // Get the login_pk for the signer's keypair (not active_keypair, which may differ)
    let signer_pk_hex = signer_keys.public_key().to_hex();
    let (login_pk_hex, key_created_at) = {
        let keys = match state.upv2_login_key.lock() {
            Ok(k) => k,
            Err(_) => { error!("[UPV2] upv2_login_key mutex poisoned"); return; }
        };
        match keys.get(&signer_pk_hex) {
            Some(k) if k.enabled => (k.login_pk.clone(), k.created_at),
            _ => {
                info!("[UPV2] Skipping offline check — UPV2 not enabled");
                return;
            }
        }
    };

    // Use last_online_at, or fall back to key creation time (first boot)
    let last_online = {
        let map = match state.last_online_at.lock() {
            Ok(v) => v,
            Err(_) => { error!("[UPV2] last_online_at mutex poisoned"); return; }
        };
        let stored = map.get(&signer_pk_hex).copied().unwrap_or(0);
        if stored == 0 { key_created_at } else { stored }
    };

    let now = now_secs();
    info!("[UPV2] Checking for offline attempts since {} ({}s ago)", last_online, now.saturating_sub(last_online));
    emit_log(app, &format!("[UPV2] Checking for login attempts while offline…"));

    // Build a filter for kind 24134 events from the login_pk, since last_online
    let login_pk = match PublicKey::from_hex(&login_pk_hex) {
        Ok(pk) => pk,
        Err(e) => {
            error!("[UPV2] Invalid login_pk hex: {}", e);
            return;
        }
    };

    let filter = Filter::new()
        .kind(Kind::Custom(24134))
        .author(login_pk)
        .pubkey(signer_keys.public_key())
        .since(Timestamp::from(last_online))
        .until(Timestamp::from(now));

    let events: Vec<Event> = match client.fetch_events(filter, std::time::Duration::from_secs(10)).await {
        Ok(evs) => evs.into_iter().collect(),
        Err(e) => {
            error!("[UPV2] Failed to fetch offline events: {}", e);
            return;
        }
    };

    let mut offline_count = 0u32;
    for event in &events {
        // Skip if already recorded
        let event_id_hex = event.id.to_hex();
        {
            let attempts = match state.login_attempts.lock() {
                Ok(a) => a,
                Err(_) => { error!("[UPV2] login_attempts mutex poisoned"); return; }
            };
            if attempts.iter().any(|a| a.event_id == event_id_hex) {
                continue;
            }
        }

        // Only look at request_challenge actions (login attempts)
        let action = event.tags.iter()
            .find(|tag| tag.as_slice().first().map(|s| s.as_str()) == Some("a"))
            .and_then(|tag| tag.as_slice().get(1).map(|s| s.to_string()));

        if action.as_deref() != Some("request_challenge") {
            continue;
        }

        // Try to decrypt for client info (NIP-44 first, then NIP-04 fallback)
        let mut client_name: Option<String> = None;
        let mut instance_id: Option<String> = None;
        let decrypted_content = nip44::decrypt(signer_keys.secret_key(), &event.pubkey, &event.content)
            .or_else(|_| nip04::decrypt(signer_keys.secret_key(), &event.pubkey, &event.content));
        if let Ok(decrypted) = decrypted_content {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&decrypted) {
                client_name = payload.get("client").and_then(|v| v.as_str()).map(String::from);
                instance_id = payload.get("instance_id").and_then(|v| v.as_str()).map(String::from);
            }
        }

        let attempt = LoginAttempt {
            id: format!("offline-{}", event_id_hex),
            event_id: event_id_hex,
            login_pk: event.pubkey.to_hex(),
            timestamp: event.created_at.as_u64(),
            client_name,
            instance_id,
            status: "offline_missed".to_string(),
            dismissed: false,
        };

        {
            let mut attempts = match state.login_attempts.lock() {
                Ok(a) => a,
                Err(_) => { error!("[UPV2] login_attempts mutex poisoned"); return; }
            };
            attempts.push(attempt);
        }
        offline_count += 1;
    }

    if offline_count > 0 {
        // Save and notify
        let _ = state.save_login_attempts();
        warn!("[UPV2] ⚠️ Detected {} offline login attempt(s)!", offline_count);
        emit_log(app, &format!("[UPV2] ⚠️ {} login attempt(s) detected while offline!", offline_count));
        emit_signer_state(app, &state);
    } else {
        info!("[UPV2] No offline login attempts found");
    }
}

/// Record the current timestamp as the last time the signer was online for a specific keypair
pub fn record_last_online(app: &AppHandle, pubkey: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    let now = now_secs();
    state.last_online_at.lock().unwrap().insert(pubkey.to_string(), now);
    let _ = state.save_last_online_at();
}
