use crate::keys;
use crate::nip46::{self, find_existing_by_name, Nip46Request, Nip46Response};
use crate::state::{AppState, Connection, Pc55Connection, PendingReconnect, PendingRequest, SigningHistoryEntry};
use futures_util::{SinkExt, StreamExt};
use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn, error};

const PC55_PORT: u16 = 7777;
const SIGNER_NAME: &str = "DENOS";
const SIGNER_VERSION: &str = "0.1.0";

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn emit_signer_state(app: &AppHandle, state: &AppState) {
    let payload = state.to_signer_payload();
    let _ = app.emit("signer-state", payload);
}

fn emit_log(app: &AppHandle, msg: &str) {
    let _ = app.emit("log-event", msg);
}

// --- Discovery Response ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiscoverResponse {
    name: String,
    version: String,
    accounts: Vec<DiscoverAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiscoverAccount {
    npub: String,
    display_name: String,
}

// --- PC55 Request/Response (plain JSON, no encryption) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pc55Message {
    id: Option<String>,
    method: String,
    params: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pc55ResponseMessage {
    id: Option<String>,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn start_pc55_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let running = state.pc55_running.lock().unwrap();
        if *running {
            return Err("PC55 server is already running".to_string());
        }
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    {
        let mut handle = state.pc55_shutdown.lock().unwrap();
        *handle = Some(shutdown_tx);
    }
    {
        let mut running = state.pc55_running.lock().unwrap();
        *running = true;
    }

    info!("[PC55] Starting local WebSocket server on port {}", PC55_PORT);
    emit_log(&app, &format!("[INFO] NIP-PC55 server starting on ws://localhost:{}", PC55_PORT));
    emit_signer_state(&app, &state);

    let app_handle = app.clone();
    tokio::spawn(async move {
        if let Err(e) = run_pc55_server(app_handle.clone(), shutdown_rx).await {
            error!("[PC55] Server error: {}", e);
            // Only reset state if no new server was started in the meantime
            let state: tauri::State<'_, AppState> = app_handle.state();
            let shutdown = state.pc55_shutdown.lock().unwrap();
            if shutdown.is_none() {
                // No new server pending — safe to mark as stopped
                drop(shutdown);
                let mut running = state.pc55_running.lock().unwrap();
                *running = false;
                state.pc55_connections.lock().unwrap().clear();
                emit_signer_state(&app_handle, &state);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_pc55_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let shutdown_tx = {
        let mut handle = state.pc55_shutdown.lock().unwrap();
        handle.take()
    };

    if let Some(tx) = shutdown_tx {
        let _ = tx.send(());
    }

    {
        let mut running = state.pc55_running.lock().unwrap();
        *running = false;
    }
    {
        let mut connections = state.pc55_connections.lock().unwrap();
        connections.clear();
    }

    info!("[PC55] Server stopped");
    emit_log(&app, "[INFO] NIP-PC55 server stopped");
    emit_signer_state(&app, &state);

    Ok(())
}

#[tauri::command]
pub fn get_pc55_state(state: State<'_, AppState>) -> Pc55StatePayload {
    Pc55StatePayload {
        running: *state.pc55_running.lock().unwrap(),
        port: PC55_PORT,
        connections: state.pc55_connections.lock().unwrap().clone(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pc55StatePayload {
    pub running: bool,
    pub port: u16,
    pub connections: Vec<Pc55Connection>,
}

// --- Server Loop ---

async fn run_pc55_server(
    app: AppHandle,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PC55_PORT));

    // Use TcpSocket with SO_REUSEADDR so the port is immediately reusable after stop
    let listener = {
        let mut last_err = String::new();
        let mut bound = None;
        // Retry a few times in case the old listener hasn't fully dropped yet
        for attempt in 0..10 {
            let socket = tokio::net::TcpSocket::new_v4()
                .map_err(|e| format!("Failed to create socket: {}", e))?;
            socket.set_reuseaddr(true)
                .map_err(|e| format!("Failed to set SO_REUSEADDR: {}", e))?;
            match socket.bind(addr) {
                Ok(()) => {
                    match socket.listen(128) {
                        Ok(l) => { bound = Some(l); break; }
                        Err(e) => { last_err = format!("listen failed: {}", e); }
                    }
                }
                Err(e) => {
                    last_err = format!("bind failed: {}", e);
                }
            }
            if attempt < 9 {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            }
        }
        bound.ok_or_else(|| format!("Failed to bind to {} after retries: {}", addr, last_err))?
    };

    info!("[PC55] Listening on ws://{}", addr);
    emit_log(&app, &format!("[INFO] NIP-PC55 listening on ws://{}", addr));

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                info!("[PC55] Shutdown signal received");
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, peer_addr)) => {
                        info!("[PC55] New connection from {}", peer_addr);
                        emit_log(&app, &format!("[PC55] Connection from {}", peer_addr));

                        let app_clone = app.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(app_clone, stream, peer_addr).await {
                                warn!("[PC55] Connection error from {}: {}", peer_addr, e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("[PC55] Accept error: {}", e);
                    }
                }
            }
        }
    }
    // Note: state cleanup is handled by stop_pc55_server or the spawn callback.
    // Do NOT reset pc55_running here — it would race with a newly started server.

    info!("[PC55] Server loop ended");
    Ok(())
}

// --- Per-Connection Handler ---

async fn handle_connection(
    app: AppHandle,
    stream: TcpStream,
    peer_addr: SocketAddr,
) -> Result<(), String> {
    let ws_stream = tokio_tungstenite::accept_async(stream).await
        .map_err(|e| format!("WebSocket handshake failed: {}", e))?;

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let client_id = uuid::Uuid::new_v4().to_string();

    // Track this connection
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut connections = state.pc55_connections.lock().unwrap();
        connections.push(Pc55Connection {
            client_id: client_id.clone(),
            app_name: format!("unknown ({})", peer_addr),
            approved: false,
            connected_at: now_secs(),
        });
        // NOTE: Do NOT call emit_signer_state here — it re-locks pc55_connections (deadlock)
    }
    {
        let state: tauri::State<'_, AppState> = app.state();
        emit_signer_state(&app, &state);
    }

    // Track the client's cryptographic pubkey (set during `connect` handshake)
    // This persists across messages on the same WebSocket connection.
    let mut client_pubkey: Option<String> = None;

    // Process messages
    while let Some(msg_result) = ws_receiver.next().await {
        // Check if the server was stopped — if so, close this connection
        {
            let state: tauri::State<'_, AppState> = app.state();
            if !*state.pc55_running.lock().unwrap() {
                info!("[PC55] Server stopped, closing connection to {}", peer_addr);
                break;
            }
        }

        let msg = match msg_result {
            Ok(m) => m,
            Err(e) => {
                warn!("[PC55] Read error from {}: {}", peer_addr, e);
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                info!("[PC55] Received message from {}: {}", peer_addr, &text[..text.len().min(200)]);
                let response = handle_message(&app, &client_id, &text, &mut client_pubkey).await;
                if let Some(ref response_json) = response {
                    info!("[PC55] Sending response to {}: {}", peer_addr, &response_json[..response_json.len().min(200)]);
                    if ws_sender.send(Message::Text(response_json.clone().into())).await.is_err() {
                        warn!("[PC55] Failed to send response to {}", peer_addr);
                        break;
                    }
                } else {
                    warn!("[PC55] No response generated for message from {}", peer_addr);
                }
            }
            Message::Close(_) => {
                info!("[PC55] Client {} disconnecting", peer_addr);
                break;
            }
            Message::Ping(data) => {
                let _ = ws_sender.send(Message::Pong(data)).await;
            }
            _ => {
                info!("[PC55] Non-text message from {}: {:?}", peer_addr, msg);
            }
        }
    }

    // Remove this connection from tracking
    {
        let state: tauri::State<'_, AppState> = app.state();
        let mut connections = state.pc55_connections.lock().unwrap();
        connections.retain(|c| c.client_id != client_id);
    }
    {
        let state: tauri::State<'_, AppState> = app.state();
        emit_signer_state(&app, &state);
    }

    info!("[PC55] Connection closed: {}", peer_addr);
    Ok(())
}

// --- Message Handler ---

async fn handle_message(
    app: &AppHandle,
    client_id: &str,
    text: &str,
    client_pubkey: &mut Option<String>,
) -> Option<String> {
    let msg: Pc55Message = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            warn!("[PC55] Invalid JSON: {} — raw: {}", e, &text[..text.len().min(100)]);
            let response = Pc55ResponseMessage {
                id: None,
                result: None,
                error: Some(format!("Invalid JSON: {}", e)),
            };
            return serde_json::to_string(&response).ok();
        }
    };

    let method = msg.method.as_str();
    let params = msg.params.clone().unwrap_or_default();
    let msg_id = msg.id.clone();

    info!("[PC55] Handling method: {} (id: {:?})", method, msg_id);

    match method {
        "discover" => {
            let discover_response = handle_discover(app);
            info!("[PC55] Discover response: {} accounts, signer: {}", discover_response.accounts.len(), discover_response.name);
            let response = Pc55ResponseMessage {
                id: msg_id,
                result: Some(serde_json::to_value(&discover_response).unwrap()),
                error: None,
            };
            serde_json::to_string(&response).ok()
        }

        "connect" => {
            // Create or find existing Connection entry
            let state: tauri::State<'_, AppState> = app.state();
            let signer_keys = match keys::get_active_keys(&state) {
                Ok(k) => k,
                Err(e) => {
                    let response = Pc55ResponseMessage {
                        id: msg_id,
                        result: None,
                        error: Some(format!("No active keypair: {}", e)),
                    };
                    return serde_json::to_string(&response).ok();
                }
            };

            let app_name = params.first().cloned().unwrap_or_else(|| "unknown".to_string());
            let client_pk_hex = params.get(1).cloned(); // Optional: client's cryptographic pubkey
            let signer_pk_hex = signer_keys.public_key().to_hex();

            // Store the client pubkey for this WebSocket session
            *client_pubkey = client_pk_hex.clone();

            // Determine the Connection identity key:
            // - If client sent a pubkey: use "pc55:<pubkey_hex>" (cryptographic binding)
            // - If no pubkey (legacy client): use "pc55:<websocket_uuid>" (app_name-based)
            let conn_key = if let Some(ref pk) = client_pk_hex {
                format!("pc55:{}", pk)
            } else {
                format!("pc55:{}", client_id)
            };

            if client_pk_hex.is_some() {
                // Cryptographic binding: deduplicate by client pubkey
                let existing_conn_id = {
                    let connections = state.connections.lock().unwrap();
                    connections.iter().find(|c|
                        c.client_pubkey == conn_key &&
                        c.signer_pubkey == signer_pk_hex
                    ).map(|c| c.id.clone())
                };

                if let Some(_conn_id) = existing_conn_id {
                    // Same pubkey reconnecting — reuse existing Connection (policies preserved)
                    info!("[PC55] Client '{}' reconnected with same keypair", app_name);
                } else {
                    // New pubkey — create new Connection
                    let conn = Connection {
                        id: uuid::Uuid::new_v4().to_string(),
                        app_name: app_name.clone(),
                        app_url: None,
                        app_icon: None,
                        client_pubkey: conn_key.clone(),
                        relay_urls: vec![],
                        created_at: now_secs(),
                        auto_approve: false,
                        auto_reject: false,
                        auto_approve_kinds: vec![],
                        policy: "manual".to_string(),
                        custom_rules: HashMap::new(),
                        signer_pubkey: signer_pk_hex.clone(),
                    };
                    let new_conn_id = conn.id.clone();

                    // Check for existing connection/session with same name (cross-protocol reconnect)
                    let existing = find_existing_by_name(&state, &app_name, &signer_pk_hex);

                    // Save the new connection
                    {
                        let mut connections = state.connections.lock().unwrap();
                        connections.push(conn);
                    }
                    let _ = state.save_connections();

                    if let Some((existing_id, existing_source, _policy, _rules)) = existing {
                        // Prompt user: do you want to replace the old connection?
                        let pending = PendingReconnect {
                            new_connection_id: Some(new_conn_id),
                            new_session_id: None,
                            existing_id,
                            existing_source: existing_source.clone(),
                            app_name: app_name.clone(),
                        };
                        *state.pending_reconnect.lock().unwrap() = Some(pending.clone());
                        let _ = app.emit("reconnect-prompt", &pending);
                        emit_log(app, &format!("[PC55] '{}' is reconnecting (existing {} found) — awaiting user decision", app_name, existing_source));
                    }
                }
            } else {
                // Legacy mode (no pubkey): deduplicate by app_name + signer_pubkey
                let existing_conn_id = {
                    let connections = state.connections.lock().unwrap();
                    connections.iter().find(|c|
                        c.client_pubkey.starts_with("pc55:") &&
                        c.app_name == app_name &&
                        c.signer_pubkey == signer_pk_hex
                    ).map(|c| c.id.clone())
                };

                if let Some(conn_id) = existing_conn_id {
                    // Reuse existing Connection — update client_pubkey to new WebSocket UUID
                    let mut connections = state.connections.lock().unwrap();
                    if let Some(c) = connections.iter_mut().find(|c| c.id == conn_id) {
                        c.client_pubkey = conn_key.clone();
                    }
                } else {
                    // Create new Connection entry
                    let conn = Connection {
                        id: client_id.to_string(),
                        app_name: app_name.clone(),
                        app_url: None,
                        app_icon: None,
                        client_pubkey: conn_key.clone(),
                        relay_urls: vec![],
                        created_at: now_secs(),
                        auto_approve: false,
                        auto_reject: false,
                        auto_approve_kinds: vec![],
                        policy: "manual".to_string(),
                        custom_rules: HashMap::new(),
                        signer_pubkey: signer_pk_hex.clone(),
                    };
                    {
                        let mut connections = state.connections.lock().unwrap();
                        connections.push(conn);
                    }
                    let _ = state.save_connections();
                }
            }

            // Update pc55_connections for the Local Signer card
            {
                let mut pc55_conns = state.pc55_connections.lock().unwrap();
                // Remove old entries for same app (stale WebSocket connections)
                pc55_conns.retain(|c| c.app_name != app_name || c.client_id == client_id);
                if let Some(conn) = pc55_conns.iter_mut().find(|c| c.client_id == client_id) {
                    conn.app_name = app_name.clone();
                    conn.approved = true;
                }
            }

            info!("[PC55] Client connected: {} (pubkey: {:?})", app_name, client_pk_hex);
            emit_log(app, &format!("[PC55] Client connected: {}", app_name));
            emit_signer_state(app, &state);

            let response = Pc55ResponseMessage {
                id: msg_id,
                result: Some(serde_json::Value::String("ack".to_string())),
                error: None,
            };
            serde_json::to_string(&response).ok()
        }

        // NIP-46 compatible methods — route through policy-aware handler
        "get_public_key" | "sign_event" | "ping"
        | "nip04_encrypt" | "nip04_decrypt"
        | "nip44_encrypt" | "nip44_decrypt" => {
            // Guard: reject if Local Signer is toggled off
            {
                let state: tauri::State<'_, AppState> = app.state();
                if !*state.pc55_running.lock().unwrap() {
                    warn!("[PC55] Rejecting '{}' — server is stopped", method);
                    let response = Pc55ResponseMessage {
                        id: msg_id,
                        result: None,
                        error: Some("Local signer is not running".to_string()),
                    };
                    return serde_json::to_string(&response).ok();
                }
            }
            handle_nip46_method(app, client_id, client_pubkey, &msg_id, method, &params).await
        }

        _ => {
            let response = Pc55ResponseMessage {
                id: msg_id,
                result: None,
                error: Some(format!("Unknown method: {}", method)),
            };
            serde_json::to_string(&response).ok()
        }
    }
}

// --- Discovery ---

fn handle_discover(app: &AppHandle) -> DiscoverResponse {
    let state: tauri::State<'_, AppState> = app.state();
    let keypairs = state.keypairs.lock().unwrap();
    let active_pk = state.active_keypair.lock().unwrap().clone();

    // Only return the active account (not all keypairs)
    let accounts: Vec<DiscoverAccount> = if let Some(ref pk) = active_pk {
        if let Some(kp) = keypairs.iter().find(|k| &k.pubkey == pk) {
            let npub = PublicKey::from_hex(&kp.pubkey)
                .map(|pk| pk.to_bech32().unwrap_or_else(|_| kp.pubkey.clone()))
                .unwrap_or_else(|_| kp.pubkey.clone());

            vec![DiscoverAccount {
                npub,
                display_name: kp.name.clone().unwrap_or_else(|| {
                    format!("{}...{}", &kp.pubkey[..8], &kp.pubkey[kp.pubkey.len()-4..])
                }),
            }]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    DiscoverResponse {
        name: SIGNER_NAME.to_string(),
        version: SIGNER_VERSION.to_string(),
        accounts,
    }
}

// --- NIP-46 Method Router (policy-aware) ---

async fn handle_nip46_method(
    app: &AppHandle,
    client_id: &str,
    client_pubkey: &Option<String>,
    msg_id: &Option<String>,
    method: &str,
    params: &[String],
) -> Option<String> {
    let state: tauri::State<'_, AppState> = app.state();

    // Get the active signer keys
    let signer_keys = match keys::get_active_keys(&state) {
        Ok(k) => k,
        Err(e) => {
            let response = Pc55ResponseMessage {
                id: msg_id.clone(),
                result: None,
                error: Some(format!("No active keypair: {}", e)),
            };
            return serde_json::to_string(&response).ok();
        }
    };

    // Find the Connection for this client
    // Use cryptographic pubkey if available, otherwise fall back to WebSocket UUID
    let pc55_client_key = if let Some(ref pk) = client_pubkey {
        format!("pc55:{}", pk)
    } else {
        format!("pc55:{}", client_id)
    };
    let (conn_id, app_name) = {
        let connections = state.connections.lock().unwrap();
        match connections.iter().find(|c| c.client_pubkey == pc55_client_key) {
            Some(c) => (c.id.clone(), c.app_name.clone()),
            None => {
                warn!("[PC55] No connection found for client {}", client_id);
                let response = Pc55ResponseMessage {
                    id: msg_id.clone(),
                    result: None,
                    error: Some("Not connected — send 'connect' first".to_string()),
                };
                return serde_json::to_string(&response).ok();
            }
        }
    };

    // Build a NIP-46 request
    let request_id = msg_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let nip46_request = Nip46Request {
        id: request_id.clone(),
        method: method.to_string(),
        params: params.to_vec(),
    };

    // Process the request (compute the response in advance)
    let nip46_response = nip46::process_nip46_request(&signer_keys, &nip46_request);
    let response_json = match serde_json::to_string(&nip46_response) {
        Ok(j) => j,
        Err(e) => {
            error!("[PC55] Failed to serialize response: {}", e);
            let response = Pc55ResponseMessage {
                id: msg_id.clone(),
                result: None,
                error: Some(format!("Internal error: {}", e)),
            };
            return serde_json::to_string(&response).ok();
        }
    };

    // Safe metadata queries always auto-respond
    let is_safe_method = matches!(method, "ping" | "get_public_key" | "get_relays");

    // Extract kind for sign_event requests
    let event_kind: Option<u32> = if method == "sign_event" && !params.is_empty() {
        serde_json::from_str::<serde_json::Value>(&params[0])
            .ok()
            .and_then(|v| v.get("kind").and_then(|k| k.as_u64()).map(|k| k as u32))
    } else {
        None
    };

    // Check connection-level policy (same logic as NIP-46)
    let (conn_policy, custom_rule) = {
        let connections = state.connections.lock().unwrap();
        connections.iter().find(|c| c.id == conn_id)
            .map(|c| {
                let policy = c.policy.clone();
                let rule = if c.policy == "custom" {
                    if method == "sign_event" {
                        if let Some(kind) = event_kind {
                            let kind_key = format!("sign_event:{}", kind);
                            c.custom_rules.get(&kind_key).cloned()
                                .or_else(|| c.custom_rules.get(method).cloned())
                        } else {
                            c.custom_rules.get(method).cloned()
                        }
                    } else {
                        c.custom_rules.get(method).cloned()
                    }
                } else {
                    None
                };
                (policy, rule)
            })
            .unwrap_or(("manual".to_string(), None))
    };

    let raw_json = if method == "sign_event" && !params.is_empty() {
        Some(params[0].clone())
    } else { None };

    if is_safe_method || conn_policy == "auto_approve" || custom_rule.as_deref() == Some("approve") {
        // Auto-respond
        let reason = if is_safe_method { "safe method" } else { "auto-approved" };
        info!("[PC55] {} — {} from '{}'", reason, method, app_name);
        emit_log(app, &format!("[PC55] {} — {} from '{}'", reason, method, app_name));

        state.record_signing_history(SigningHistoryEntry {
            id: request_id,
            timestamp: now_secs(),
            method: method.to_string(),
            kind: event_kind,
            app_name,
            source: "pc55".to_string(),
            outcome: "auto_approved".to_string(),
            raw_event_json: raw_json,
        });

        // Return response directly
        let response = Pc55ResponseMessage {
            id: msg_id.clone(),
            result: nip46_response.result.map(|r| serde_json::Value::String(r)),
            error: nip46_response.error,
        };
        serde_json::to_string(&response).ok()

    } else if conn_policy == "auto_reject" || custom_rule.as_deref() == Some("reject") {
        // Auto-reject
        info!("[PC55] auto-rejected {} from '{}'", method, app_name);
        emit_log(app, &format!("[PC55] auto-rejected {} from '{}'", method, app_name));

        state.record_signing_history(SigningHistoryEntry {
            id: request_id,
            timestamp: now_secs(),
            method: method.to_string(),
            kind: event_kind,
            app_name,
            source: "pc55".to_string(),
            outcome: "auto_rejected".to_string(),
            raw_event_json: raw_json,
        });

        let response = Pc55ResponseMessage {
            id: msg_id.clone(),
            result: None,
            error: Some("Request auto-rejected by signer policy".to_string()),
        };
        serde_json::to_string(&response).ok()

    } else {
        // Manual approval needed — create PendingRequest and wait for user
        let params_preview = if params.is_empty() {
            "(no params)".to_string()
        } else {
            let p = &params[0];
            if p.len() > 80 { format!("{}...", &p[..80]) } else { p.clone() }
        };

        let pending = PendingRequest {
            id: request_id.clone(),
            connection_id: conn_id,
            app_name: app_name.clone(),
            method: method.to_string(),
            params_preview,
            raw_event_json: raw_json,
            event_id: uuid::Uuid::new_v4().to_string(), // No Nostr event for local
            client_pubkey: pc55_client_key,
            created_at: now_secs(),
            kind: event_kind,
            response_json: Some(response_json),
            use_nip44: false, // Not applicable for PC55
            source: "pc55".to_string(),
            upv2_session_id: None,
            upv2_nonce: None,
        };

        // Create oneshot channel for the response
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        {
            let mut channels = state.pc55_response_channels.lock().unwrap();
            channels.insert(request_id.clone(), tx);
        }
        {
            let mut pending_requests = state.pending_requests.lock().unwrap();
            pending_requests.push(pending);
        }

        info!("[PC55] Pending approval: {} from '{}'", method, app_name);
        emit_log(app, &format!("[PC55] Pending approval: {} from '{}'", method, app_name));
        emit_signer_state(app, &state);

        // Emit pending-request event for the toast UI
        let _ = app.emit("pending-request", serde_json::json!({
            "id": request_id,
            "method": method,
            "app_name": app_name,
            "source": "pc55",
        }));

        // Wait for approve/reject (the channel will be resolved by approve_request/reject_request)
        match rx.await {
            Ok(approved_json) => {
                // approved_json is the full NIP-46 response JSON
                // Parse it to extract result/error for PC55 format
                if let Ok(nip46_resp) = serde_json::from_str::<Nip46Response>(&approved_json) {
                    let response = Pc55ResponseMessage {
                        id: msg_id.clone(),
                        result: nip46_resp.result.map(|r| serde_json::Value::String(r)),
                        error: nip46_resp.error,
                    };
                    serde_json::to_string(&response).ok()
                } else {
                    // Fallback: return raw JSON as result
                    let response = Pc55ResponseMessage {
                        id: msg_id.clone(),
                        result: Some(serde_json::Value::String(approved_json)),
                        error: None,
                    };
                    serde_json::to_string(&response).ok()
                }
            }
            Err(_) => {
                // Channel dropped (e.g., server shutdown or cleanup)
                let response = Pc55ResponseMessage {
                    id: msg_id.clone(),
                    result: None,
                    error: Some("Request was cancelled".to_string()),
                };
                serde_json::to_string(&response).ok()
            }
        }
    }
}
