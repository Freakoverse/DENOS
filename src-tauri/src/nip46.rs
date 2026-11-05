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

/// Turn an Origin ("https://jumble.social", "http://localhost:5173") into a short display label
/// ("jumble.social", "localhost:5173") for naming a connection.
fn pretty_origin(origin: &str) -> String {
    let no_scheme = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin);
    let host = no_scheme.split('/').next().unwrap_or(no_scheme);
    if host.is_empty() { origin.to_string() } else { host.to_string() }
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

/// NIP-LRS fallback connection string (spec §5.1 MUST): a `bunker://` whose identity is the random
/// **transport key** and whose single relay is the loopback relay. This is the always-works path a
/// user copies into a client when one-click scan discovery is off or unsupported — ordinary NIP-46,
/// so any NIP-46 client connects with it.
#[tauri::command]
pub fn get_lrs_bunker_uri(state: State<'_, AppState>) -> Result<BunkerUriResult, String> {
    let transport_keys = keys::get_transport_keys(&state)?;
    let pubkey_hex = transport_keys.public_key().to_hex();
    let port = *state.lrs_port.lock().unwrap();
    let relay = format!("ws://127.0.0.1:{}", port);

    // Random NIP-46 connection-verification secret (echoed back on approval).
    let secret_keys = Keys::generate();
    let secret = hex::encode(&secret_keys.secret_key().to_secret_bytes()[..8]);

    let uri = format!("bunker://{}?relay={}&secret={}", pubkey_hex, relay, secret);
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
        auto_replace: false,
        source: "nip46".to_string(),
    };

    // Check for existing connection/session with same name (cross-protocol)
    let existing = find_existing_by_name(&state, &app_name, &signer_keys.public_key().to_hex());

    // Always save the new connection so the handshake works
    {
        let mut connections = state.connections.lock().unwrap();
        connections.push(connection);
    }
    state.save_connections()?;

    if let Some((existing_id, existing_source, _policy, _rules, existing_auto_replace)) = existing {
        if existing_auto_replace {
            // Auto-replace: silently replace the old connection, keeping rules
            auto_replace_connection(&app, &state, &conn_id, &existing_id, &existing_source, &app_name);
        } else {
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

    // Publish the ack on the app's relays — through the PERSISTENT signer client whenever the
    // signer is running. Adding the app's relays to that client is the real fix: a newly added
    // relay inherits the running loop's 24133/24134 subscription (nostr-sdk pool semantics), so
    // DENOS keeps LISTENING there for every request the app sends afterwards. The previous
    // throwaway client only carried the handshake and then disconnected, so any relay not already
    // in DENOS's own list silently dropped all follow-up requests — which is why nostrconnect://
    // only worked when the app happened to pick one of DENOS's relays, while bunker:// (which
    // forces the app onto DENOS's relays) always did.
    let shared = state.signer_client.lock().unwrap().clone();
    let (client, owned) = match shared {
        Some(c) => (c, false),
        None => (Client::new(signer_keys.clone()), true), // signer not running: handshake only
    };
    for relay_url in &info.relay_urls {
        if let Err(e) = client.add_relay(relay_url).await {
            warn!("[nostrconnect] Failed to add relay {}: {}", relay_url, e);
            continue;
        }
        // connect() alone returns before the socket is up; wait for it so the ack isn't
        // published into a half-open connection (replaces the old fixed 500ms sleep).
        if let Err(e) = client.try_connect_relay(relay_url, std::time::Duration::from_secs(5)).await {
            warn!("[nostrconnect] Relay {} not ready: {}", relay_url, e);
        }
    }

    match client.send_event_builder_to(info.relay_urls.clone(), event).await {
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

    if owned {
        // Only tear down a throwaway; the shared client must stay up and subscribed.
        client.disconnect().await;
    } else {
        // Reflect the newly-listening relays in the dashboard's connected-relay status.
        let mut connected = state.connected_relays.lock().unwrap();
        for url in &info.relay_urls {
            connected.insert(url.clone());
        }
    }
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
        if request.source == "lrs" {
            // NIP-LRS: encrypt the response with the TRANSPORT key (the identity the client
            // addressed) and publish kind 24133 over the loopback relay client.
            let transport_keys = keys::get_transport_keys(&state)?;
            let client_pk = PublicKey::from_hex(&request.client_pubkey)
                .map_err(|e| format!("Invalid pubkey: {}", e))?;
            let lrs_client = state.lrs_client.lock().unwrap().clone();
            if let Some(client) = lrs_client {
                let encrypted = if request.use_nip44 {
                    nip44::encrypt(transport_keys.secret_key(), &client_pk, response_json, nip44::Version::default())
                        .map_err(|e| format!("NIP-44 encrypt: {}", e))?
                } else {
                    nip04::encrypt(transport_keys.secret_key(), &client_pk, response_json)
                        .map_err(|e| format!("NIP-04 encrypt: {}", e))?
                };
                let response_event = EventBuilder::new(Kind::Custom(24133), encrypted)
                    .tag(Tag::public_key(client_pk));
                match client.send_event_builder(response_event).await {
                    Ok(_) => info!("Sent LRS approved response for: {}", request.method),
                    Err(e) => error!("Failed to send LRS approved response: {}", e),
                }
            } else {
                warn!("No LRS client available to deliver approved response: {}", request.id);
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

    if request.source == "lrs" {
        // NIP-LRS: send the rejection encrypted with the TRANSPORT key over the loopback relay.
        let transport_keys = keys::get_transport_keys(&state)?;
        let client_pk = PublicKey::from_hex(&request.client_pubkey)
            .map_err(|e| format!("Invalid pubkey: {}", e))?;
        let rejection = Nip46Response {
            id: request.id.clone(),
            result: None,
            error: Some("User rejected the request".to_string()),
        };
        let rejection_json = serde_json::to_string(&rejection)
            .map_err(|e| format!("Serialize: {}", e))?;
        let lrs_client = state.lrs_client.lock().unwrap().clone();
        if let Some(client) = lrs_client {
            let encrypted = if request.use_nip44 {
                nip44::encrypt(transport_keys.secret_key(), &client_pk, &rejection_json, nip44::Version::default())
                    .map_err(|e| format!("NIP-44 encrypt: {}", e))?
            } else {
                nip04::encrypt(transport_keys.secret_key(), &client_pk, &rejection_json)
                    .map_err(|e| format!("NIP-04 encrypt: {}", e))?
            };
            let response_event = EventBuilder::new(Kind::Custom(24133), encrypted)
                .tag(Tag::public_key(client_pk));
            match client.send_event_builder(response_event).await {
                Ok(_) => info!("Sent LRS rejection for: {}", request.method),
                Err(e) => error!("Failed to send LRS rejection: {}", e),
            }
        } else {
            warn!("No LRS client available to deliver rejection: {}", request.id);
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
/// Returns (id, source, policy, custom_rules, auto_replace) of the match, if any.
/// Only matches entries belonging to the given signer keypair.
pub fn find_existing_by_name(
    state: &AppState,
    name: &str,
    signer_pubkey: &str,
) -> Option<(String, String, String, HashMap<String, String>, bool)> {
    // Check NIP-46 and PC55 connections (both stored in the connections list)
    {
        let connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter().find(|c| c.app_name.to_lowercase() == name.to_lowercase() && c.signer_pubkey == signer_pubkey) {
            let source = if conn.client_pubkey.starts_with("pc55:") { "pc55" } else { "nip46" };
            return Some((conn.id.clone(), source.to_string(), conn.policy.clone(), conn.custom_rules.clone(), conn.auto_replace));
        }
    }
    // Check UPV2 sessions
    {
        let sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter().find(|s| s.client_name.to_lowercase() == name.to_lowercase() && s.signer_pubkey == signer_pubkey) {
            return Some((session.session_id.clone(), "upv2".to_string(), session.policy.clone(), session.custom_rules.clone(), session.auto_replace));
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
    #[allow(unused_variables)]
    auto_replace: Option<bool>,
) -> Result<(), String> {
    let pending = {
        let mut pr = state.pending_reconnect.lock().unwrap();
        pr.take()
    };
    let pending = pending.ok_or("No pending reconnection")?;

    match action.as_str() {
        "replace" => {
            // Get existing policy/rules/auto_replace before removal
            // NIP-46 and PC55 connections both live in the `connections` store
            let is_connection = pending.existing_source == "nip46" || pending.existing_source == "pc55";
            let (old_policy, old_rules, old_auto_replace) = if is_connection {
                let connections = state.connections.lock().unwrap();
                connections.iter()
                    .find(|c| c.id == pending.existing_id)
                    .map(|c| (c.policy.clone(), c.custom_rules.clone(), c.auto_replace))
                    .unwrap_or(("manual".to_string(), HashMap::new(), false))
            } else {
                let sessions = state.upv2_sessions.lock().unwrap();
                sessions.iter()
                    .find(|s| s.session_id == pending.existing_id)
                    .map(|s| (s.policy.clone(), s.custom_rules.clone(), s.auto_replace))
                    .unwrap_or(("manual".to_string(), HashMap::new(), false))
            };

            // Determine auto_replace for new connection:
            // If user explicitly set it via the toggle, use that; otherwise carry forward the old value
            let new_auto_replace = auto_replace.unwrap_or(old_auto_replace);

            // Remove old connection
            if is_connection {
                let mut connections = state.connections.lock().unwrap();
                connections.retain(|c| c.id != pending.existing_id);
            } else {
                let mut sessions = state.upv2_sessions.lock().unwrap();
                sessions.retain(|s| s.session_id != pending.existing_id);
            }

            // Transfer rules + auto_replace to the new (already saved) connection/session
            if keep_rules {
                if let Some(ref new_conn_id) = pending.new_connection_id {
                    let mut connections = state.connections.lock().unwrap();
                    if let Some(conn) = connections.iter_mut().find(|c| c.id == *new_conn_id) {
                        conn.policy = old_policy.clone();
                        conn.custom_rules = old_rules.clone();
                        conn.auto_replace = new_auto_replace;
                    }
                }
                if let Some(ref new_sess_id) = pending.new_session_id {
                    let mut sessions = state.upv2_sessions.lock().unwrap();
                    if let Some(session) = sessions.iter_mut().find(|s| s.session_id == *new_sess_id) {
                        session.policy = old_policy;
                        session.custom_rules = old_rules;
                        session.auto_replace = new_auto_replace;
                    }
                }
            } else {
                // Even without keeping rules, still set auto_replace if user toggled it on
                if new_auto_replace {
                    if let Some(ref new_conn_id) = pending.new_connection_id {
                        let mut connections = state.connections.lock().unwrap();
                        if let Some(conn) = connections.iter_mut().find(|c| c.id == *new_conn_id) {
                            conn.auto_replace = new_auto_replace;
                        }
                    }
                    if let Some(ref new_sess_id) = pending.new_session_id {
                        let mut sessions = state.upv2_sessions.lock().unwrap();
                        if let Some(session) = sessions.iter_mut().find(|s| s.session_id == *new_sess_id) {
                            session.auto_replace = new_auto_replace;
                        }
                    }
                }
            }

            // Save both stores
            let _ = state.save_connections();
            let _ = state.save_upv2_sessions();

            emit_log(&app, &format!("[INFO] Replaced connection for '{}' (keep_rules={}, auto_replace={})", pending.app_name, keep_rules, new_auto_replace));
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

/// Silently perform auto-replace: remove the existing connection and transfer its
/// policy/rules/auto_replace to the new connection. Used when auto_replace is enabled.
pub fn auto_replace_connection(
    app: &AppHandle,
    state: &State<'_, AppState>,
    new_conn_id: &str,
    existing_id: &str,
    existing_source: &str,
    app_name: &str,
) {
    let is_connection = existing_source == "nip46" || existing_source == "pc55";

    // Read old settings
    let (old_policy, old_rules, old_auto_replace) = if is_connection {
        let connections = state.connections.lock().unwrap();
        connections.iter()
            .find(|c| c.id == existing_id)
            .map(|c| (c.policy.clone(), c.custom_rules.clone(), c.auto_replace))
            .unwrap_or(("manual".to_string(), HashMap::new(), true))
    } else {
        let sessions = state.upv2_sessions.lock().unwrap();
        sessions.iter()
            .find(|s| s.session_id == existing_id)
            .map(|s| (s.policy.clone(), s.custom_rules.clone(), s.auto_replace))
            .unwrap_or(("manual".to_string(), HashMap::new(), true))
    };

    // Remove old
    if is_connection {
        let mut connections = state.connections.lock().unwrap();
        connections.retain(|c| c.id != existing_id);
    } else {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        sessions.retain(|s| s.session_id != existing_id);
    }

    // Transfer settings to new connection
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == new_conn_id) {
            conn.policy = old_policy;
            conn.custom_rules = old_rules;
            conn.auto_replace = old_auto_replace;
        }
    }

    let _ = state.save_connections();
    let _ = state.save_upv2_sessions();

    emit_log(app, &format!("[INFO] Auto-replaced connection for '{}' (auto_replace=true)", app_name));
}

/// Silently perform auto-replace for UPV2 sessions specifically (new entry is a session, not connection)
pub fn auto_replace_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    new_session_id: &str,
    existing_id: &str,
    existing_source: &str,
    app_name: &str,
) {
    let is_connection = existing_source == "nip46" || existing_source == "pc55";

    // Read old settings
    let (old_policy, old_rules, old_auto_replace) = if is_connection {
        let connections = state.connections.lock().unwrap();
        connections.iter()
            .find(|c| c.id == existing_id)
            .map(|c| (c.policy.clone(), c.custom_rules.clone(), c.auto_replace))
            .unwrap_or(("manual".to_string(), HashMap::new(), true))
    } else {
        let sessions = state.upv2_sessions.lock().unwrap();
        sessions.iter()
            .find(|s| s.session_id == existing_id)
            .map(|s| (s.policy.clone(), s.custom_rules.clone(), s.auto_replace))
            .unwrap_or(("manual".to_string(), HashMap::new(), true))
    };

    // Remove old
    if is_connection {
        let mut connections = state.connections.lock().unwrap();
        connections.retain(|c| c.id != existing_id);
    } else {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        sessions.retain(|s| s.session_id != existing_id);
    }

    // Transfer settings to new session
    {
        let mut sessions = state.upv2_sessions.lock().unwrap();
        if let Some(session) = sessions.iter_mut().find(|s| s.session_id == new_session_id) {
            session.policy = old_policy;
            session.custom_rules = old_rules;
            session.auto_replace = old_auto_replace;
        }
    }

    let _ = state.save_connections();
    let _ = state.save_upv2_sessions();

    emit_log(app, &format!("[INFO] Auto-replaced session for '{}' (auto_replace=true)", app_name));
}

/// Toggle auto_replace on a NIP-46 or PC55 connection
#[tauri::command]
pub fn set_connection_auto_replace(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    auto_replace: bool,
) -> Result<(), String> {
    {
        let mut connections = state.connections.lock().unwrap();
        if let Some(conn) = connections.iter_mut().find(|c| c.id == connection_id) {
            conn.auto_replace = auto_replace;
        } else {
            return Err("Connection not found".to_string());
        }
    }
    state.save_connections()?;
    emit_log(&app, &format!("[INFO] Set auto_replace={} for connection", auto_replace));
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
pub fn reset_relays(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut relays = state.relay_urls.lock().unwrap();
        *relays = vec![
            "wss://relay.damus.io".to_string(),
            "wss://relay.primal.net".to_string(),
            "wss://nos.lol".to_string(),
        ];
    }
    state.save_relays()?;
    emit_log(&app, "[INFO] Reset relays to defaults");
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
pub async fn fetch_user_blossom_servers(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let active = state.active_keypair.lock().unwrap().clone()
        .ok_or_else(|| "No active keypair".to_string())?;
    let pubkey = PublicKey::from_hex(&active)
        .map_err(|e| format!("Invalid pubkey: {}", e))?;

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    let filter = Filter::new()
        .kind(Kind::Custom(10063))
        .author(pubkey)
        .limit(1);

    let events: Vec<Event> = match client.fetch_events(filter, std::time::Duration::from_secs(5)).await {
        Ok(evs) => evs.into_iter().collect(),
        Err(e) => return Err(format!("Failed to fetch blossom server list: {}", e)),
    };

    let mut server_urls: Vec<String> = Vec::new();
    if let Some(event) = events.first() {
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.len() >= 2 && parts[0] == "server" {
                server_urls.push(parts[1].to_string());
            }
        }
    }

    Ok(server_urls)
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

#[tauri::command]
pub async fn publish_user_blossom_servers(
    app: AppHandle,
    state: State<'_, AppState>,
    servers: Vec<String>,
) -> Result<(), String> {
    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // Build kind 10063 replaceable event with "server" tags
    let mut tags: Vec<Tag> = Vec::new();
    for url in &servers {
        tags.push(Tag::custom(TagKind::from("server"), vec![url.clone()]));
    }

    let event_builder = EventBuilder::new(Kind::Custom(10063), "")
        .tags(tags);

    match client.send_event_builder(event_builder).await {
        Ok(output) => {
            info!("Published Blossom server list (kind 10063), id={}", output.id().to_hex());
            emit_log(&app, &format!("[INFO] Published Blossom server list ({} servers)", servers.len()));
        }
        Err(e) => {
            error!("Failed to publish Blossom server list: {}", e);
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

    // Also listen on every saved connection's relays. nostrconnect:// apps choose their own
    // relays (recorded on the Connection at handshake); without this, those connections only
    // work until the next signer restart. Collect under the lock, then add relays outside it —
    // a std Mutex guard must never be held across an .await.
    let extra_relays: Vec<String> = {
        let state: tauri::State<'_, AppState> = app.state();
        let connections = state.connections.lock().unwrap();
        let mut seen: std::collections::HashSet<String> = relay_urls.iter()
            .map(|u| u.trim_end_matches('/').to_string())
            .collect();
        connections.iter()
            .flat_map(|c| c.relay_urls.iter())
            .filter(|u| seen.insert(u.trim_end_matches('/').to_string()))
            .cloned()
            .collect()
    };
    for url in &extra_relays {
        if let Err(e) = client.add_relay(url).await {
            warn!("Failed to add connection relay {}: {}", url, e);
        }
    }
    client.connect().await;

    // Store client in AppState so approve/reject can reuse it
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut sc = state.signer_client.lock().unwrap();
        *sc = Some(client.clone());
    }

    let _ = app.emit("log-event", "[INFO] Connected to relays, subscribing...");

    // Mark relays as connected (configured + saved-connection relays the loop listens on)
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut connected = state.connected_relays.lock().unwrap();
        for url in relay_urls.iter().chain(extra_relays.iter()) {
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
                            // Remote NIP-46: the account key is both the envelope identity and the
                            // signing identity.
                            handle_nip46_event(
                                &app,
                                &signer_keys,
                                &signer_keys,
                                "nip46",
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

/// NIP-LRS signer loop: attach to the in-process loopback relay using the random **transport key**
/// as the NIP-46 identity, and sign as the active **account**. This "opens a loopback socket to
/// itself" (allowed by the spec) and reuses the entire existing request pipeline via
/// [`handle_nip46_event`] with the envelope/signing key split. Stops on the relay's shutdown
/// broadcast.
pub async fn run_lrs_signer_loop(
    app: AppHandle,
    transport_keys: Keys,
    account_keys: Keys,
    relay_url: String,
    mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
) -> Result<(), String> {
    let transport_pubkey = transport_keys.public_key();

    let client = Client::new(transport_keys.clone());
    client
        .add_relay(&relay_url)
        .await
        .map_err(|e| format!("LRS add_relay {}: {}", relay_url, e))?;
    client.connect().await;

    // Share the client so approve/reject can publish responses over the local relay.
    {
        let state: tauri::State<'_, AppState> = app.state();
        *state.lrs_client.lock().unwrap() = Some(client.clone());
    }

    // Subscribe to NIP-46 requests addressed to the transport key.
    let filter = Filter::new()
        .kind(Kind::Custom(24133))
        .pubkey(transport_pubkey)
        .since(Timestamp::now());
    client
        .subscribe(filter, None)
        .await
        .map_err(|e| format!("LRS subscribe failed: {}", e))?;

    let _ = app.emit("log-event", "[INFO] Local Relay Signer attached — listening on loopback");

    let mut notifications = client.notifications();
    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                info!("[LRS] Signer loop shutdown signal received");
                break;
            }
            notification = notifications.recv() => {
                match notification {
                    Ok(RelayPoolNotification::Event { event, .. }) => {
                        if event.kind == Kind::Custom(24133) {
                            // Envelope = transport key; signing = account key; source = "lrs".
                            handle_nip46_event(
                                &app,
                                &transport_keys,
                                &account_keys,
                                "lrs",
                                &client,
                                &event,
                            ).await;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        error!("[LRS] notification error: {}", e);
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }

    {
        let state: tauri::State<'_, AppState> = app.state();
        *state.lrs_client.lock().unwrap() = None;
    }
    client.disconnect().await;
    info!("[LRS] Signer loop ended");
    Ok(())
}

/// Handle an incoming NIP-46 request event.
///
/// `envelope_keys` is the identity the request is encrypted to and responses are encrypted from —
/// the account key for remote NIP-46, or the random **transport key** for NIP-LRS. `signing_keys`
/// is the account the operation actually runs as (always the account). `source` tags the request
/// ("nip46" / "lrs") so approve/reject route the response back over the right transport. `client`
/// is the relay client used to publish responses (the remote pool, or the loopback LRS client).
async fn handle_nip46_event(
    app: &AppHandle,
    envelope_keys: &Keys,
    signing_keys: &Keys,
    source: &str,
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
    let (decrypted, use_nip44): (String, bool) = match nip04::decrypt(envelope_keys.secret_key(), &sender_pubkey, &content) {
        Ok(text) => (text, false),
        Err(_) => {
            match nip44::decrypt(envelope_keys.secret_key(), &sender_pubkey, &content) {
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
    // A recognized client key (existing connection) is a reconnect, not first contact.
    let is_reconnect = existing_conn.is_some();

    let (conn_id, app_name) = if let Some((id, name)) = existing_conn {
        (id, name)
    } else if request.method == "connect" {
        // Only `connect` requests can establish new connections
        let new_id = uuid::Uuid::new_v4().to_string();
        // Name an LRS connection after the web app's Origin when the relay captured one; otherwise
        // (and for remote NIP-46) fall back to the client pubkey.
        let (name, app_url) = if source == "lrs" {
            match state.lrs_client_origins.lock().unwrap().get(&sender_hex).cloned() {
                Some(origin) => (pretty_origin(&origin), Some(origin)),
                None => (format!("App {}...", &sender_hex[..12]), None),
            }
        } else {
            (format!("App {}...", &sender_hex[..12]), None)
        };
        let connection = Connection {
            id: new_id.clone(),
            app_name: name.clone(),
            app_url,
            app_icon: None,
            client_pubkey: sender_hex.clone(),
            relay_urls: state.relay_urls.lock().unwrap().clone(),
            created_at: now_secs(),
            auto_approve: false,
            auto_reject: false,
            auto_approve_kinds: vec![],
            policy: "manual".to_string(),
            custom_rules: HashMap::new(),
            signer_pubkey: signing_keys.public_key().to_hex(),
            auto_replace: false,
            source: source.to_string(),
        };
        {
            let mut connections = state.connections.lock().unwrap();
            connections.push(connection);
        }
        // Persist to the keyring on a background thread — the connection is already
        // tracked in memory, and a slow synchronous keyring write here would delay
        // the approval prompt / connect response by seconds, causing clients to time
        // out before the user can approve.
        {
            let app_bg = app.clone();
            std::thread::spawn(move || {
                let state: tauri::State<'_, AppState> = app_bg.state();
                let _ = state.save_connections();
            });
        }
        (new_id, name)
    } else {
        // No connection and not a connect request — silently ignore
        warn!("Ignoring {} from unknown client {}", request.method, &sender_hex[..16]);
        return;
    };

    // Process the request — always as the ACCOUNT (signing) key, never the envelope key.
    let response = process_nip46_request(signing_keys, &request);
    let response_json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(e) => {
            error!("Failed to serialize response: {}", e);
            return;
        }
    };

    // Determine if this should auto-respond or require approval
    // Safe metadata queries always auto-respond. The SKD pubkey reads return only a DERIVED
    // public key (no secret, no signature) — same sensitivity class as get_public_key (§2.1) —
    // so they're safe to auto-respond, letting clients probe NIP-SKD support without a prompt.
    // (The v2 capability probe is skd_get_blinded_pubkey, so it MUST be here.) Sign and
    // encrypt/decrypt-as-subkey stay policy-gated.
    let is_safe_method = matches!(request.method.as_str(),
        "ping" | "get_public_key" | "get_relays"
    ) || skd_is_pubkey_read(&request.method);

    // Event kind for sign_event (params[0]) and the SKD sign methods (params[1] = event).
    let event_kind: Option<u32> = {
        let ev = if request.method == "sign_event" {
            request.params.first()
        } else if skd_is_sign(&request.method) {
            request.params.get(1)
        } else {
            None
        };
        ev.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
            .and_then(|v| v.get("kind").and_then(|k| k.as_u64()).map(|k| k as u32))
    };

    // NIP-SKD derivation context (params[0]) — for context-prefix rule matching + UI display.
    let skd_context: Option<&str> = if request.method.starts_with("skd_") {
        request.params.first().map(String::as_str)
    } else {
        None
    };

    // Check connection-level policy
    let (conn_policy, custom_rule) = {
        let connections = state.connections.lock().unwrap();
        connections.iter().find(|c| c.id == conn_id)
            .map(|c| {
                let rule = if c.policy == "custom" {
                    crate::state::resolve_custom_rule(&c.custom_rules, &request.method, event_kind, skd_context)
                } else {
                    None
                };
                (c.policy.clone(), rule)
            })
            .unwrap_or(("manual".to_string(), None))
    };

    // `connect` auto-responds for remote NIP-46: it only establishes the session (actual signing
    // still goes through the connection's policy below), and many NIP-46 clients have a short
    // connect timeout that a human approval would blow past.
    //
    // For NIP-LRS, FIRST contact does NOT auto-respond: there is no pre-shared secret (no pasted
    // string), so it MUST get explicit user approval before the connection is usable (spec §6.2),
    // and gating that first `connect` is what keeps the account undisclosed until approval. A
    // RECONNECT with a recognized client key resumes silently (spec §6) — the user already approved
    // this client, so re-prompting on every login would be noise.
    let auto_connect = request.method == "connect" && (source != "lrs" || is_reconnect);
    if is_safe_method || auto_connect || conn_policy == "auto_approve" || custom_rule.as_deref() == Some("approve") {
        // Auto-respond: safe method / connect handshake OR connection has auto-approve enabled
        send_encrypted_response(envelope_keys, client, &sender_pubkey, &response_json, use_nip44).await;
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
            source: source.to_string(),
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
            send_encrypted_response(envelope_keys, client, &sender_pubkey, &rej_json, use_nip44).await;
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
            source: source.to_string(),
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
            context: skd_context.map(String::from),
            raw_event_json: if request.method == "sign_event" && !request.params.is_empty() {
                Some(request.params[0].clone())
            } else if skd_is_sign(&request.method) && request.params.len() > 1 {
                Some(request.params[1].clone())
            } else {
                None
            },
            event_id: event.id.to_hex(),
            client_pubkey: sender_hex.clone(),
            created_at: now_secs(),
            kind: event_kind,
            response_json: Some(response_json),
            use_nip44,
            source: source.to_string(),
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
            // NIP-46 connect: params[0] = the signer pubkey the client wants,
            // params[1] = optional secret (from the bunker:// URL we issued).
            // The client verifies the connection by checking that the response
            // `result` equals the secret it sent — so echo it back when present
            // (matching the nostrconnect path). Fall back to "ack" if no secret.
            // Clients that don't validate simply ignore the value.
            let result = request.params.get(1)
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| "ack".to_string());
            Nip46Response {
                id: request.id.clone(),
                result: Some(result),
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

        // ── NIP-SKD: sub-key operations ──────────────────────────────────────────────
        // Derive an application-scoped key from the root key + a public `context` (+ a `peer`
        // pubkey for the shared/blinded forms), then run the operation as that key. The form is
        // an explicit part of the method name — `*_as_self_subkey` (root alone), `*_as_shared_subkey`
        // (independent ECDH key, peer required), or `*_as_blinded` (root blinded toward peer, peer
        // required) — never inferred from peer presence, so a stray peer can't switch forms. Private
        // material is never returned — only the result. The pubkey reads are "safe" (auto, §2.1);
        // the sign and encrypt/decrypt ops flow through the normal per-connection policy gate.
        m if skd_is_composed_verify(m) => {
            // Composed verify (§1.2) — distinct positional layout, viaContext leads:
            //   via_self:    [viaContext, context, peer]
            //   via_blinded: [viaContext, viaPeer, context, peer]
            let p = &request.params;
            if m == "skd_get_peer_blinded_pubkey_via_self" {
                match (p.first(), p.get(1), p.get(2)) {
                    (Some(vc), Some(ctx), Some(peer)) => skd_respond(
                        &request.id,
                        skd_operate_via(signer_keys, m, vc, None, ctx, peer),
                    ),
                    _ => skd_err(&request.id, "NIP-SKD: via_self needs [viaContext, context, peer]"),
                }
            } else {
                match (p.first(), p.get(1), p.get(2), p.get(3)) {
                    (Some(vc), Some(vp), Some(ctx), Some(peer)) => skd_respond(
                        &request.id,
                        skd_operate_via(signer_keys, m, vc, Some(vp), ctx, peer),
                    ),
                    _ => skd_err(
                        &request.id,
                        "NIP-SKD: via_blinded needs [viaContext, viaPeer, context, peer]",
                    ),
                }
            }
        }

        m if m.starts_with("skd_") => {
            let p = &request.params;
            if p.is_empty() {
                return skd_err(&request.id, "Missing parameter (context)");
            }
            // Positional layout: [context, ...op-args, peer?]. Op-args by category: sign → one
            // (event) at [1]; encrypt/decrypt → two at [1],[2]; pubkey reads → none. The peer is
            // the trailing param — present for shared/blinded, absent for self (where the index
            // falls past the end → None). The FORM is chosen by the method name in skd_operate,
            // not by peer presence, so a stray peer can't silently switch a self op to shared.
            let op_args: usize = if skd_is_sign(m) {
                1
            } else if m.contains("_encrypt_as_") || m.contains("_decrypt_as_") {
                2
            } else {
                0
            };
            let a1 = if op_args >= 1 { p.get(1).map(String::as_str) } else { None };
            let a2 = if op_args >= 2 { p.get(2).map(String::as_str) } else { None };
            let peer = skd_peer(p, 1 + op_args);
            skd_respond(&request.id, skd_operate(signer_keys, m, &p[0], peer, a1, a2))
        }

        _ => Nip46Response {
            id: request.id.clone(),
            result: None,
            error: Some(format!("Unsupported method: {}", request.method)),
        },
    }
}

// --- NIP-SKD helpers ---

/// The trailing `peer` pubkey at index `i`, treated as absent when omitted or empty. Self methods
/// carry no peer (the index is past the end → None); shared/blinded methods carry it there.
fn skd_peer(params: &[String], i: usize) -> Option<&str> {
    params.get(i).map(String::as_str).filter(|s| !s.is_empty())
}

/// True for the NIP-SKD signing methods (self/shared/blinded). Their event template is the second
/// positional param (NIP-46) / the `event` field (UPV2), and they are approval-gated.
pub(crate) fn skd_is_sign(method: &str) -> bool {
    // skd_sign_as_self_subkey | skd_sign_as_shared_subkey | skd_sign_as_blinded
    method.contains("_sign_as_")
}

/// True for the NIP-SKD pubkey reads (self/shared/blinded + verifier). They return only a public
/// key — no secret, no signature — so they are answered non-interactively, the same class as
/// get_public_key (§2.1). The v2 capability probe is one of these (skd_get_blinded_pubkey).
pub(crate) fn skd_is_pubkey_read(method: &str) -> bool {
    matches!(
        method,
        "skd_get_self_subkey_pubkey"
            | "skd_get_shared_subkey_pubkey"
            | "skd_get_blinded_pubkey"
            | "skd_get_peer_blinded_pubkey"
            | "skd_get_peer_blinded_pubkey_via_self"
            | "skd_get_peer_blinded_pubkey_via_blinded"
    )
}

/// True for the composed verifier ops (§1.2): the ECDH identity `K` is one of the caller's own
/// sub-keys (self or blinded) rather than the root. Distinct positional layout (viaContext leads),
/// so the dispatcher parses them separately from the uniform `[context, …, peer]` methods.
pub(crate) fn skd_is_composed_verify(method: &str) -> bool {
    matches!(
        method,
        "skd_get_peer_blinded_pubkey_via_self" | "skd_get_peer_blinded_pubkey_via_blinded"
    )
}

/// Derive the sub-key `Keys` from the signer's root key + context (+ optional peer).
fn skd_subkey_keys(signer_keys: &Keys, context: &str, peer: Option<&str>) -> Result<Keys, String> {
    crate::skd::derive_subkey_keys(&signer_keys.secret_key().to_secret_hex(), context, peer)
}

fn skd_ok(id: &str, result: String) -> Nip46Response {
    Nip46Response { id: id.to_string(), result: Some(result), error: None }
}
fn skd_err(id: &str, error: &str) -> Nip46Response {
    Nip46Response { id: id.to_string(), result: None, error: Some(error.to_string()) }
}
fn skd_respond(id: &str, r: Result<String, String>) -> Nip46Response {
    match r {
        Ok(v) => skd_ok(id, v),
        Err(e) => skd_err(id, &e),
    }
}

/// Derive the sub-key and perform the requested SKD operation, returning the result string.
/// Shared by the NIP-46/PC55 router and the UPV2 handler. `arg1`/`arg2` are the op-specific
/// params: sign → arg1 = event JSON; encrypt → (recipient, plaintext); decrypt → (sender,
/// ciphertext); get-pubkey → none. Never exposes the sub-key private material.
pub(crate) fn skd_operate(
    signer_keys: &Keys,
    method: &str,
    context: &str,
    peer: Option<&str>,
    arg1: Option<&str>,
    arg2: Option<&str>,
) -> Result<String, String> {
    let root_hex = signer_keys.secret_key().to_secret_hex();

    // Verifier-only op: a PEER's blinded pubkey (base = peer). Pubkey out, no private key here —
    // the "verify a binding but can't impersonate" property. Handled before deriving any key.
    if method == "skd_get_peer_blinded_pubkey" {
        let peer = peer.ok_or("NIP-SKD: blinded derivation requires a peer")?;
        return crate::skd::derive_blinded_pub_for_peer(&root_hex, context, peer);
    }

    // The FORM is authoritative from the method name (not from peer presence), so a stray/omitted
    // peer can never silently switch forms and derive the wrong key:
    //   *_self_subkey   → self  (root alone; peer ignored)
    //   *_shared_subkey → shared (independent key from ECDH; peer required)
    //   *_blinded       → blinded (caller's root blinded toward peer; peer required)
    let sub = if method.contains("_blinded") {
        let peer = peer.ok_or("NIP-SKD: blinded derivation requires a peer")?;
        crate::skd::derive_blinded_keys(&root_hex, context, peer)?
    } else if method.contains("_self_subkey") {
        crate::skd::derive_subkey_keys(&root_hex, context, None)?
    } else if method.contains("_shared_subkey") {
        let peer = peer.ok_or("NIP-SKD: shared derivation requires a peer")?;
        crate::skd::derive_subkey_keys(&root_hex, context, Some(peer))?
    } else {
        return Err(format!("Unsupported SKD method: {}", method));
    };

    // The operation is the same across forms — choose it by method substring.
    if method.ends_with("_pubkey") {
        Ok(sub.public_key().to_hex())
    } else if skd_is_sign(method) {
        sign_event_param(&sub, arg1.ok_or("NIP-SKD: missing event")?)
    } else if method.contains("_encrypt_as_") {
        let recipient = arg1.ok_or("NIP-SKD: missing recipient")?;
        let plaintext = arg2.ok_or("NIP-SKD: missing plaintext")?;
        if method.contains("nip04") {
            nip04_encrypt_param(&sub, recipient, plaintext)
        } else {
            nip44_encrypt_param(&sub, recipient, plaintext)
        }
    } else if method.contains("_decrypt_as_") {
        let sender = arg1.ok_or("NIP-SKD: missing sender")?;
        let ciphertext = arg2.ok_or("NIP-SKD: missing ciphertext")?;
        if method.contains("nip04") {
            nip04_decrypt_param(&sub, sender, ciphertext)
        } else {
            nip44_decrypt_param(&sub, sender, ciphertext)
        }
    } else {
        Err(format!("Unsupported SKD method: {}", method))
    }
}

/// Composed verifier ops (§1.2): re-derive a peer's blinded pubkey where the caller's ECDH identity
/// `K` is one of the caller's OWN sub-keys (not the root). `K` is derived internally from the root
/// and used only as the ECDH secret — it is NEVER returned (a self K controls its pseudonym; a
/// blinded K is root-equivalent). The result is a public key only, and there is deliberately no op
/// to *act as* the peer's key. Shared by the NIP-46/PC55 router and the UPV2 handler.
///   ViaSelf    — K = self(root, via_context)
///   ViaBlinded — K = blinded(root, via_context, via_peer)   (via_peer required)
pub(crate) fn skd_operate_via(
    signer_keys: &Keys,
    method: &str,
    via_context: &str,
    via_peer: Option<&str>,
    context: &str,
    peer: &str,
) -> Result<String, String> {
    let root_hex = signer_keys.secret_key().to_secret_hex();
    // Derive K (the verifier's own sub-key) internally; its private scalar never leaves the signer.
    let k_hex = match method {
        "skd_get_peer_blinded_pubkey_via_self" => {
            crate::skd::derive_subkey_keys(&root_hex, via_context, None)?
                .secret_key()
                .to_secret_hex()
        }
        "skd_get_peer_blinded_pubkey_via_blinded" => {
            let vp = via_peer.ok_or("NIP-SKD: via_blinded requires viaPeer")?;
            crate::skd::derive_blinded_keys(&root_hex, via_context, vp)?
                .secret_key()
                .to_secret_hex()
        }
        _ => return Err(format!("Unsupported SKD method: {}", method)),
    };
    // Verify with K as the ECDH identity (base = peer). Pubkey only.
    crate::skd::derive_blinded_pub_for_peer(&k_hex, context, peer)
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

    // Preserve the client's created_at so the event hash (and any pre-computed
    // PoW) stays valid.  Falls back to Timestamp::now() if not provided.
    let created_at = unsigned.get("created_at")
        .and_then(|v| v.as_u64())
        .map(Timestamp::from);

    let tags: Vec<Tag> = if let Some(tags_arr) = unsigned.get("tags").and_then(|v| v.as_array()) {
        tags_arr.iter().filter_map(|t| {
            let items: Vec<String> = t.as_array()?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if items.is_empty() { return None; }
            // Use Tag::parse to preserve raw tag data exactly as the client sent it.
            // Tag::custom(TagKind::from("p"), ...) causes nostr-sdk to treat well-known
            // tags (p, e, etc.) specially, potentially reordering or dropping them during
            // EventBuilder::sign_with_keys(). Tag::parse avoids this by keeping the raw array.
            Tag::parse(&items).ok().or_else(|| {
                // Fallback: if parse fails, use Tag::custom (shouldn't happen for valid tags)
                Some(Tag::custom(
                    TagKind::from(items[0].as_str()),
                    items[1..].to_vec(),
                ))
            })
        }).collect()
    } else {
        vec![]
    };

    let mut builder = EventBuilder::new(Kind::Custom(kind as u16), content)
        .tags(tags);

    if let Some(ts) = created_at {
        builder = builder.custom_created_at(ts);
    }

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

#[cfg(test)]
mod skd_rpc_tests {
    //! §8 vectors exercised end-to-end through the RPC dispatch helpers (not just skd.rs). The
    //! composed verifier ops re-derive the caller's own sub-key K internally, then verify the peer.
    use super::skd_operate_via;
    use nostr_sdk::prelude::{Keys, SecretKey};

    fn keys(priv_hex: &str) -> Keys {
        Keys::new(SecretKey::from_hex(priv_hex).unwrap())
    }

    // ViaSelf: owner (root 1111…) re-derives member P from R_member_pub. K = owner pseudonym (self,
    // owner-ctx). Reproduces the §8 owner-view P.
    #[test]
    fn via_self_reproduces_member_p() {
        let owner = keys(&"11".repeat(32));
        let got = skd_operate_via(
            &owner,
            "skd_get_peer_blinded_pubkey_via_self",
            "nip-chat:v2:owner-pseudonym:abc-123",
            None,
            "nip-chat:v2:member-pseudonym:abc-123",
            "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
        )
        .unwrap();
        assert_eq!(
            got,
            "059510a63a230047ffe6e978ade8ad31e4bfb59d414331d5b17b6d50038c51a1"
        );
    }

    // ViaBlinded: facilitator (root 3333…) re-derives vouched user Pf. K = facilitator's member
    // pseudonym (blinded toward O), viaPeer = O_pub, peer = R_f_pub (root 4444). Reproduces §8 Pf.
    #[test]
    fn via_blinded_reproduces_facilitated_pf() {
        let facilitator = keys(&"33".repeat(32));
        let r_f_pub = keys(&"44".repeat(32)).public_key().to_hex();
        let got = skd_operate_via(
            &facilitator,
            "skd_get_peer_blinded_pubkey_via_blinded",
            "nip-chat:v2:member-pseudonym:abc-123",
            Some("94576ae28a4583c68e5641b10befe9a90c92680271dc839052937a8552fc0ae5"),
            "nip-chat:v2:facilitated-pseudonym:abc-123",
            &r_f_pub,
        )
        .unwrap();
        assert_eq!(
            got,
            "31b1370ab9902ae59ee73d76bc5c7fb451d7bd52ec7c111a48f42d9ed2389a06"
        );
    }
}
