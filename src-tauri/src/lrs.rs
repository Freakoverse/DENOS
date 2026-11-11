//! NIP-LRS — Local Relay Signer.
//!
//! A minimal, loopback-only NIP-01 relay that carries **unmodified NIP-46** (`kind:24133`,
//! NIP-44 encrypted) between same-machine clients and this signer. It is a *request pipe*, not an
//! archive: events live in a small bounded in-memory buffer (so a `REQ` arriving just after its
//! `EVENT` still matches) and nothing is persisted across restarts.
//!
//! This module is the transport only — it has **no** signing knowledge. The signer attaches to the
//! relay like any other client (see `nip46`/`lrs` wiring), using the random **transport key**
//! ([`keys::get_transport_keys`]) as its NIP-46 identity. Discovery (the NIP-11 marker) is served
//! here, gated behind an opt-in flag; when off, the relay still works via a `bunker://` string.

use crate::keys;
use crate::state::AppState;
use futures_util::{SinkExt, StreamExt};
use nostr_sdk::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

/// Default relay port (NIP-LRS §4).
pub const LRS_DEFAULT_PORT: u16 = 7777;
/// Failover window: bind the first free port in this inclusive range.
const LRS_PORT_LO: u16 = 7777;
const LRS_PORT_HI: u16 = 7786;
/// Bounded buffer size — a request pipe, not an archive.
const MAX_EVENTS: usize = 512;
const SIGNER_NAME: &str = "DENOS";

fn emit_signer_state(app: &AppHandle, state: &AppState) {
    let _ = app.emit("signer-state", state.to_signer_payload());
}

fn emit_log(app: &AppHandle, msg: &str) {
    let _ = app.emit("log-event", msg);
}

// ───────────────────────── Relay core (shared, runtime-only) ─────────────────────────

/// A stored event: its id (for dedup) and the raw JSON object exactly as received (rebroadcast
/// verbatim). Matching reads fields straight off the JSON, so the relay is independent of any
/// nostr-sdk `Event`/`Filter` shape beyond signature verification.
struct StoredEvent {
    id: String,
    val: Value,
}

/// Bounded in-memory event store. New events evict the oldest past `MAX_EVENTS`; duplicates are
/// ignored (acked but not re-stored/re-broadcast).
#[derive(Default)]
struct EventStore {
    events: VecDeque<StoredEvent>,
    ids: std::collections::HashSet<String>,
}

impl EventStore {
    /// Returns true when the event is new (so the caller should broadcast it).
    fn add(&mut self, id: String, val: Value) -> bool {
        if !self.ids.insert(id.clone()) {
            return false;
        }
        self.events.push_back(StoredEvent { id, val });
        while self.events.len() > MAX_EVENTS {
            if let Some(old) = self.events.pop_front() {
                self.ids.remove(&old.id);
            }
        }
        true
    }

    /// Events matching any of `filters`, oldest→newest, honoring the largest `limit` among them.
    fn query(&self, filters: &[Value]) -> Vec<Value> {
        let mut out: Vec<Value> = self
            .events
            .iter()
            .filter(|e| filters.iter().any(|f| event_matches(f, &e.val)))
            .map(|e| e.val.clone())
            .collect();
        let limit = filters
            .iter()
            .filter_map(|f| f.get("limit").and_then(|v| v.as_u64()))
            .max();
        if let Some(lim) = limit {
            let lim = lim as usize;
            if out.len() > lim {
                out = out.split_off(out.len() - lim);
            }
        }
        out
    }
}

struct ConnEntry {
    tx: mpsc::UnboundedSender<Message>,
    /// subscription id → filters
    subs: HashMap<String, Vec<Value>>,
}

/// Shared relay state for one running server: the event buffer and the live connection registry.
struct RelayCore {
    events: Mutex<EventStore>,
    conns: Mutex<HashMap<u64, ConnEntry>>,
    next_conn: AtomicU64,
}

impl RelayCore {
    fn new() -> Self {
        Self {
            events: Mutex::new(EventStore::default()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
        }
    }

    fn new_conn_id(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    fn register(&self, id: u64, tx: mpsc::UnboundedSender<Message>) {
        self.conns.lock().unwrap().insert(
            id,
            ConnEntry {
                tx,
                subs: HashMap::new(),
            },
        );
    }

    fn unregister(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
    }

    fn set_sub(&self, id: u64, sub_id: String, filters: Vec<Value>) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            c.subs.insert(sub_id, filters);
        }
    }

    fn remove_sub(&self, id: u64, sub_id: &str) {
        if let Some(c) = self.conns.lock().unwrap().get_mut(&id) {
            c.subs.remove(sub_id);
        }
    }

    /// Deliver a new event to every connection whose any subscription matches it.
    fn broadcast(&self, ev: &Value) {
        let conns = self.conns.lock().unwrap();
        let mut delivered = 0usize;
        for c in conns.values() {
            for (sub_id, filters) in &c.subs {
                if filters.iter().any(|f| event_matches(f, ev)) {
                    let _ = c.tx.send(text(json!(["EVENT", sub_id, ev])));
                    delivered += 1;
                    break; // one copy per connection, even if several subs match
                }
            }
        }
        // Diagnostic: a NIP-46 event (kind 24133) that matched NO live subscription is an
        // undeliverable reply — the recipient had no open subscription at this instant (a
        // subscription close/reopen race), so it is only recoverable via buffer replay. This is the
        // signature to look for when a client reports a request answered [ok] by the signer but
        // never received.
        if delivered == 0 && ev.get("kind").and_then(|v| v.as_u64()) == Some(24133) {
            let id = ev.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let p = ev
                .get("tags")
                .and_then(|t| t.as_array())
                .and_then(|tags| {
                    tags.iter().find_map(|t| {
                        let a = t.as_array()?;
                        if a.first()?.as_str()? == "p" { a.get(1)?.as_str() } else { None }
                    })
                })
                .unwrap_or("?");
            warn!(
                "[LRS] kind24133 event {} (->p={}) matched NO open subscription — not delivered live (buffered only)",
                id,
                &p.get(..p.len().min(16)).unwrap_or(p)
            );
        }
    }
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

/// Minimal NIP-01 filter matcher — the subset NIP-46 exercises plus the common fields.
fn event_matches(filter: &Value, ev: &Value) -> bool {
    let obj = match filter.as_object() {
        Some(o) => o,
        None => return false,
    };
    for (key, cond) in obj {
        match key.as_str() {
            "ids" => {
                let id = ev.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !value_array_contains_str(cond, id) {
                    return false;
                }
            }
            "authors" => {
                let pk = ev.get("pubkey").and_then(|v| v.as_str()).unwrap_or("");
                if !value_array_contains_str(cond, pk) {
                    return false;
                }
            }
            "kinds" => {
                let k = ev.get("kind").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
                let hit = cond.as_array().map_or(false, |a| {
                    a.iter().any(|x| x.as_u64() == Some(k))
                });
                if !hit {
                    return false;
                }
            }
            "since" => {
                let ca = ev.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
                if let Some(s) = cond.as_u64() {
                    if ca < s {
                        return false;
                    }
                }
            }
            "until" => {
                let ca = ev.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
                if let Some(u) = cond.as_u64() {
                    if ca > u {
                        return false;
                    }
                }
            }
            "limit" => { /* handled by EventStore::query */ }
            _ => {
                // Tag filters: "#p", "#e", "#<x>" → event must carry a matching tag value.
                if let Some(letter) = key.strip_prefix('#') {
                    if !tag_matches(ev, letter, cond) {
                        return false;
                    }
                }
                // Unknown non-tag keys are ignored (treated as unconstrained).
            }
        }
    }
    true
}

fn value_array_contains_str(arr: &Value, needle: &str) -> bool {
    arr.as_array()
        .map_or(false, |a| a.iter().any(|x| x.as_str() == Some(needle)))
}

fn tag_matches(ev: &Value, letter: &str, wanted: &Value) -> bool {
    let tags = match ev.get("tags").and_then(|v| v.as_array()) {
        Some(t) => t,
        None => return false,
    };
    tags.iter().any(|t| {
        let arr = match t.as_array() {
            Some(a) => a,
            None => return false,
        };
        if arr.first().and_then(|v| v.as_str()) != Some(letter) {
            return false;
        }
        let val = arr.get(1).and_then(|v| v.as_str()).unwrap_or("");
        value_array_contains_str(wanted, val)
    })
}

// ───────────────────────────── Tauri commands ─────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct LrsStatePayload {
    pub running: bool,
    pub port: u16,
    pub transport_pubkey: Option<String>,
}

#[tauri::command]
pub fn get_lrs_state(state: State<'_, AppState>) -> LrsStatePayload {
    // Only derive the transport key when a profile is unlocked (it is profile-scoped and
    // generate-on-first-use); avoids a panic if the UI probes before unlock.
    let transport_pubkey = if state.active_profile.lock().unwrap().is_some() {
        keys::get_transport_keys(&state).ok().map(|k| k.public_key().to_hex())
    } else {
        None
    };
    LrsStatePayload {
        running: *state.lrs_running.lock().unwrap(),
        port: *state.lrs_port.lock().unwrap(),
        transport_pubkey,
    }
}

#[tauri::command]
pub async fn start_lrs_server(app: AppHandle) -> Result<(), String> {
    start_lrs_internal(&app).await
}

/// Start the relay + signer loop, reading state from `app`. Callable internally (e.g. on account
/// switch) as well as from the Tauri command.
pub async fn start_lrs_internal(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    let state: State<'_, AppState> = app.state();

    // Claim the running slot synchronously, before any `.await`, so a concurrent call — e.g. React
    // StrictMode firing the auto-start effect twice in dev — is rejected instead of starting a
    // second relay on the same port. Any setup error below must release the slot.
    {
        let mut running = state.lrs_running.lock().unwrap();
        if *running {
            return Err("Local relay is already running".to_string());
        }
        *running = true;
    }

    // Ensure the transport key exists before we advertise it.
    let transport_keys = match keys::get_transport_keys(&state) {
        Ok(k) => k,
        Err(e) => {
            *state.lrs_running.lock().unwrap() = false;
            return Err(e);
        }
    };
    let transport_pubkey = transport_keys.public_key().to_hex();

    // The account we sign as. LRS needs an unlocked, selected account.
    let account_keys = match keys::get_active_keys(&state) {
        Ok(k) => k,
        Err(_) => {
            *state.lrs_running.lock().unwrap() = false;
            return Err(
                "No active account — unlock and select a key before starting the local relay"
                    .to_string(),
            );
        }
    };

    // Choose a port: prefer the last-used one, then scan the failover window.
    let preferred = *state.lrs_port.lock().unwrap();
    let (listener, port) = match bind_with_failover(preferred).await {
        Ok(v) => v,
        Err(e) => {
            *state.lrs_running.lock().unwrap() = false;
            return Err(e);
        }
    };
    {
        *state.lrs_port.lock().unwrap() = port;
    }
    let _ = state.save_lrs_port(port);

    let (shutdown_tx, _) = broadcast::channel::<()>(8);
    {
        *state.lrs_shutdown.lock().unwrap() = Some(shutdown_tx.clone());
    }

    info!("[LRS] Listening on ws://127.0.0.1:{} (transport {}…)", port, &transport_pubkey[..transport_pubkey.len().min(8)]);
    emit_log(&app, &format!("[INFO] Local Relay Signer on ws://127.0.0.1:{}", port));
    emit_signer_state(&app, &state);

    // Subscribe the signer loop's shutdown receiver BEFORE the accept loop takes ownership of
    // shutdown_tx, so stop_lrs_server's single broadcast reaches both.
    let signer_shutdown = shutdown_tx.subscribe();
    let relay_url = format!("ws://127.0.0.1:{}", port);

    let core = Arc::new(RelayCore::new());
    let app_handle = app.clone();
    tokio::spawn(async move {
        run_accept_loop(app_handle.clone(), core, listener, shutdown_tx).await;
        // Mark stopped if no restart superseded us.
        let state: tauri::State<'_, AppState> = app_handle.state();
        if state.lrs_shutdown.lock().unwrap().is_none() {
            *state.lrs_running.lock().unwrap() = false;
            emit_signer_state(&app_handle, &state);
        }
    });

    // Attach the signer to the relay: transport identity on the wire, signs as the active account.
    let app_signer = app.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::nip46::run_lrs_signer_loop(
            app_signer,
            transport_keys,
            account_keys,
            relay_url,
            signer_shutdown,
        )
        .await
        {
            error!("[LRS] signer loop error: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_lrs_server(app: AppHandle) -> Result<(), String> {
    stop_lrs_internal(&app).await;
    Ok(())
}

/// Stop the relay + signer loop. Callable internally as well as from the Tauri command.
pub async fn stop_lrs_internal(app: &AppHandle) {
    let app = app.clone();
    let state: State<'_, AppState> = app.state();
    let tx = { state.lrs_shutdown.lock().unwrap().take() };
    if let Some(tx) = tx {
        let _ = tx.send(()); // wakes the accept loop and every live connection
    }
    *state.lrs_running.lock().unwrap() = false;
    info!("[LRS] Stopped");
    emit_log(&app, "[INFO] Local Relay Signer stopped");
    emit_signer_state(&app, &state);
}

/// Restart the relay so its signer loop picks up the newly-active account. Called when the user
/// switches the active keypair: the loop captures the account key at start, so without this it
/// would keep signing as the previous account. No-op if the relay isn't running.
pub async fn restart_for_account_change(app: &AppHandle) {
    let app = app.clone();
    let running = {
        let state: State<'_, AppState> = app.state();
        let r = *state.lrs_running.lock().unwrap();
        r
    };
    if !running {
        return;
    }
    info!("[LRS] Restarting for account switch");
    stop_lrs_internal(&app).await;
    // Let the old listener drop so we re-bind the same port rather than failing over.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    if let Err(e) = start_lrs_internal(&app).await {
        warn!("[LRS] restart after account switch failed: {}", e);
    }
}

// ───────────────────────────── Server internals ─────────────────────────────

/// Bind the first free port: try `preferred` first (when in range), then scan 7777–7786.
async fn bind_with_failover(preferred: u16) -> Result<(tokio::net::TcpListener, u16), String> {
    let mut order: Vec<u16> = Vec::new();
    if (LRS_PORT_LO..=LRS_PORT_HI).contains(&preferred) {
        order.push(preferred);
    }
    for p in LRS_PORT_LO..=LRS_PORT_HI {
        if !order.contains(&p) {
            order.push(p);
        }
    }

    let mut last_err = String::from("no port tried");
    for p in order {
        match try_bind(p) {
            Ok(l) => return Ok((l, p)),
            Err(e) => last_err = e,
        }
    }
    Err(format!(
        "No free port in {}–{} for the local relay: {}",
        LRS_PORT_LO, LRS_PORT_HI, last_err
    ))
}

fn try_bind(port: u16) -> Result<tokio::net::TcpListener, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let socket = tokio::net::TcpSocket::new_v4().map_err(|e| format!("socket: {}", e))?;
    socket
        .set_reuseaddr(true)
        .map_err(|e| format!("reuseaddr: {}", e))?;
    socket.bind(addr).map_err(|e| format!("bind {}: {}", port, e))?;
    socket.listen(128).map_err(|e| format!("listen {}: {}", port, e))
}

async fn run_accept_loop(
    app: AppHandle,
    core: Arc<RelayCore>,
    listener: tokio::net::TcpListener,
    shutdown_tx: broadcast::Sender<()>,
) {
    let mut srx = shutdown_tx.subscribe();
    loop {
        tokio::select! {
            _ = srx.recv() => {
                info!("[LRS] Accept loop shutting down");
                break;
            }
            res = listener.accept() => {
                match res {
                    Ok((stream, peer)) => {
                        let app_c = app.clone();
                        let core_c = core.clone();
                        let conn_shutdown = shutdown_tx.subscribe();
                        tokio::spawn(async move {
                            if let Err(e) = handle_conn(app_c, core_c, stream, peer, conn_shutdown).await {
                                warn!("[LRS] conn {} error: {}", peer, e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("[LRS] accept error: {}", e);
                    }
                }
            }
        }
    }
    // Dropping the listener here stops new connections; live ones observed the shutdown signal.
}

async fn handle_conn(
    app: AppHandle,
    core: Arc<RelayCore>,
    mut stream: TcpStream,
    _peer: SocketAddr,
    shutdown_rx: broadcast::Receiver<()>,
) -> Result<(), String> {
    // Peek (without consuming) to route: OPTIONS preflight, plain GET (NIP-11), or WS upgrade.
    let mut buf = [0u8; 2048];
    let n = stream.peek(&mut buf).await.map_err(|e| format!("peek: {}", e))?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");
    let is_options = first_line.starts_with("OPTIONS");
    let is_upgrade = head.to_ascii_lowercase().contains("upgrade: websocket");

    if is_options || !is_upgrade {
        // Drain the request off the socket before responding. Closing a socket that still has
        // unread bytes in its receive buffer makes the OS send a TCP RST instead of a clean FIN —
        // which browsers surface as ERR_CONNECTION_RESET (a timing race, ~40% under a burst of
        // probes). We only peeked for routing, so the request is still buffered; GET/OPTIONS have
        // no body, so read to the end of the headers. (The WS path must NOT drain — the handshake
        // reader needs those bytes.)
        drain_http_request(&mut stream).await;
    }

    if is_options {
        return write_preflight(&mut stream).await;
    }
    if !is_upgrade {
        // NIP-11 relay information document (or a plain probe). Compute the body in a scope so the
        // borrowed `State` is dropped before the write `.await`.
        let body = {
            let s: State<'_, AppState> = app.state();
            let transport_pubkey = keys::get_transport_keys(&s)
                .ok()
                .map(|k| k.public_key().to_hex());
            info_doc(transport_pubkey.as_deref())
        };
        return write_info_doc(&mut stream, &body).await;
    }

    // Capture the browser Origin (if any) from the handshake so the connection can be named after
    // the web app. Parsed from the bytes we peeked for routing.
    let origin = parse_origin(&head);

    // WebSocket upgrade: let tokio-tungstenite do the handshake, injecting CORS/PNA headers so
    // browser clients on public origins can reach loopback.
    let ws = tokio_tungstenite::accept_hdr_async(stream, add_cors_headers)
        .await
        .map_err(|e| format!("ws handshake: {}", e))?;

    let conn_id = core.new_conn_id();
    relay_session(app, core, ws, conn_id, origin, shutdown_rx).await;
    Ok(())
}

/// Extract the `Origin` header value from a peeked HTTP request head, if present and meaningful.
fn parse_origin(head: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let mut parts = line.splitn(2, ':');
        let name = parts.next()?.trim();
        if name.eq_ignore_ascii_case("origin") {
            let val = parts.next()?.trim();
            if val.is_empty() || val == "null" {
                None
            } else {
                Some(val.to_string())
            }
        } else {
            None
        }
    })
}

/// Callback for `accept_hdr_async`: add the headers a browser needs to accept the 101 upgrade.
fn add_cors_headers(_req: &Request, mut response: Response) -> Result<Response, ErrorResponse> {
    let h = response.headers_mut();
    h.insert(
        HeaderName::from_static("access-control-allow-origin"),
        HeaderValue::from_static("*"),
    );
    h.insert(
        HeaderName::from_static("access-control-allow-private-network"),
        HeaderValue::from_static("true"),
    );
    Ok(response)
}

fn info_doc(transport_pubkey: Option<&str>) -> String {
    // The signer is discoverable whenever the relay is running: the info doc always carries the
    // LRS marker so a NIP-46 client can find it with one click. (No transport key only in the
    // unreachable pre-unlock case — fall back to a plain relay doc.)
    if let Some(pk) = transport_pubkey {
        return json!({
            "name": SIGNER_NAME,
            "local_relay_signer": { "v": 1, "transport_pubkey": pk }
        })
        .to_string();
    }
    json!({ "name": SIGNER_NAME }).to_string()
}

async fn write_info_doc(stream: &mut TcpStream, body: &str) -> Result<(), String> {
    let resp = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: application/nostr+json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Connection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| format!("write info: {}", e))?;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await; // clean FIN on the write half before the socket drops
    Ok(())
}

/// Read and discard an HTTP request's head (up to the blank line). GET/OPTIONS carry no body, so
/// this empties the receive buffer; closing afterwards yields a clean FIN rather than an RST.
async fn drain_http_request(stream: &mut TcpStream) {
    let mut buf = [0u8; 1024];
    let mut acc: Vec<u8> = Vec::new();
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(m) => {
                acc.extend_from_slice(&buf[..m]);
                if acc.windows(4).any(|w| w == b"\r\n\r\n") {
                    break; // end of headers
                }
                if acc.len() > 16384 {
                    break; // cap — don't read an unbounded amount
                }
            }
            Err(_) => break,
        }
    }
}

async fn write_preflight(stream: &mut TcpStream) -> Result<(), String> {
    let resp = "HTTP/1.1 204 No Content\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Access-Control-Max-Age: 86400\r\n\
         Connection: close\r\n\r\n";
    stream
        .write_all(resp.as_bytes())
        .await
        .map_err(|e| format!("write preflight: {}", e))?;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await; // clean FIN on the write half before the socket drops
    Ok(())
}

async fn relay_session(
    app: AppHandle,
    core: Arc<RelayCore>,
    ws: tokio_tungstenite::WebSocketStream<TcpStream>,
    conn_id: u64,
    origin: Option<String>,
    mut shutdown_rx: broadcast::Receiver<()>,
) {
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    core.register(conn_id, out_tx.clone());
    info!("[LRS] conn {} opened{}", conn_id, origin.as_deref().map(|o| format!(" (origin {})", o)).unwrap_or_default());

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                let _ = sink.send(Message::Close(None)).await;
                break;
            }
            outbound = out_rx.recv() => {
                match outbound {
                    Some(msg) => {
                        // Diagnostic: confirm ACTUAL ws transmission of a NIP-46 response (kind
                        // 24133) to THIS connection, with its event id. Distinguishes "relay sent it
                        // on the live conn" from "enqueued to a stale conn" / "never sent".
                        let resp_id = match &msg {
                            Message::Text(t) if t.contains("\"kind\":24133") => {
                                serde_json::from_str::<Value>(t).ok().and_then(|v| {
                                    v.get(2)
                                        .and_then(|e| e.get("id"))
                                        .and_then(|i| i.as_str())
                                        .map(|s| s[..s.len().min(12)].to_string())
                                })
                            }
                            _ => None,
                        };
                        if sink.send(msg).await.is_err() { break; }
                        if let Some(id) = resp_id {
                            info!("[LRS] conn {} -> ws: delivered kind24133 {}", conn_id, id);
                        }
                    }
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => handle_client_text(&app, &core, conn_id, &out_tx, origin.as_deref(), t.as_str()),
                    Some(Ok(Message::Ping(p))) => { let _ = out_tx.send(Message::Pong(p)); }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => { /* ignore binary/pong */ }
                    Some(Err(_)) => break,
                }
            }
        }
    }

    core.unregister(conn_id);
    info!("[LRS] conn {} closed", conn_id);
}

/// Handle one NIP-01 client frame. Responses to the requesting client go through its own channel
/// (`own_tx`); an accepted EVENT is also broadcast to every other matching subscription.
fn handle_client_text(
    app: &AppHandle,
    core: &Arc<RelayCore>,
    conn_id: u64,
    own_tx: &mpsc::UnboundedSender<Message>,
    origin: Option<&str>,
    raw: &str,
) {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => {
            let _ = own_tx.send(text(json!(["NOTICE", "invalid json"])));
            return;
        }
    };
    let arr = match parsed.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => {
            let _ = own_tx.send(text(json!(["NOTICE", "expected a non-empty array"])));
            return;
        }
    };

    match arr[0].as_str() {
        Some("EVENT") => {
            let ev = match arr.get(1) {
                Some(e) => e.clone(),
                None => {
                    let _ = own_tx.send(text(json!(["NOTICE", "EVENT missing event"])));
                    return;
                }
            };
            let id = ev.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

            // Verify the signature (NIP-LRS §3 MUST). Invalid events are rejected, not stored.
            let verified = Event::from_json(ev.to_string())
                .map(|e| e.verify().is_ok())
                .unwrap_or(false);
            if !verified {
                let _ = own_tx.send(text(json!(["OK", id, false, "invalid: bad signature"])));
                return;
            }

            // Record this client's Origin (if any) so the signer loop can name the connection after
            // the web app. The event author is the client's pubkey.
            if let Some(o) = origin {
                if let Some(pk) = ev.get("pubkey").and_then(|v| v.as_str()) {
                    let state: State<'_, AppState> = app.state();
                    state.lrs_client_origins.lock().unwrap().insert(pk.to_string(), o.to_string());
                }
            }

            let is_new = core.events.lock().unwrap().add(id.clone(), ev.clone());
            let _ = own_tx.send(text(json!(["OK", id, true, ""])));
            if is_new {
                core.broadcast(&ev);
            } else {
                // Duplicate event id: acked but NOT re-broadcast. For a request-pipe this means a
                // re-sent REQUEST is silently not re-delivered to the signer (→ the client waits out
                // its timeout). Logged so we can tell this apart from a response-delivery loss.
                warn!("[LRS] duplicate event {} — acked, NOT re-broadcast", id);
            }
        }
        Some("REQ") => {
            let sub_id = match arr.get(1).and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    let _ = own_tx.send(text(json!(["NOTICE", "REQ missing subscription id"])));
                    return;
                }
            };
            let filters: Vec<Value> = arr[2..].to_vec();
            // Replay matching buffered events, then EOSE, then keep the subscription live.
            let matches = core.events.lock().unwrap().query(&filters);
            for ev in matches {
                let _ = own_tx.send(text(json!(["EVENT", sub_id, ev])));
            }
            let _ = own_tx.send(text(json!(["EOSE", sub_id])));
            info!("[LRS] conn {} REQ sub {} ({} filter(s))", conn_id, sub_id, filters.len());
            core.set_sub(conn_id, sub_id, filters);
        }
        Some("CLOSE") => {
            if let Some(sub_id) = arr.get(1).and_then(|v| v.as_str()) {
                info!("[LRS] conn {} CLOSE sub {}", conn_id, sub_id);
                core.remove_sub(conn_id, sub_id);
            }
        }
        _ => {
            let _ = own_tx.send(text(json!(["NOTICE", "unsupported message"])));
        }
    }
}
