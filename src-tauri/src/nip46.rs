use crate::keys;
use crate::state::{AppState, Connection, PendingReconnect, PendingRequest, RelayInfo, SigningHistoryEntry};
use crate::upv2;
use nostr_sdk::prelude::*;
use nostr_sdk::nips::{nip04, nip44};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{info, warn, error};

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn emit_signer_state(app: &AppHandle, state: &State<'_, AppState>) {
    let payload = state.to_signer_payload();
    if let Err(e) = app.emit("signer-state", &payload) {
        error!("Failed to emit signer state: {}", e);
    }
}

fn emit_log(app: &AppHandle, msg: &str) {
    let _ = app.emit("log-event", msg);
}

// --- NIP-46 JSON-RPC Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Nip46Request {
    pub(crate) id: String,
    pub(crate) method: String,
    pub(crate) params: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Nip46Response {
    pub(crate) id: String,
    pub(crate) result: Option<String>,
    pub(crate) error: Option<String>,
}

// --- Tauri Commands ---

#[tauri::command]
pub fn get_signer_state(state: State<'_, AppState>) -> crate::state::SignerStatePayload {
    state.to_signer_payload()
}

#[tauri::command]
pub async fn start_signer(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let running = state.signer_running.lock().unwrap();
        if *running {
            return Err("Signer is already running".to_string());
        }
    }

    let signer_keys = keys::get_active_keys(&state)?;
    let signer_pubkey = signer_keys.public_key();
    let signer_pk_hex = signer_pubkey.to_hex();

    // Merge signer-local relays with the active user's NIP-65 relay list
    let relay_urls: Vec<String> = {
        let local = state.relay_urls.lock().unwrap();
        let user = state.user_relay_urls.lock().unwrap();
        let user_list = user.get(&signer_pk_hex).cloned().unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        let mut merged = Vec::new();
        for url in local.iter().chain(user_list.iter()) {
            let norm = url.trim_end_matches('/').to_string();
            if seen.insert(norm) {
                merged.push(url.clone());
            }
        }
        merged
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut handle = state.signer_shutdown.lock().unwrap();
        *handle = Some(shutdown_tx);
    }

    {
        let mut running = state.signer_running.lock().unwrap();
        *running = true;
    }

    let signer_npub = signer_pubkey.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;
    info!("NIP-46 signer starting: {}", &signer_npub[..24]);
    emit_log(&app, &format!("[INFO] NIP-46 signer started: {}...{}",
        &signer_npub[..16], &signer_npub[signer_npub.len()-8..]));
    emit_signer_state(&app, &state);

    let app_handle = app.clone();
    tokio::spawn(async move {
        if let Err(e) = run_signer_loop(
            app_handle,
            signer_keys,
            relay_urls,
            shutdown_rx,
        ).await {
            error!("Signer loop error: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_signer(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut handle = state.signer_shutdown.lock().unwrap();
        if let Some(tx) = handle.take() {
            let _ = tx.send(());
        }
    }

    {
        let mut running = state.signer_running.lock().unwrap();
        *running = false;
    }

    // Record last_online before stopping so offline check works next time
    if let Some(pk) = state.active_keypair.lock().unwrap().clone() {
        upv2::record_last_online(&app, &pk);
    }

    info!("NIP-46 signer stopped");
    emit_log(&app, "[INFO] NIP-46 signer stopped");
    emit_signer_state(&app, &state);

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunkerUriResult {
    pub uri: String,
    pub secret: String,
}

#[tauri::command]
pub fn get_bunker_uri(
    state: State<'_, AppState>,
) -> Result<BunkerUriResult, String> {
    let signer_keys = keys::get_active_keys(&state)?;
    let pubkey = signer_keys.public_key();
    let relay_urls: Vec<String> = state.relay_urls.lock().unwrap().clone();

    // Generate a random secret
    let secret_keys = Keys::generate();
    let secret = hex::encode(&secret_keys.secret_key().to_secret_bytes()[..8]);

    let pubkey_hex = pubkey.to_hex();
    let relays_param = relay_urls.iter()
        .map(|r| format!("relay={}", r))
        .collect::<Vec<_>>()
        .join("&");

    let uri = format!("bunker://{}?{}&secret={}", pubkey_hex, relays_param, secret);

    Ok(BunkerUriResult { uri, secret })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrConnectInfo {
    pub client_pubkey: String,
    pub relay_urls: Vec<String>,
    pub app_name: Option<String>,
    pub app_url: Option<String>,
    pub secret: Option<String>,
}

#[tauri::command]
pub fn parse_nostrconnect_uri(uri: String) -> Result<NostrConnectInfo, String> {
    if !uri.starts_with("nostrconnect://") {
        return Err("Invalid URI: must start with nostrconnect://".to_string());
    }

    let without_scheme = &uri["nostrconnect://".len()..];
    let (pubkey_part, query_part) = without_scheme.split_once('?')
        .unwrap_or((without_scheme, ""));

    let client_pubkey = pubkey_part.to_string();
    let mut relay_urls = Vec::new();
    let mut app_name = None;
    let mut app_url = None;
    let mut secret = None;

    for param in query_part.split('&') {
        if param.is_empty() { continue; }
        if let Some(value) = param.strip_prefix("relay=") {
            relay_urls.push(urlencoding_decode(value));
        } else if let Some(value) = param.strip_prefix("metadata=") {
            let decoded = urlencoding_decode(value);
            if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&decoded) {
                app_name = meta.get("name").and_then(|v| v.as_str()).map(String::from);
                app_url = meta.get("url").and_then(|v| v.as_str()).map(String::from);
            }
        } else if let Some(value) = param.strip_prefix("secret=") {
            secret = Some(value.to_string());
        } else if let Some(value) = param.strip_prefix("name=") {
            app_name = Some(urlencoding_decode(value));
        }
    }

    Ok(NostrConnectInfo { client_pubkey, relay_urls, app_name, app_url, secret })
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

#[tauri::command]
pub async fn connect_nostrconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    info: NostrConnectInfo,
) -> Result<String, String> {
    let signer_keys = keys::get_active_keys(&state)?;

    // NIP-46 spec: secret is required for nostrconnect to prevent spoofing
    let secret = info.secret.clone()
        .ok_or("nostrconnect:// URI missing required 'secret' parameter")?;

    let conn_id = uuid::Uuid::new_v4().to_string();
    let app_name = info.app_name.clone().unwrap_or("Unknown App".to_string());
    let connection = Connection {
        id: conn_id.clone(),
        app_name: app_name.clone(),
        app_url: info.app_url.clone(),
        app_icon: None,
        client_pubkey: info.client_pubkey.clone(),
        relay_urls: info.relay_urls.clone(),
        created_at: now_secs(),
        auto_approve: false,
        auto_reject: false,
        auto_approve_kinds: vec![],
        policy: "manual".to_string(),
        custom_rules: HashMap::new(),
        signer_pubkey: signer_keys.public_key().to_hex(),
    };

    // Check for existing connection/session with same name (cross-protocol)
    let existing = find_existing_by_name(&state, &app_name, &signer_keys.public_key().to_hex());

    // Always save the new connection so the handshake works
    {
        let mut connections = state.connections.lock().unwrap();
        connections.push(connection);
    }
    state.save_connections()?;

    if let Some((existing_id, existing_source, _policy, _rules)) = existing {
        // Prompt user: do you want to remove the OLD connection?
        let pending = PendingReconnect {
            new_connection_id: Some(conn_id.clone()),
            new_session_id: None,
            existing_id,
            existing_source: existing_source.clone(),
            app_name: app_name.clone(),
        };
        *state.pending_reconnect.lock().unwrap() = Some(pending.clone());
        let _ = app.emit("reconnect-prompt", &pending);
        emit_log(&app, &format!("[INFO] '{}' is reconnecting (existing {} connection found) — awaiting user decision", app_name, existing_source));
    }

    let client_pk = PublicKey::from_hex(&info.client_pubkey)
        .map_err(|e| format!("Invalid client pubkey: {}", e))?;

    // NIP-46 spec: signer sends a connect *response* event
    // The `result` MUST be the secret from the URI (client validates this)
    // Client discovers signer pubkey from the event's author field
    let response_id = uuid::Uuid::new_v4().to_string();
    let response = Nip46Response {
        id: response_id,
        result: Some(secret),
        error: None,
    };

    let response_json = serde_json::to_string(&response)
        .map_err(|e| format!("Serialize error: {}", e))?;

    // Encrypt with NIP-44 (modern clients expect NIP-44)
    let encrypted = nip44::encrypt(signer_keys.secret_key(), &client_pk, &response_json, nip44::Version::default())
        .map_err(|e| format!("NIP-44 encrypt error: {}", e))?;

    // Build kind 24133 response event tagged with client's pubkey
    let event = EventBuilder::new(Kind::Custom(24133), encrypted)
        .tag(Tag::public_key(client_pk));

    // Connect to the client's specified relays and publish
    let client = Client::new(signer_keys.clone());
    for relay_url in &info.relay_urls {
        let _ = client.add_relay(relay_url).await;
    }
    client.connect().await;

    // Small delay to ensure relay connection is stable
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    match client.send_event_builder(event).await {
        Ok(output) => {
            info!("Sent nostrconnect response to {}: {:?}", &info.client_pubkey[..16], output);
            emit_log(&app, &format!("[INFO] Connected to app '{}' via nostrconnect",
                info.app_name.as_deref().unwrap_or("Unknown")));
        }
        Err(e) => {
            warn!("Failed to send nostrconnect response: {}", e);
            emit_log(&app, &format!("[WARN] Failed to send nostrconnect response: {}", e));
        }
    }

    client.disconnect().await;
    emit_signer_state(&app, &state);

    Ok(conn_id)
}

#[tauri::command]
pub async fn approve_request(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let signer_keys = keys::get_active_keys(&state)?;
    let request = {
        let mut pending = state.pending_requests.lock().unwrap();
        let idx = pending.iter().position(|r| r.id == request_id)
            .ok_or("Request not found")?;
        pending.remove(idx)
    };

    info!("Approved request: {} ({}) [{}]", request.method, &request.id[..request.id.len().min(8)], request.source);
    emit_log(&app, &format!("[INFO] Approved: {} from '{}'", request.method, request.app_name));

    if let Some(response_json) = &request.response_json {
        if request.source == "pc55" {
            // PC55: send response directly through the oneshot channel (no encryption, no relay)
            let sender = {
                let mut channels = state.pc55_response_channels.lock().unwrap();
                channels.remove(&request.id)
            };
            if let Some(tx) = sender {
                let _ = tx.send(response_json.clone());
                info!("Sent PC55 approved response for: {}", request.method);
            } else {
                warn!("No PC55 response channel for request: {}", request.id);
            }
        } else {
            let client_pk = PublicKey::from_hex(&request.client_pubkey)
                .map_err(|e| format!("Invalid pubkey: {}", e))?;

            // Use the signer's existing client if available, otherwise create a fallback
            let shared_client = state.signer_client.lock().unwrap().clone();
            let (client, is_temp) = if let Some(c) = shared_client {
                (c, false)
            } else {
                warn!("No signer client available, creating temporary client");
                let relay_urls: Vec<String> = state.relay_urls.lock().unwrap().clone();
                let c = Client::new(signer_keys.clone());
                for url in &relay_urls {
                    let _ = c.add_relay(url).await;
                }
                c.connect().await;
                (c, true)
            };

            if request.source == "upv2" {
                // UPV2: send kind 24134, NIP-44, with action + session tags
                let encrypted = nip44::encrypt(
                    signer_keys.secret_key(), &client_pk, response_json, nip44::Version::default(),
                ).map_err(|e| format!("NIP-44 encrypt: {}", e))?;

                let session_id = request.upv2_session_id.as_deref().unwrap_or("unknown");
                let mut response_event = EventBuilder::new(Kind::Custom(24134), encrypted)
                    .tag(Tag::public_key(client_pk))
                    .tag(Tag::custom(TagKind::from("a"), vec!["signed_event".to_string()]))
                    .tag(Tag::custom(TagKind::from("s"), vec![session_id.to_string()]));

                // Include client nonce for request-response matching
                if let Some(ref n) = request.upv2_nonce {
                    response_event = response_event.tag(Tag::custom(TagKind::from("n"), vec![n.clone()]));
                }

                match client.send_event_builder(response_event).await {
                    Ok(_) => info!("Sent UPV2 approved response for: {}", request.method),
                    Err(e) => error!("Failed to send UPV2 approved response: {}", e),
                }
            } else {
                // NIP-46: send kind 24133, NIP-04 or NIP-44
                let encrypted = if request.use_nip44 {
                    nip44::encrypt(signer_keys.secret_key(), &client_pk, response_json, nip44::Version::default())
                        .map_err(|e| format!("NIP-44 encrypt: {}", e))?
                } else {
                    nip04::encrypt(signer_keys.secret_key(), &client_pk, response_json)
                        .map_err(|e| format!("NIP-04 encrypt: {}", e))?
                };

                let response_event = EventBuilder::new(Kind::Custom(24133), encrypted)
                    .tag(Tag::public_key(client_pk));

                match client.send_event_builder(response_event).await {
                    Ok(_) => info!("Sent approved response for: {}", request.method),
                    Err(e) => error!("Failed to send approved response: {}", e),
                }
            }

            if is_temp {
                client.disconnect().await;
            }
        }
    }

    emit_signer_state(&app, &state);

    // Record in signing history
    state.record_signing_history(SigningHistoryEntry {
        id: request.id.clone(),
        timestamp: now_secs(),
        method: request.method.clone(),
        kind: request.kind,
        app_name: request.app_name.clone(),
        source: request.source.clone(),
        outcome: "approved".to_string(),
        raw_event_json: request.raw_event_json.clone(),
    });

    Ok(())
}

#[tauri::command]
pub async fn reject_request(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let signer_keys = keys::get_active_keys(&state)?;
    let request = {
        let mut pending = state.pending_requests.lock().unwrap();
        let idx = pending.iter().position(|r| r.id == request_id)
            .ok_or("Request not found")?;
        pending.remove(idx)
    };

    info!("Rejected request: {} ({}) [{}]", request.method, &request.id[..request.id.len().min(8)], request.source);
    emit_log(&app, &format!("[WARN] Rejected: {} from '{}'", request.method, request.app_name));

    if request.source == "pc55" {
        // PC55: send rejection directly through the oneshot channel
        let rejection = Nip46Response {
            id: request.id.clone(),
            result: None,
            error: Some("User rejected the request".to_string()),
        };
        let rejection_json = serde_json::to_string(&rejection)
            .map_err(|e| format!("Serialize: {}", e))?;
        let sender = {
            let mut channels = state.pc55_response_channels.lock().unwrap();
            channels.remove(&request.id)
        };
        if let Some(tx) = sender {
            let _ = tx.send(rejection_json);
            info!("Sent PC55 rejection for: {}", request.method);
        } else {
            warn!("No PC55 response channel for rejection: {}", request.id);
        }
    } else {
        let client_pk = PublicKey::from_hex(&request.client_pubkey)
            .map_err(|e| format!("Invalid pubkey: {}", e))?;

        // Use the signer's existing client if available, otherwise create a fallback
        let shared_client = state.signer_client.lock().unwrap().clone();
        let (client, is_temp) = if let Some(c) = shared_client {
            (c, false)
        } else {
            warn!("No signer client available, creating temporary client");
            let relay_urls: Vec<String> = state.relay_urls.lock().unwrap().clone();
            let c = Client::new(signer_keys.clone());
            for url in &relay_urls {
                let _ = c.add_relay(url).await;
            }
            c.connect().await;
            (c, true)
        };

        if request.source == "upv2" {
            // UPV2: send error via kind 24134
            let error_payload = serde_json::json!({ "error": "User rejected the request" }).to_string();
            let encrypted = nip44::encrypt(
                signer_keys.secret_key(), &client_pk, &error_payload, nip44::Version::default(),
            ).map_err(|e| format!("NIP-44 encrypt: {}", e))?;

            let session_id = request.upv2_session_id.as_deref().unwrap_or("unknown");
            let mut response_event = EventBuilder::new(Kind::Custom(24134), encrypted)
                .tag(Tag::public_key(client_pk))
                .tag(Tag::custom(TagKind::from("a"), vec!["error".to_string()]))
                .tag(Tag::custom(TagKind::from("s"), vec![session_id.to_string()]));

            // Include client nonce for request-response matching
            if let Some(ref n) = request.upv2_nonce {
                response_event = response_event.tag(Tag::custom(TagKind::from("n"), vec![n.clone()]));
            }

            match client.send_event_builder(response_event).await {
                Ok(_) => info!("Sent UPV2 rejection for: {}", request.method),
                Err(e) => error!("Failed to send UPV2 rejection: {}", e),
            }
        } else {
            // NIP-46: send rejection via kind 24133
            let rejection = Nip46Response {
                id: request.id.clone(),
                result: None,
                error: Some("User rejected the request".to_string()),
            };
            let rejection_json = serde_json::to_string(&rejection)
                .map_err(|e| format!("Serialize: {}", e))?;

            let encrypted = if request.use_nip44 {
                nip44::encrypt(signer_keys.secret_key(), &client_pk, &rejection_json, nip44::Version::default())
                    .map_err(|e| format!("NIP-44 encrypt: {}", e))?
            } else {
                nip04::encrypt(signer_keys.secret_key(), &client_pk, &rejection_json)
                    .map_err(|e| format!("NIP-04 encrypt: {}", e))?
            };

            let response_event = EventBuilder::new(Kind::Custom(24133), encrypted)
                .tag(Tag::public_key(client_pk));

            match client.send_event_builder(response_event).await {
                Ok(_) => info!("Sent rejection for: {}", request.method),
                Err(e) => error!("Failed to send rejection: {}", e),
            }
        }

        if is_temp {
            client.disconnect().await;
        }
    }

    emit_signer_state(&app, &state);

    // Record in signing history
    state.record_signing_history(SigningHistoryEntry {
        id: request.id.clone(),
        timestamp: now_secs(),
        method: request.method.clone(),
        kind: request.kind,
        app_name: request.app_name.clone(),
        source: request.source.clone(),
        outcome: "rejected".to_string(),
        raw_event_json: request.raw_event_json.clone(),
    });

    Ok(())
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> Vec<Connection> {
    state.connections.lock().unwrap().clone()
}

#[tauri::command]
pub fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        connections.retain(|c| c.id != connection_id);
    }
    state.save_connections()?;
    emit_log(&app, "[INFO] Removed app connection");
    emit_signer_state(&app, &state);
    Ok(())
}

/// Set the approval policy for a connection: "manual", "custom", "auto_approve", or "auto_reject"
#[tauri::command]
pub fn set_connection_policy(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    policy: String,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == connection_id) {
            match policy.as_str() {
                "auto_approve" => {
                    conn.auto_approve = true;
                    conn.auto_reject = false;
                    conn.policy = "auto_approve".to_string();
                }
                "auto_reject" => {
                    conn.auto_approve = false;
                    conn.auto_reject = true;
                    conn.policy = "auto_reject".to_string();
                }
                "custom" => {
                    conn.auto_approve = false;
                    conn.auto_reject = false;
                    conn.policy = "custom".to_string();
                }
                _ => {
                    conn.auto_approve = false;
                    conn.auto_reject = false;
                    conn.policy = "manual".to_string();
                }
            }
        } else {
            return Err("Connection not found".to_string());
        }
    }
    state.save_connections()?;
    emit_log(&app, &format!("[INFO] Set policy to '{}' for connection", policy));
    emit_signer_state(&app, &state);
    Ok(())
}

/// Set a custom rule for a specific method on a connection
#[tauri::command]
pub fn set_custom_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    method: String,
    action: String,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == connection_id) {
            conn.custom_rules.insert(method.clone(), action.clone());
        } else {
            return Err("Connection not found".to_string());
        }
    }
    state.save_connections()?;
    emit_log(&app, &format!("[INFO] Set custom rule: {} → {}", method, action));
    emit_signer_state(&app, &state);
    Ok(())
}

/// Remove a custom rule for a specific method
#[tauri::command]
pub fn remove_custom_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    method: String,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == connection_id) {
            conn.custom_rules.remove(&method);
        } else {
            return Err("Connection not found".to_string());
        }
    }
    state.save_connections()?;
    emit_log(&app, &format!("[INFO] Removed custom rule for: {}", method));
    emit_signer_state(&app, &state);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionRules {
    pub auto_approve: bool,
    pub auto_approve_kinds: Vec<u16>,
}

#[tauri::command]
pub fn update_connection_rules(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    rules: ConnectionRules,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == connection_id) {
            conn.auto_approve = rules.auto_approve;
            conn.auto_approve_kinds = rules.auto_approve_kinds;
        } else {
            return Err("Connection not found".to_string());
        }
    }
    state.save_connections()?;
    emit_log(&app, "[INFO] Updated connection rules");
    emit_signer_state(&app, &state);
    Ok(())
}

/// Check both NIP-46 connections and UPV2 sessions for a matching name.
/// Returns (id, source, policy, custom_rules) of the match, if any.
/// Only matches entries belonging to the given signer keypair.
pub fn find_existing_by_name(
    state: &AppState,
    name: &str,
    signer_pubkey: &str,
) -> Option<(String, String, String, HashMap<String, String>)> {
    // Check NIP-46 and PC55 connections (both stored in the connections list)
    {
        let connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter().find(|c| c.app_name.to_lowercase() == name.to_lowercase() && c.signer_pubkey == signer_pubkey) {
            let source = if conn.client_pubkey.starts_with("pc55:") { "pc55" } else { "nip46" };
            return Some((conn.id.clone(), source.to_string(), conn.policy.clone(), conn.custom_rules.clone()));
        }
    }
    // Check UPV2 sessions
    {
        let sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter().find(|s| s.client_name.to_lowercase() == name.to_lowercase() && s.signer_pubkey == signer_pubkey) {
            return Some((session.session_id.clone(), "upv2".to_string(), session.policy.clone(), session.custom_rules.clone()));
        }
    }
    None
}

/// Resolve a pending reconnection: replace, keep_both, or cancel
#[tauri::command]
pub fn resolve_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    keep_rules: bool,
) -> Result<(), String> {
    let pending = {
        let mut pr = state.pending_reconnect.lock().unwrap();
        pr.take()
    };
    let pending = pending.ok_or("No pending reconnection")?;

    match action.as_str() {
        "replace" => {
            // Get existing policy/rules before removal
            // NIP-46 and PC55 connections both live in the `connections` store
            let is_connection = pending.existing_source == "nip46" || pending.existing_source == "pc55";
            let (old_policy, old_rules) = if is_connection {
                let connections = state.connections.lock().unwrap();
                connections.iter()
                    .find(|c| c.id == pending.existing_id)
                    .map(|c| (c.policy.clone(), c.custom_rules.clone()))
                    .unwrap_or(("manual".to_string(), HashMap::new()))
            } else {
                let sessions = state.upv2_sessions.lock().unwrap();
                sessions.iter()
                    .find(|s| s.session_id == pending.existing_id)
                    .map(|s| (s.policy.clone(), s.custom_rules.clone()))
                    .unwrap_or(("manual".to_string(), HashMap::new()))
            };

            // Remove old connection
            if is_connection {
                let mut connections = state.connections.lock().unwrap();
                connections.retain(|c| c.id != pending.existing_id);
            } else {
                let mut sessions = state.upv2_sessions.lock().unwrap();
                sessions.retain(|s| s.session_id != pending.existing_id);
            }

            // Transfer rules to the new (already saved) connection/session
            if keep_rules {
                if let Some(ref new_conn_id) = pending.new_connection_id {
                    let mut connections = state.connections.lock().unwrap();
                    if let Some(conn) = connections.iter_mut().find(|c| c.id == *new_conn_id) {
                        conn.policy = old_policy.clone();
                        conn.custom_rules = old_rules.clone();
                    }
                }
                if let Some(ref new_sess_id) = pending.new_session_id {
                    let mut sessions = state.upv2_sessions.lock().unwrap();
                    if let Some(session) = sessions.iter_mut().find(|s| s.session_id == *new_sess_id) {
                        session.policy = old_policy;
                        session.custom_rules = old_rules;
                    }
                }
            }

            // Save both stores
            let _ = state.save_connections();
            let _ = state.save_upv2_sessions();

            emit_log(&app, &format!("[INFO] Replaced connection for '{}' (keep_rules={})", pending.app_name, keep_rules));
        }
        "reject" => {
            // Remove the NEW connection/session, keep the old one
            if let Some(ref new_conn_id) = pending.new_connection_id {
                let mut connections = state.connections.lock().unwrap();
                connections.retain(|c| c.id != *new_conn_id);
            }
            if let Some(ref new_sess_id) = pending.new_session_id {
                let mut sessions = state.upv2_sessions.lock().unwrap();
                sessions.retain(|s| s.session_id != *new_sess_id);
            }

            let _ = state.save_connections();
            let _ = state.save_upv2_sessions();

            emit_log(&app, &format!("[INFO] Rejected new connection for '{}' — keeping existing", pending.app_name));
        }
        "keep" => {
            // Both connections remain — user explicitly wants both
            emit_log(&app, &format!("[INFO] Keeping both connections for '{}'", pending.app_name));
        }
        _ => return Err("Invalid action — use 'reject', 'keep', or 'replace'".to_string()),
    }

    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn add_relay(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    {
        let mut relays = state.relay_urls.lock().unwrap();
        let normalized = url.trim_end_matches('/').to_string();
        if relays.iter().any(|r| r.trim_end_matches('/') == normalized) {
            return Err("Relay already added".to_string());
        }
        relays.push(url.clone());
    }
    state.save_relays()?;
    info!("Added relay: {}", url);
    emit_log(&app, &format!("[INFO] Added relay: {}", url));
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn remove_relay(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    {
        let mut relays = state.relay_urls.lock().unwrap();
        let normalized = url.trim_end_matches('/');
        relays.retain(|r| r.trim_end_matches('/') != normalized);
    }
    state.save_relays()?;
    emit_log(&app, &format!("[INFO] Removed relay: {}", url));
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn list_relays(state: State<'_, AppState>) -> Vec<RelayInfo> {
    let connected = state.connected_relays.lock().unwrap();
    state.relay_urls.lock().unwrap().iter().map(|url| {
        RelayInfo { url: url.clone(), connected: connected.contains(url) }
    }).collect()
}

// --- User Relay (NIP-65) Commands ---

#[tauri::command]
pub fn add_user_relay(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let active = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    let normalized = url.trim_end_matches('/').to_string();
    {
        let mut ur = state.user_relay_urls.lock().unwrap();
        let list = ur.entry(active).or_default();
        if list.iter().any(|r| r.trim_end_matches('/') == normalized) {
            return Err("Relay already in user list".to_string());
        }
        list.push(url.clone());
    }
    state.save_user_relays()?;
    emit_log(&app, &format!("[INFO] Added user relay: {}", url));
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn remove_user_relay(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let active = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    let normalized = url.trim_end_matches('/');
    {
        let mut ur = state.user_relay_urls.lock().unwrap();
        if let Some(list) = ur.get_mut(&active) {
            list.retain(|r| r.trim_end_matches('/') != normalized);
        }
    }
    state.save_user_relays()?;
    emit_log(&app, &format!("[INFO] Removed user relay: {}", url));
    emit_signer_state(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn fetch_user_relays(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let active = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    let pubkey = PublicKey::from_hex(&active)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;

    // Use signer client if available, otherwise create a temporary one
    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    let filter = Filter::new()
        .kind(Kind::Custom(10002))
        .author(pubkey)
        .limit(1);

    let events: Vec<Event> = match client.fetch_events(filter, std::time::Duration::from_secs(5)).await {
        Ok(evs) => evs.into_iter().collect(),
        Err(e) => return Err(format!("Failed to fetch relay list: {}", e)),
    };

    let mut relay_urls: Vec<String> = Vec::new();
    if let Some(event) = events.first() {
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.len() >= 2 && parts[0] == "r" {
                relay_urls.push(parts[1].to_string());
            }
        }
    }

    // Store fetched relays
    if !relay_urls.is_empty() {
        let mut ur = state.user_relay_urls.lock().unwrap();
        ur.insert(active, relay_urls.clone());
        drop(ur);
        state.save_user_relays()?;
        emit_signer_state(&app, &state);
    }

    Ok(relay_urls)
}

#[tauri::command]
pub async fn publish_user_relays(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let active = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;

    let relay_urls: Vec<String> = {
        let ur = state.user_relay_urls.lock().unwrap();
        ur.get(&active).cloned().unwrap_or_default()
    };

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // Build kind 10002 replaceable event with "r" tags
    let mut tags: Vec<Tag> = Vec::new();
    for url in &relay_urls {
        tags.push(Tag::custom(TagKind::from("r"), vec![url.clone()]));
    }

    let event_builder = EventBuilder::new(Kind::Custom(10002), "")
        .tags(tags);

    match client.send_event_builder(event_builder).await {
        Ok(output) => {
            info!("[NIP-65] Published relay list (kind 10002), id={}", output.id().to_hex());
            emit_log(&app, &format!("[INFO] Published relay list ({} relays)", relay_urls.len()));
        }
        Err(e) => {
            error!("[NIP-65] Failed to publish relay list: {}", e);
            return Err(format!("Failed to publish: {}", e));
        }
    }

    Ok(())
}

// --- Signer Loop ---

pub async fn run_signer_loop(
    app: AppHandle,
    signer_keys: Keys,
    relay_urls: Vec<String>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let signer_pubkey = signer_keys.public_key();

    let client = Client::new(signer_keys.clone());
    for relay_url in &relay_urls {
        client.add_relay(relay_url).await
            .map_err(|e| format!("Failed to add relay {}: {}", relay_url, e))?;
    }
    client.connect().await;

    // Store client in AppState so approve/reject can reuse it
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut sc = state.signer_client.lock().unwrap();
        *sc = Some(client.clone());
    }

    let _ = app.emit("log-event", "[INFO] Connected to relays, subscribing...");

    // Mark relays as connected
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut connected = state.connected_relays.lock().unwrap();
        for url in &relay_urls {
            connected.insert(url.clone());
        }
    }

    // Emit updated signer state so frontend sees relay connection status
    {
        let state: tauri::State<'_, AppState> = app.state();
        let _ = app.emit("signer-state", state.to_signer_payload());
    }

    // Auto-fetch user's NIP-65 relay list on startup
    {
        let pk_hex = signer_pubkey.to_hex();
        let filter = Filter::new()
            .kind(Kind::Custom(10002))
            .author(signer_pubkey)
            .limit(1);

        match client.fetch_events(filter, std::time::Duration::from_secs(5)).await {
            Ok(events) => {
                let mut fetched_urls: Vec<String> = Vec::new();
                if let Some(event) = events.into_iter().next() {
                    for tag in event.tags.iter() {
                        let parts = tag.as_slice();
                        if parts.len() >= 2 && parts[0] == "r" {
                            fetched_urls.push(parts[1].to_string());
                        }
                    }
                }
                if !fetched_urls.is_empty() {
                    info!("[NIP-65] Auto-fetched {} user relay(s)", fetched_urls.len());
                    let _ = app.emit("log-event",
                        format!("[INFO] Fetched {} user relay(s) from NIP-65", fetched_urls.len()));

                    // Also connect to any user relays not already connected
                    let existing_set: std::collections::HashSet<String> = relay_urls.iter()
                        .map(|u| u.trim_end_matches('/').to_string()).collect();
                    for url in &fetched_urls {
                        let norm = url.trim_end_matches('/').to_string();
                        if !existing_set.contains(&norm) {
                            if let Err(e) = client.add_relay(url).await {
                                warn!("[NIP-65] Failed to add user relay {}: {}", url, e);
                            }
                        }
                    }
                    client.connect().await;

                    // Mark new relays as connected & store
                    let state: tauri::State<'_, AppState> = app.state();
                    {
                        let mut connected = state.connected_relays.lock().unwrap();
                        for url in &fetched_urls {
                            connected.insert(url.clone());
                        }
                    }
                    {
                        let mut ur = state.user_relay_urls.lock().unwrap();
                        ur.insert(pk_hex, fetched_urls);
                    }
                    let _ = state.save_user_relays();
                    let _ = app.emit("signer-state", state.to_signer_payload());
                }
            }
            Err(e) => {
                warn!("[NIP-65] Failed to auto-fetch user relays: {}", e);
            }
        }
    }

    // Check for login attempts that happened while we were offline
    upv2::check_offline_attempts(&app, &signer_keys, &client).await;

    // Record that we're now online
    upv2::record_last_online(&app, &signer_keys.public_key().to_hex());

    // Subscribe to kind 24133 (NIP-46) and kind 24134 (NIP-UPV2) events tagged with our pubkey
    let filter = Filter::new()
        .kinds([Kind::Custom(24133), Kind::Custom(24134)])
        .pubkey(signer_pubkey)
        .since(Timestamp::now());

    client.subscribe(filter, None).await
        .map_err(|e| format!("Subscribe failed: {}", e))?;

    let _ = app.emit("log-event", "[INFO] NIP-46 signer listening for requests...");

    let mut notifications = client.notifications();

    // Event loop
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                info!("Signer shutdown signal received");
                break;
            }
            notification = notifications.recv() => {
                match notification {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        info!("Received event kind={} from={}", event.kind.as_u16(), &event.pubkey.to_hex()[..16]);
                        let _ = app.emit("log-event", format!("[EVENT] kind={} from={}…", event.kind.as_u16(), &event.pubkey.to_hex()[..16]));
                        if event.kind == Kind::Custom(24133) {
                            handle_nip46_event(
                                &app,
                                &signer_keys,
                                &client,
                                &event,
                            ).await;
                        } else if event.kind == Kind::Custom(24134) {
                            upv2::handle_upv2_event(
                                &app,
                                &signer_keys,
                                &client,
                                &event,
                            ).await;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        error!("Notification error: {}", e);
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    // Clear signer client and connected relay status from AppState
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut sc = state.signer_client.lock().unwrap();
        *sc = None;
        state.connected_relays.lock().unwrap().clear();
    }

    client.disconnect().await;
    info!("Signer loop ended");
    Ok(())
}

async fn handle_nip46_event(
    app: &AppHandle,
    signer_keys: &Keys,
    client: &Client,
    event: &Event,
) {
    let sender_pubkey = event.pubkey;
    let content = event.content.clone();

    // Get AppState from AppHandle
    let state: tauri::State<'_, AppState> = app.state();

    // Check if NIP-46 is enabled — if not, silently drop the request
    if !*state.nip46_enabled.lock().unwrap() {
        return;
    }

    // Signer-side staleness check: drop events older than 15 seconds
    let event_age = now_secs().saturating_sub(event.created_at.as_u64());
    if event_age > 15 {
        warn!("Ignoring stale NIP-46 event ({}s old)", event_age);
        return;
    }

    // Try NIP-04 decrypt first, then NIP-44 — track which one worked
    let (decrypted, use_nip44): (String, bool) = match nip04::decrypt(signer_keys.secret_key(), &sender_pubkey, &content) {
        Ok(text) => (text, false),
        Err(_) => {
            match nip44::decrypt(signer_keys.secret_key(), &sender_pubkey, &content) {
                Ok(text) => (text, true),
                Err(e) => {
                    warn!("Failed to decrypt NIP-46 event: {}", e);
                    return;
                }
            }
        }
    };

    // Parse JSON-RPC request
    let request: Nip46Request = match serde_json::from_str(&decrypted) {
        Ok(r) => r,
        Err(e) => {
            warn!("Invalid NIP-46 request JSON: {}", e);
            return;
        }
    };

    let enc_label = if use_nip44 { "NIP-44" } else { "NIP-04" };
    info!("NIP-46 request: {} from {} ({})", request.method, &sender_pubkey.to_hex()[..16], enc_label);
    let _ = app.emit("log-event", format!("[INFO] NIP-46 request: {} from {}... ({})",
        request.method, &sender_pubkey.to_hex()[..16], enc_label));

    // Check if this client has an established connection
    let sender_hex = sender_pubkey.to_hex();
    let existing_conn = {
        let connections = state.connections.lock().unwrap();
        connections.iter().find(|c| c.client_pubkey == sender_hex)
            .map(|c| (c.id.clone(), c.app_name.clone()))
    };

    let (conn_id, app_name) = if let Some((id, name)) = existing_conn {
        (id, name)
    } else if request.method == "connect" {
        // Only `connect` requests can establish new connections
        let new_id = uuid::Uuid::new_v4().to_string();
        let name = format!("App {}...", &sender_hex[..12]);
        let connection = Connection {
            id: new_id.clone(),
            app_name: name.clone(),
            app_url: None,
            app_icon: None,
            client_pubkey: sender_hex.clone(),
            relay_urls: state.relay_urls.lock().unwrap().clone(),
            created_at: now_secs(),
            auto_approve: false,
            auto_reject: false,
            auto_approve_kinds: vec![],
            policy: "manual".to_string(),
            custom_rules: HashMap::new(),
            signer_pubkey: signer_keys.public_key().to_hex(),
        };
        {
            let mut connections = state.connections.lock().unwrap();
            connections.push(connection);
        }
        let _ = state.save_connections();
        (new_id, name)
    } else {
        // No connection and not a connect request — silently ignore
        warn!("Ignoring {} from unknown client {}", request.method, &sender_hex[..16]);
        return;
    };

    // Process the request
    let response = process_nip46_request(signer_keys, &request);
    let response_json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(e) => {
            error!("Failed to serialize response: {}", e);
            return;
        }
    };

    // Determine if this should auto-respond or require approval
    // Safe metadata queries always auto-respond
    let is_safe_method = matches!(request.method.as_str(),
        "ping" | "get_public_key" | "get_relays"
    );

    // Extract kind for sign_event requests
    let event_kind: Option<u32> = if request.method == "sign_event" && !request.params.is_empty() {
        serde_json::from_str::<serde_json::Value>(&request.params[0])
            .ok()
            .and_then(|v| v.get("kind").and_then(|k| k.as_u64()).map(|k| k as u32))
    } else {
        None
    };

    // Check connection-level policy
    let (conn_policy, custom_rule) = {
        let connections = state.connections.lock().unwrap();
        connections.iter().find(|c| c.id == conn_id)
            .map(|c| {
                let policy = c.policy.clone();
                let rule = if c.policy == "custom" {
                    // For sign_event, check kind-specific rule first, then generic
                    if request.method == "sign_event" {
                        if let Some(kind) = event_kind {
                            let kind_key = format!("sign_event:{}", kind);
                            c.custom_rules.get(&kind_key).cloned()
                                .or_else(|| c.custom_rules.get(&request.method).cloned())
                        } else {
                            c.custom_rules.get(&request.method).cloned()
                        }
                    } else {
                        c.custom_rules.get(&request.method).cloned()
                    }
                } else {
                    None
                };
                (policy, rule)
            })
            .unwrap_or(("manual".to_string(), None))
    };

    if is_safe_method || conn_policy == "auto_approve" || custom_rule.as_deref() == Some("approve") {
        // Auto-respond: safe method OR connection has auto-approve enabled
        send_encrypted_response(signer_keys, client, &sender_pubkey, &response_json, use_nip44).await;
        let id_preview = if request.id.len() > 8 { &request.id[..8] } else { &request.id };
        let reason = if is_safe_method { "safe method" } else { "auto-approved" };
        info!("Auto-responded to: {} ({}) via {} [{}]", request.method, id_preview, enc_label, reason);
        let _ = app.emit("log-event", format!("[INFO] {} — {} ({})",
            reason, request.method, id_preview));

        // Record in signing history
        let raw_json = if request.method == "sign_event" && !request.params.is_empty() {
            Some(request.params[0].clone())
        } else { None };
        state.record_signing_history(SigningHistoryEntry {
            id: request.id.clone(),
            timestamp: now_secs(),
            method: request.method.clone(),
            kind: event_kind,
            app_name: app_name.clone(),
            source: "nip46".to_string(),
            outcome: "auto_approved".to_string(),
            raw_event_json: raw_json,
        });
    } else if conn_policy == "auto_reject" || custom_rule.as_deref() == Some("reject") {
        // Auto-reject: send rejection response
        let rejection = Nip46Response {
            id: request.id.clone(),
            result: None,
            error: Some("Request auto-rejected by signer policy".to_string()),
        };
        if let Ok(rej_json) = serde_json::to_string(&rejection) {
            send_encrypted_response(signer_keys, client, &sender_pubkey, &rej_json, use_nip44).await;
        }
        info!("Auto-rejected: {} from '{}' [policy]", request.method, app_name);
        let _ = app.emit("log-event", format!("[REJECT] auto-rejected {} from '{}'",
            request.method, app_name));

        // Record in signing history
        let raw_json = if request.method == "sign_event" && !request.params.is_empty() {
            Some(request.params[0].clone())
        } else { None };
        state.record_signing_history(SigningHistoryEntry {
            id: request.id.clone(),
            timestamp: now_secs(),
            method: request.method.clone(),
            kind: event_kind,
            app_name: app_name.clone(),
            source: "nip46".to_string(),
            outcome: "auto_rejected".to_string(),
            raw_event_json: raw_json,
        });
    } else {
        // Add to pending requests for user approval
        let params_preview = if request.params.is_empty() {
            "(no params)".to_string()
        } else {
            let p = &request.params[0];
            if p.len() > 80 { format!("{}...", &p[..80]) } else { p.clone() }
        };

        let pending = PendingRequest {
            id: request.id.clone(),
            connection_id: conn_id.clone(),
            app_name: app_name.clone(),
            method: request.method.clone(),
            params_preview,
            raw_event_json: if request.method == "sign_event" && !request.params.is_empty() {
                Some(request.params[0].clone())
            } else {
                None
            },
            event_id: event.id.to_hex(),
            client_pubkey: sender_hex.clone(),
            created_at: now_secs(),
            kind: event_kind,
            response_json: Some(response_json),
            use_nip44,
            source: "nip46".to_string(),
            upv2_session_id: None,
            upv2_nonce: None,
        };

        {
            let mut pending_requests = state.pending_requests.lock().unwrap();
            pending_requests.push(pending);
        }

        info!("Pending approval: {} from '{}'", request.method, app_name);
        let _ = app.emit("log-event", format!("[PENDING] {} from '{}' — awaiting approval",
            request.method, app_name));
    }

    // Always emit state update so UI refreshes
    emit_signer_state(app, &state);
}

/// Helper: encrypt and send a NIP-46 response
async fn send_encrypted_response(
    signer_keys: &Keys,
    client: &Client,
    recipient: &PublicKey,
    response_json: &str,
    use_nip44: bool,
) {
    let encrypted = if use_nip44 {
        match nip44::encrypt(signer_keys.secret_key(), recipient, response_json, nip44::Version::default()) {
            Ok(e) => e,
            Err(err) => {
                error!("NIP-44 encrypt failed: {}", err);
                return;
            }
        }
    } else {
        match nip04::encrypt(signer_keys.secret_key(), recipient, response_json) {
            Ok(e) => e,
            Err(err) => {
                error!("NIP-04 encrypt failed: {}", err);
                return;
            }
        }
    };

    let response_event = EventBuilder::new(Kind::Custom(24133), encrypted)
        .tag(Tag::public_key(*recipient));

    if let Err(e) = client.send_event_builder(response_event).await {
        error!("Failed to publish NIP-46 response: {}", e);
    }
}

pub(crate) fn process_nip46_request(signer_keys: &Keys, request: &Nip46Request) -> Nip46Response {
    match request.method.as_str() {
        "connect" => {
            // NIP-46 connect: params[0] = client pubkey, params[1] = optional secret
            // Respond with "ack" to confirm the connection
            Nip46Response {
                id: request.id.clone(),
                result: Some("ack".to_string()),
                error: None,
            }
        }

        "ping" => Nip46Response {
            id: request.id.clone(),
            result: Some("pong".to_string()),
            error: None,
        },

        "get_public_key" => Nip46Response {
            id: request.id.clone(),
            result: Some(signer_keys.public_key().to_hex()),
            error: None,
        },

        "sign_event" => {
            if request.params.is_empty() {
                return Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some("Missing event parameter".to_string()),
                };
            }

            match sign_event_param(signer_keys, &request.params[0]) {
                Ok(signed_json) => Nip46Response {
                    id: request.id.clone(),
                    result: Some(signed_json),
                    error: None,
                },
                Err(e) => Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some(e),
                },
            }
        }

        "nip04_encrypt" => {
            if request.params.len() < 2 {
                return Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some("Missing parameters (pubkey, plaintext)".to_string()),
                };
            }
            match nip04_encrypt_param(signer_keys, &request.params[0], &request.params[1]) {
                Ok(encrypted) => Nip46Response {
                    id: request.id.clone(),
                    result: Some(encrypted),
                    error: None,
                },
                Err(e) => Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some(e),
                },
            }
        }

        "nip04_decrypt" => {
            if request.params.len() < 2 {
                return Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some("Missing parameters (pubkey, ciphertext)".to_string()),
                };
            }
            match nip04_decrypt_param(signer_keys, &request.params[0], &request.params[1]) {
                Ok(plaintext) => Nip46Response {
                    id: request.id.clone(),
                    result: Some(plaintext),
                    error: None,
                },
                Err(e) => Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some(e),
                },
            }
        }

        "nip44_encrypt" => {
            if request.params.len() < 2 {
                return Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some("Missing parameters (pubkey, plaintext)".to_string()),
                };
            }
            match nip44_encrypt_param(signer_keys, &request.params[0], &request.params[1]) {
                Ok(encrypted) => Nip46Response {
                    id: request.id.clone(),
                    result: Some(encrypted),
                    error: None,
                },
                Err(e) => Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some(e),
                },
            }
        }

        "nip44_decrypt" => {
            if request.params.len() < 2 {
                return Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some("Missing parameters (pubkey, ciphertext)".to_string()),
                };
            }
            match nip44_decrypt_param(signer_keys, &request.params[0], &request.params[1]) {
                Ok(plaintext) => Nip46Response {
                    id: request.id.clone(),
                    result: Some(plaintext),
                    error: None,
                },
                Err(e) => Nip46Response {
                    id: request.id.clone(),
                    result: None,
                    error: Some(e),
                },
            }
        }

        "get_relays" => Nip46Response {
            id: request.id.clone(),
            result: Some("{}".to_string()),
            error: None,
        },

        _ => Nip46Response {
            id: request.id.clone(),
            result: None,
            error: Some(format!("Unsupported method: {}", request.method)),
        },
    }
}

// --- Crypto Helpers ---

fn sign_event_param(signer_keys: &Keys, event_json: &str) -> Result<String, String> {
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

fn nip04_encrypt_param(signer_keys: &Keys, pubkey_hex: &str, plaintext: &str) -> Result<String, String> {
    let pk = PublicKey::from_hex(pubkey_hex)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;
    nip04::encrypt(signer_keys.secret_key(), &pk, plaintext)
        .map_err(|e| format!("NIP-04 encrypt failed: {}", e))
}

fn nip04_decrypt_param(signer_keys: &Keys, pubkey_hex: &str, ciphertext: &str) -> Result<String, String> {
    let pk = PublicKey::from_hex(pubkey_hex)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;
    nip04::decrypt(signer_keys.secret_key(), &pk, ciphertext)
        .map_err(|e| format!("NIP-04 decrypt failed: {}", e))
}

fn nip44_encrypt_param(signer_keys: &Keys, pubkey_hex: &str, plaintext: &str) -> Result<String, String> {
    let pk = PublicKey::from_hex(pubkey_hex)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;
    nip44::encrypt(signer_keys.secret_key(), &pk, plaintext, nip44::Version::default())
        .map_err(|e| format!("NIP-44 encrypt failed: {}", e))
}

fn nip44_decrypt_param(signer_keys: &Keys, pubkey_hex: &str, ciphertext: &str) -> Result<String, String> {
    let pk = PublicKey::from_hex(pubkey_hex)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;
    nip44::decrypt(signer_keys.secret_key(), &pk, ciphertext)
        .map_err(|e| format!("NIP-44 decrypt failed: {}", e))
}

/// Sign an event locally using the active keypair. Returns the signed event JSON.
/// Used by the frontend profile editor to sign kind:0 events before publishing.
#[tauri::command]
pub async fn sign_event_local(
    state: State<'_, AppState>,
    kind: u64,
    content: String,
    tags: Vec<Vec<String>>,
) -> Result<String, String> {
    let signer_keys = keys::get_active_keys(&state)?;

    let tag_objects: Vec<Tag> = tags.iter().filter_map(|t| {
        if t.is_empty() { return None; }
        Some(Tag::custom(
            TagKind::from(t[0].as_str()),
            t[1..].to_vec(),
        ))
    }).collect();

    let builder = EventBuilder::new(Kind::Custom(kind as u16), &content)
        .tags(tag_objects);

    let event = builder.sign_with_keys(&signer_keys)
        .map_err(|e| format!("Signing failed: {}", e))?;

    serde_json::to_string(&event)
        .map_err(|e| format!("Serialize failed: {}", e))
}

#[tauri::command]
pub async fn toggle_nip46_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let new_enabled;
    {
        let mut enabled = state.nip46_enabled.lock().unwrap();
        *enabled = !*enabled;
        new_enabled = *enabled;
    }
    state.save_nip46_enabled()?;

    emit_log(&app, &format!("[NIP-46] Signing {}", if new_enabled { "enabled" } else { "disabled" }));
    emit_signer_state(&app, &state);
    Ok(new_enabled)
}

#[tauri::command]
pub fn get_signing_history(state: State<'_, AppState>) -> Vec<SigningHistoryEntry> {
    state.signing_history.lock().unwrap().clone()
}
