use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use nostr_sdk::Client;

/// Keypair metadata (public info only — private keys stay in OS keychain)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeypairInfo {
    pub pubkey: String,
    pub npub: String,
    pub name: Option<String>,
    /// If derived from a seed, the seed's ID
    #[serde(default)]
    pub seed_id: Option<String>,
    /// NIP-06 account index used to derive this keypair from its seed
    #[serde(default)]
    pub account_index: Option<u32>,
}

/// Master seed metadata (mnemonic stored separately in OS keychain as "seed-{id}")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedInfo {
    pub id: String,
    pub name: String,
    /// Pubkeys of keypairs derived from this seed
    pub keypair_pubkeys: Vec<String>,
}

/// NIP-46 connection to a client app
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub app_name: String,
    pub app_url: Option<String>,
    pub app_icon: Option<String>,
    pub client_pubkey: String,
    pub relay_urls: Vec<String>,
    pub created_at: u64,
    pub auto_approve: bool,
    #[serde(default)]
    pub auto_reject: bool,
    pub auto_approve_kinds: Vec<u16>,
    /// Explicit policy: "manual", "custom", "auto_approve", "auto_reject"
    #[serde(default = "default_policy")]
    pub policy: String,
    /// Per-method rules for "custom" policy: method -> "approve" | "reject"
    /// Methods not listed fall through to manual approval
    #[serde(default)]
    pub custom_rules: HashMap<String, String>,
    /// Which signer keypair this connection belongs to (pubkey hex)
    #[serde(default)]
    pub signer_pubkey: String,
}

fn default_policy() -> String {
    "manual".to_string()
}

fn default_source() -> String {
    "nip46".to_string()
}

/// A recorded signing request outcome for the signing history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SigningHistoryEntry {
    pub id: String,
    pub timestamp: u64,
    pub method: String,
    #[serde(default)]
    pub kind: Option<u32>,
    pub app_name: String,
    /// "nip46" or "upv2"
    pub source: String,
    /// "approved", "rejected", "auto_approved", "auto_rejected"
    pub outcome: String,
    /// Full unsigned event JSON (for sign_event requests)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_event_json: Option<String>,
}

/// Pending signing request from a client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRequest {
    pub id: String,
    pub connection_id: String,
    pub app_name: String,
    pub method: String,
    pub params_preview: String,
    /// Full unsigned event JSON for sign_event requests (for UI inspection)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_event_json: Option<String>,
    pub event_id: String,
    pub client_pubkey: String,
    pub created_at: u64,
    /// Event kind (for sign_event requests)
    #[serde(default)]
    pub kind: Option<u32>,
    /// Pre-computed approved response JSON (so approve can send it)
    #[serde(default)]
    pub response_json: Option<String>,
    /// Whether to encrypt the response with NIP-44 (vs NIP-04)
    #[serde(default)]
    pub use_nip44: bool,
    /// "nip46" or "upv2" — determines how approve/reject sends the response
    #[serde(default = "default_source")]
    pub source: String,
    /// UPV2 only: session_id for response event tags
    #[serde(default)]
    pub upv2_session_id: Option<String>,
    /// UPV2 only: client-provided nonce for request-response matching
    #[serde(default)]
    pub upv2_nonce: Option<String>,
}

// --- NIP-UPV2 Structs ---

/// UPV2 config: derived login key from password + npub
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upv2LoginKey {
    /// Derived public key hex (from HKDF(password, npub || "NIP-UPV2"))
    pub login_pk: String,
    /// First 8 hex chars for display
    pub fingerprint: String,
    /// Whether UPV2 is enabled
    pub enabled: bool,
    pub created_at: u64,
}

/// Active NIP-UPV2 session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upv2Session {
    pub session_id: String,
    pub login_pk: String,
    pub client_name: String,
    pub instance_id: String,
    pub created_at: u64,
    pub last_active: u64,
    /// Approval policy: "manual", "auto_approve", "auto_reject", "custom"
    #[serde(default = "default_policy")]
    pub policy: String,
    /// Per-method rules for "custom" policy: method -> "approve" | "reject"
    #[serde(default)]
    pub custom_rules: HashMap<String, String>,
    /// Which signer keypair this session belongs to (pubkey hex)
    #[serde(default)]
    pub signer_pubkey: String,
}

/// Pending challenge nonce (short-lived)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Upv2Challenge {
    pub nonce: String,
    pub session_id: String,
    pub login_pk: String,
    pub expires_at: u64,
}

/// Login attempt record — tracks both live and offline-missed attempts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginAttempt {
    pub id: String,
    pub event_id: String,
    pub login_pk: String,
    pub timestamp: u64,
    pub client_name: Option<String>,
    pub instance_id: Option<String>,
    /// "processed" or "offline_missed"
    pub status: String,
    pub dismissed: bool,
}

/// A pending reconnection waiting for user decision
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingReconnect {
    /// ID of the newly created connection (already saved)
    pub new_connection_id: Option<String>,
    pub new_session_id: Option<String>,
    /// ID of existing connection to potentially replace
    pub existing_id: String,
    /// Source of existing: "nip46" or "upv2"
    pub existing_source: String,
    /// Name of the connecting app
    pub app_name: String,
}

/// Relay status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayInfo {
    pub url: String,
    pub connected: bool,
}

/// NIP-PC55 local WebSocket connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pc55Connection {
    pub client_id: String,
    pub app_name: String,
    pub approved: bool,
    pub connected_at: u64,
}


/// Full app state payload sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStatePayload {
    pub keypairs: Vec<KeypairInfo>,
    pub active_keypair: Option<String>,
    pub seeds: Vec<SeedInfo>,
    pub active_seed: Option<String>,
    pub initialized: bool,
    pub pin_set: bool,
    pub lock_timeout_minutes: u32,
}

/// Signer state payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignerStatePayload {
    pub running: bool,
    pub connections: Vec<Connection>,
    pub pending_requests: Vec<PendingRequest>,
    pub relays: Vec<RelayInfo>,
    pub user_relays: Vec<RelayInfo>,
    pub nip46_enabled: bool,
    // NIP-UPV2
    pub upv2_login_key: Option<Upv2LoginKey>,
    pub upv2_sessions: Vec<Upv2Session>,
    pub login_attempts: Vec<LoginAttempt>,
    // NIP-PC55
    pub pc55_running: bool,
    pub pc55_connections: Vec<Pc55Connection>,
}

/// Central app state
pub struct AppState {
    pub keypairs: Mutex<Vec<KeypairInfo>>,
    pub active_keypair: Mutex<Option<String>>,
    pub seeds: Mutex<Vec<SeedInfo>>,
    pub active_seed: Mutex<Option<String>>,
    pub connections: Mutex<Vec<Connection>>,
    pub pending_requests: Mutex<Vec<PendingRequest>>,
    pub signer_running: Mutex<bool>,
    pub relay_urls: Mutex<Vec<String>>,
    pub signer_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Client from the running signer loop — shared for approve/reject
    pub signer_client: Mutex<Option<Client>>,
    // NIP-UPV2 — keyed by pubkey hex so each keypair has its own password
    pub upv2_login_key: Mutex<HashMap<String, Upv2LoginKey>>,
    pub upv2_sessions: Mutex<Vec<Upv2Session>>,
    pub upv2_challenges: Mutex<Vec<Upv2Challenge>>,
    pub login_attempts: Mutex<Vec<LoginAttempt>>,
    pub last_online_at: Mutex<HashMap<String, u64>>,
    /// Pending reconnection awaiting user decision
    pub pending_reconnect: Mutex<Option<PendingReconnect>>,
    /// URLs of relays that are currently connected
    pub connected_relays: Mutex<HashSet<String>>,
    // PIN lock
    pub pin_hash: Mutex<Option<String>>,
    pub lock_timeout_minutes: Mutex<u32>,
    // NIP-46 global toggle
    pub nip46_enabled: Mutex<bool>,
    // Signing history — latest 100 outcomes
    pub signing_history: Mutex<Vec<SigningHistoryEntry>>,
    // NIP-65 user relay list — keyed by pubkey hex
    pub user_relay_urls: Mutex<HashMap<String, Vec<String>>>,
    // NIP-PC55 local WebSocket signer
    pub pc55_running: Mutex<bool>,
    pub pc55_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub pc55_connections: Mutex<Vec<Pc55Connection>>,
    /// Channels for delivering approve/reject responses back to PC55 WebSocket handlers
    pub pc55_response_channels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
}

const SERVICE_NAME: &str = "denos-signer";
const KEYPAIRS_INDEX_KEY: &str = "denos-keypairs-index";
const SEEDS_INDEX_KEY: &str = "denos-seeds-index";
const CONNECTIONS_KEY: &str = "denos-connections";
const RELAYS_KEY: &str = "denos-relays";
const UPV2_LOGIN_KEY: &str = "denos-upv2-login-key";
const UPV2_SESSIONS_KEY: &str = "denos-upv2-sessions";
const LOGIN_ATTEMPTS_KEY: &str = "denos-login-attempts";
const LAST_ONLINE_KEY: &str = "denos-last-online-at";
pub const PIN_HASH_KEY: &str = "denos-pin-hash";
pub const LOCK_TIMEOUT_KEY: &str = "denos-lock-timeout";
pub const ACTIVE_KEYPAIR_KEY: &str = "denos-active-keypair";
pub const ACTIVE_SEED_KEY: &str = "denos-active-seed";
const NIP46_ENABLED_KEY: &str = "denos-nip46-enabled";
const SIGNING_HISTORY_KEY: &str = "denos-signing-history";
const USER_RELAYS_KEY: &str = "denos-user-relays";

impl AppState {
    pub fn new() -> Self {
        // Load keypairs: try per-item format first, then legacy single-blob
        let keypairs = {
            let pubkeys = load_from_keyring::<Vec<String>>(KEYPAIRS_INDEX_KEY)
                .unwrap_or_default();
            if !pubkeys.is_empty() {
                // Per-item format: index has pubkey strings, each item in its own entry
                pubkeys.iter()
                    .filter_map(|pk| load_from_keyring::<KeypairInfo>(&format!("kp-{}", pk)))
                    .collect::<Vec<_>>()
            } else {
                // Legacy fallback: try loading as Vec<KeypairInfo> blob
                load_from_keyring::<Vec<KeypairInfo>>(KEYPAIRS_INDEX_KEY)
                    .unwrap_or_default()
            }
        };
        // Load seeds: same pattern
        let seeds = {
            let seed_ids = load_from_keyring::<Vec<String>>(SEEDS_INDEX_KEY)
                .unwrap_or_default();
            if !seed_ids.is_empty() {
                seed_ids.iter()
                    .filter_map(|id| load_from_keyring::<SeedInfo>(&format!("seed-info-{}", id)))
                    .collect::<Vec<_>>()
            } else {
                load_from_keyring::<Vec<SeedInfo>>(SEEDS_INDEX_KEY)
                    .unwrap_or_default()
            }
        };
        // Load connections: same pattern
        let connections = {
            let conn_ids = load_from_keyring::<Vec<String>>(CONNECTIONS_KEY)
                .unwrap_or_default();
            if !conn_ids.is_empty() {
                conn_ids.iter()
                    .filter_map(|id| load_from_keyring::<Connection>(&format!("conn-{}", id)))
                    .collect::<Vec<_>>()
            } else {
                load_from_keyring::<Vec<Connection>>(CONNECTIONS_KEY)
                    .unwrap_or_default()
            }
        };
        let relay_urls = load_from_keyring::<Vec<String>>(RELAYS_KEY)
            .unwrap_or_else(|| vec![
                "wss://relay.damus.io".to_string(),
                "wss://relay.primal.net".to_string(),
                "wss://nos.lol".to_string(),
            ]);
        // Load per-keypair UPV2 login keys (new format: HashMap)
        // Backward compat: migrate from old single-key format
        let upv2_login_keys: HashMap<String, Upv2LoginKey> = {
            if let Some(map) = load_from_keyring::<HashMap<String, Upv2LoginKey>>(UPV2_LOGIN_KEY) {
                map
            } else if let Some(old_key) = load_from_keyring::<Upv2LoginKey>(UPV2_LOGIN_KEY) {
                // Legacy migration: associate the old key with the first keypair
                let mut map = HashMap::new();
                if let Some(first_pk) = keypairs.first().map(|kp| kp.pubkey.clone()) {
                    map.insert(first_pk, old_key);
                }
                // Save migrated format immediately
                let _ = save_to_keyring(UPV2_LOGIN_KEY, &map);
                map
            } else {
                HashMap::new()
            }
        };
        let upv2_sessions = {
            let sess_ids = load_from_keyring::<Vec<String>>(UPV2_SESSIONS_KEY)
                .unwrap_or_default();
            if !sess_ids.is_empty() {
                sess_ids.iter()
                    .filter_map(|id| load_from_keyring::<Upv2Session>(&format!("upv2-sess-{}", id)))
                    .collect::<Vec<_>>()
            } else {
                load_from_keyring::<Vec<Upv2Session>>(UPV2_SESSIONS_KEY)
                    .unwrap_or_default()
            }
        };
        let login_attempts = {
            let attempt_ids = load_from_keyring::<Vec<String>>(LOGIN_ATTEMPTS_KEY)
                .unwrap_or_default();
            if !attempt_ids.is_empty() {
                attempt_ids.iter()
                    .filter_map(|id| load_from_keyring::<LoginAttempt>(&format!("login-attempt-{}", id)))
                    .collect::<Vec<_>>()
            } else {
                load_from_keyring::<Vec<LoginAttempt>>(LOGIN_ATTEMPTS_KEY)
                    .unwrap_or_default()
            }
        };
        let last_online_at: HashMap<String, u64> = {
            if let Some(map) = load_from_keyring::<HashMap<String, u64>>(LAST_ONLINE_KEY) {
                map
            } else if let Some(old_ts) = load_from_keyring::<u64>(LAST_ONLINE_KEY) {
                // Legacy migration: associate the old timestamp with the first keypair
                let mut map = HashMap::new();
                if let Some(first_pk) = keypairs.first().map(|kp| kp.pubkey.clone()) {
                    map.insert(first_pk, old_ts);
                }
                let _ = save_to_keyring(LAST_ONLINE_KEY, &map);
                map
            } else {
                HashMap::new()
            }
        };
        let pin_hash = get_raw_from_keyring(PIN_HASH_KEY).ok();
        let lock_timeout_minutes = load_from_keyring::<u32>(LOCK_TIMEOUT_KEY)
            .unwrap_or(5);

        // Load persisted active keypair; fall back to first keypair if missing
        let active = load_from_keyring::<String>(ACTIVE_KEYPAIR_KEY)
            .filter(|pk| keypairs.iter().any(|kp| kp.pubkey == *pk))
            .or_else(|| keypairs.first().map(|kp| kp.pubkey.clone()));
        // Load persisted active seed; fall back to first seed if missing
        let active_seed = load_from_keyring::<String>(ACTIVE_SEED_KEY)
            .filter(|sid| seeds.iter().any(|s| s.id == *sid))
            .or_else(|| seeds.first().map(|s| s.id.clone()));

        Self {
            keypairs: Mutex::new(keypairs),
            active_keypair: Mutex::new(active),
            seeds: Mutex::new(seeds),
            active_seed: Mutex::new(active_seed),
            connections: Mutex::new(connections),
            pending_requests: Mutex::new(Vec::new()),
            signer_running: Mutex::new(false),
            relay_urls: Mutex::new(relay_urls),
            signer_shutdown: Mutex::new(None),
            signer_client: Mutex::new(None),
            upv2_login_key: Mutex::new(upv2_login_keys),
            upv2_sessions: Mutex::new(upv2_sessions),
            upv2_challenges: Mutex::new(Vec::new()),
            login_attempts: Mutex::new(login_attempts),
            last_online_at: Mutex::new(last_online_at),
            pending_reconnect: Mutex::new(None),
            connected_relays: Mutex::new(HashSet::new()),
            pin_hash: Mutex::new(pin_hash),
            lock_timeout_minutes: Mutex::new(lock_timeout_minutes),
            nip46_enabled: Mutex::new(
                load_from_keyring::<bool>(NIP46_ENABLED_KEY).unwrap_or(true)
            ),
            signing_history: Mutex::new(
                load_from_keyring::<Vec<SigningHistoryEntry>>(SIGNING_HISTORY_KEY).unwrap_or_default()
            ),
            user_relay_urls: Mutex::new(
                load_from_keyring::<HashMap<String, Vec<String>>>(USER_RELAYS_KEY).unwrap_or_default()
            ),
            pc55_running: Mutex::new(false),
            pc55_shutdown: Mutex::new(None),
            pc55_connections: Mutex::new(Vec::new()),
            pc55_response_channels: Mutex::new(HashMap::new()),
        }
    }

    pub fn keypair_count(&self) -> usize {
        self.keypairs.lock().unwrap().len()
    }

    pub fn to_app_payload(&self) -> AppStatePayload {
        AppStatePayload {
            keypairs: self.keypairs.lock().unwrap().clone(),
            active_keypair: self.active_keypair.lock().unwrap().clone(),
            seeds: self.seeds.lock().unwrap().clone(),
            active_seed: self.active_seed.lock().unwrap().clone(),
            initialized: true,
            pin_set: self.pin_hash.lock().unwrap().is_some(),
            lock_timeout_minutes: *self.lock_timeout_minutes.lock().unwrap(),
        }
    }

    pub fn to_signer_payload(&self) -> SignerStatePayload {
        let connected = self.connected_relays.lock().unwrap();
        let relay_urls = self.relay_urls.lock().unwrap();
        let relays: Vec<RelayInfo> = relay_urls.iter().map(|url| {
            RelayInfo { url: url.clone(), connected: connected.contains(url) }
        }).collect();

        SignerStatePayload {
            running: *self.signer_running.lock().unwrap(),
            connections: {
                let active = self.active_keypair.lock().unwrap().clone();
                let all = self.connections.lock().unwrap();
                match &active {
                    Some(pk) => all.iter()
                        .filter(|c| c.signer_pubkey == *pk)
                        .cloned().collect(),
                    None => all.clone(),
                }
            },
            pending_requests: self.pending_requests.lock().unwrap().clone(),
            relays,
            user_relays: {
                let active = self.active_keypair.lock().unwrap();
                let ur = self.user_relay_urls.lock().unwrap();
                let urls = active.as_ref().and_then(|pk| ur.get(pk).cloned()).unwrap_or_default();
                urls.iter().map(|url| {
                    RelayInfo { url: url.clone(), connected: connected.contains(url) }
                }).collect()
            },
            nip46_enabled: *self.nip46_enabled.lock().unwrap(),
            upv2_login_key: {
                let active = self.active_keypair.lock().unwrap();
                let keys = self.upv2_login_key.lock().unwrap();
                active.as_ref().and_then(|pk| keys.get(pk).cloned())
            },
            upv2_sessions: {
                let active = self.active_keypair.lock().unwrap().clone();
                let all = self.upv2_sessions.lock().unwrap();
                match &active {
                    Some(pk) => all.iter()
                        .filter(|s| s.signer_pubkey == *pk)
                        .cloned().collect(),
                    None => all.clone(),
                }
            },
            login_attempts: self.login_attempts.lock().unwrap().clone(),
            pc55_running: *self.pc55_running.lock().unwrap(),
            pc55_connections: self.pc55_connections.lock().unwrap().clone(),
        }
    }

    pub fn save_keypairs(&self) -> Result<(), String> {
        let keypairs = self.keypairs.lock().unwrap();
        // Store index as list of pubkeys
        let pubkeys: Vec<String> = keypairs.iter().map(|kp| kp.pubkey.clone()).collect();
        save_to_keyring(KEYPAIRS_INDEX_KEY, &pubkeys)?;
        // Store each keypair individually
        for kp in keypairs.iter() {
            save_to_keyring(&format!("kp-{}", kp.pubkey), kp)?;
        }
        Ok(())
    }

    pub fn save_seeds(&self) -> Result<(), String> {
        let seeds = self.seeds.lock().unwrap();
        // Store index as list of seed IDs
        let seed_ids: Vec<String> = seeds.iter().map(|s| s.id.clone()).collect();
        save_to_keyring(SEEDS_INDEX_KEY, &seed_ids)?;
        // Store each seed individually
        for s in seeds.iter() {
            save_to_keyring(&format!("seed-info-{}", s.id), s)?;
        }
        Ok(())
    }

    pub fn save_connections(&self) -> Result<(), String> {
        let connections = self.connections.lock().unwrap();
        // Store index as list of connection IDs
        let conn_ids: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
        save_to_keyring(CONNECTIONS_KEY, &conn_ids)?;
        // Store each connection individually
        for c in connections.iter() {
            save_to_keyring(&format!("conn-{}", c.id), c)?;
        }
        Ok(())
    }

    pub fn save_relays(&self) -> Result<(), String> {
        let relays = self.relay_urls.lock().unwrap();
        save_to_keyring(RELAYS_KEY, &*relays)
    }

    pub fn save_user_relays(&self) -> Result<(), String> {
        let ur = self.user_relay_urls.lock().unwrap();
        save_to_keyring(USER_RELAYS_KEY, &*ur)
    }

    pub fn save_upv2_login_key(&self) -> Result<(), String> {
        let keys = self.upv2_login_key.lock().unwrap();
        if keys.is_empty() {
            let _ = delete_raw_from_keyring(UPV2_LOGIN_KEY);
            Ok(())
        } else {
            save_to_keyring(UPV2_LOGIN_KEY, &*keys)
        }
    }

    pub fn save_upv2_sessions(&self) -> Result<(), String> {
        let sessions = self.upv2_sessions.lock().unwrap();
        // Store index as list of session IDs
        let sess_ids: Vec<String> = sessions.iter().map(|s| s.session_id.clone()).collect();
        save_to_keyring(UPV2_SESSIONS_KEY, &sess_ids)?;
        // Store each session individually
        for s in sessions.iter() {
            save_to_keyring(&format!("upv2-sess-{}", s.session_id), s)?;
        }
        Ok(())
    }

    pub fn save_login_attempts(&self) -> Result<(), String> {
        let attempts = self.login_attempts.lock().unwrap();
        // Store index as list of attempt IDs
        let attempt_ids: Vec<String> = attempts.iter().map(|a| a.id.clone()).collect();
        save_to_keyring(LOGIN_ATTEMPTS_KEY, &attempt_ids)?;
        // Store each attempt individually
        for a in attempts.iter() {
            save_to_keyring(&format!("login-attempt-{}", a.id), a)?;
        }
        Ok(())
    }

    pub fn save_last_online_at(&self) -> Result<(), String> {
        let map = self.last_online_at.lock().unwrap();
        save_to_keyring(LAST_ONLINE_KEY, &*map)
    }

    pub fn save_nip46_enabled(&self) -> Result<(), String> {
        let enabled = *self.nip46_enabled.lock().unwrap();
        save_to_keyring(NIP46_ENABLED_KEY, &enabled)
    }

    pub fn save_signing_history(&self) -> Result<(), String> {
        let history = self.signing_history.lock().unwrap();
        save_to_keyring(SIGNING_HISTORY_KEY, &*history)
    }

    /// Record a signing outcome, keeping the latest 100 entries
    pub fn record_signing_history(&self, entry: SigningHistoryEntry) {
        let mut history = self.signing_history.lock().unwrap();
        history.insert(0, entry);
        history.truncate(100);
        drop(history);
        let _ = self.save_signing_history();
    }
}

// --- Keyring Helpers ---
// Windows Credential Manager has a ~2560-char UTF-16 limit per entry.
// Collections (keypairs, seeds, connections) are stored as individual entries
// with a lightweight index. Small values use simple single-entry storage.

pub fn save_to_keyring<T: Serialize>(key: &str, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value)
        .map_err(|e| format!("Serialization failed: {}", e))?;
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.set_password(&json)
        .map_err(|e| format!("Keyring store error: {}", e))?;
    Ok(())
}

pub fn get_raw_from_keyring(key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("Keyring retrieve error: {}", e))
}

pub fn save_raw_to_keyring(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.set_password(value)
        .map_err(|e| format!("Keyring store error: {}", e))?;
    Ok(())
}

pub fn delete_raw_from_keyring(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, key)
        .map_err(|e| format!("Keyring entry error: {}", e))?;
    entry.delete_credential()
        .map_err(|e| format!("Keyring delete error: {}", e))
}

fn load_from_keyring<T: for<'de> Deserialize<'de>>(key: &str) -> Option<T> {
    let entry = keyring::Entry::new(SERVICE_NAME, key).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}
