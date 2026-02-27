use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use nostr_sdk::Client;
use tracing::info;
use uuid::Uuid;

/// Profile metadata — stored in the global profiles index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    pub pin_hash: String,
}

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
    /// Available profiles (id + name, no secrets)
    pub profiles: Vec<ProfileListItem>,
    /// Currently active profile ID
    pub active_profile: Option<String>,
}

/// Profile info exposed to frontend (no PIN hash)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileListItem {
    pub id: String,
    pub name: String,
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
    // PIN lock — now per-profile (kept in profiles index)
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
    // Multi-profile support
    pub profiles: Mutex<Vec<ProfileInfo>>,
    pub active_profile: Mutex<Option<String>>,
}

const SERVICE_NAME: &str = "denos-signer";

// --- Global keys (not profile-scoped) ---
const PROFILES_INDEX_KEY: &str = "denos-profiles";
pub const LAST_PROFILE_KEY: &str = "denos-last-profile";

// --- Legacy keys (pre-profile, used for migration detection) ---
const LEGACY_KEYPAIRS_INDEX_KEY: &str = "denos-keypairs-index";
const LEGACY_PIN_HASH_KEY: &str = "denos-pin-hash";

// --- Profile-scoped key suffixes ---
const KEY_KEYPAIRS_INDEX: &str = "keypairs-index";
const KEY_SEEDS_INDEX: &str = "seeds-index";
const KEY_CONNECTIONS: &str = "connections";
const KEY_RELAYS: &str = "relays";
const KEY_UPV2_LOGIN: &str = "upv2-login-key";
const KEY_UPV2_SESSIONS: &str = "upv2-sessions";
const KEY_LOGIN_ATTEMPTS: &str = "login-attempts";
const KEY_LAST_ONLINE: &str = "last-online-at";
const KEY_LOCK_TIMEOUT: &str = "lock-timeout";
const KEY_ACTIVE_KEYPAIR: &str = "active-keypair";
const KEY_ACTIVE_SEED: &str = "active-seed";
const KEY_NIP46_ENABLED: &str = "nip46-enabled";
const KEY_SIGNING_HISTORY: &str = "signing-history";
const KEY_USER_RELAYS: &str = "user-relays";

/// Build a profile-scoped keyring key: `p-{profile_id}/{suffix}`
fn pk(profile_id: &str, suffix: &str) -> String {
    format!("p-{}/{}", profile_id, suffix)
}

impl AppState {
    /// On startup: load profile index + detect legacy migration.
    /// Profile data is NOT loaded yet — that happens in `load_profile()`.
    pub fn new() -> Self {
        // Check for existing profiles index
        let mut profiles: Vec<ProfileInfo> = load_from_keyring::<Vec<ProfileInfo>>(PROFILES_INDEX_KEY)
            .unwrap_or_default();

        // --- Legacy migration ---
        // If no profiles exist but there's legacy data, migrate it
        if profiles.is_empty() {
            let has_legacy_data = load_from_keyring::<Vec<String>>(LEGACY_KEYPAIRS_INDEX_KEY).is_some()
                || get_raw_from_keyring(LEGACY_PIN_HASH_KEY).is_ok();

            if has_legacy_data {
                info!("Detected legacy data — migrating to profile system");
                let profile_id = Uuid::new_v4().to_string();
                let legacy_pin_hash = get_raw_from_keyring(LEGACY_PIN_HASH_KEY)
                    .unwrap_or_default();

                let profile = ProfileInfo {
                    id: profile_id.clone(),
                    name: "PIN Account 1".to_string(),
                    pin_hash: legacy_pin_hash,
                };

                // Migrate all key constants to profile-scoped versions
                let legacy_keys: Vec<(&str, &str)> = vec![
                    ("denos-keypairs-index", KEY_KEYPAIRS_INDEX),
                    ("denos-seeds-index", KEY_SEEDS_INDEX),
                    ("denos-connections", KEY_CONNECTIONS),
                    ("denos-relays", KEY_RELAYS),
                    ("denos-upv2-login-key", KEY_UPV2_LOGIN),
                    ("denos-upv2-sessions", KEY_UPV2_SESSIONS),
                    ("denos-login-attempts", KEY_LOGIN_ATTEMPTS),
                    ("denos-last-online-at", KEY_LAST_ONLINE),
                    ("denos-lock-timeout", KEY_LOCK_TIMEOUT),
                    ("denos-active-keypair", KEY_ACTIVE_KEYPAIR),
                    ("denos-active-seed", KEY_ACTIVE_SEED),
                    ("denos-nip46-enabled", KEY_NIP46_ENABLED),
                    ("denos-signing-history", KEY_SIGNING_HISTORY),
                    ("denos-user-relays", KEY_USER_RELAYS),
                ];

                for (old_key, suffix) in &legacy_keys {
                    if let Ok(val) = get_raw_from_keyring(old_key) {
                        let new_key = pk(&profile_id, suffix);
                        let _ = save_raw_to_keyring(&new_key, &val);
                        let _ = delete_raw_from_keyring(old_key);
                        info!("  Migrated {} -> {}", old_key, new_key);
                    }
                }

                // Migrate per-item keys (sk-*, kp-*, seed-*, seed-info-*, conn-*,
                // upv2-sess-*, login-attempt-*, ecash-*)
                // We need to read the index keys to find all items
                let keypair_pubkeys = load_from_keyring::<Vec<String>>(&pk(&profile_id, KEY_KEYPAIRS_INDEX))
                    .unwrap_or_default();
                for pubkey in &keypair_pubkeys {
                    // Migrate sk-{pubkey} and kp-{pubkey}
                    for prefix in &["sk-", "kp-"] {
                        let old = format!("{}{}", prefix, pubkey);
                        if let Ok(val) = get_raw_from_keyring(&old) {
                            let new = format!("p-{}/{}{}", profile_id, prefix, pubkey);
                            let _ = save_raw_to_keyring(&new, &val);
                            let _ = delete_raw_from_keyring(&old);
                        }
                    }
                    // Migrate ecash-* keys
                    for ecash_key in &["ecash-proofs-", "ecash-mints-", "ecash-history-", "ecash-pending-", "ecash-discovered-"] {
                        let old = format!("{}{}", ecash_key, pubkey);
                        if let Ok(val) = get_raw_from_keyring(&old) {
                            let new = format!("p-{}/{}{}", profile_id, ecash_key, pubkey);
                            let _ = save_raw_to_keyring(&new, &val);
                            let _ = delete_raw_from_keyring(&old);
                        }
                    }
                }

                // Migrate seed-{id} and seed-info-{id}
                let seed_ids = load_from_keyring::<Vec<String>>(&pk(&profile_id, KEY_SEEDS_INDEX))
                    .unwrap_or_default();
                for sid in &seed_ids {
                    for prefix in &["seed-", "seed-info-"] {
                        let old = format!("{}{}", prefix, sid);
                        if let Ok(val) = get_raw_from_keyring(&old) {
                            let new = format!("p-{}/{}{}", profile_id, prefix, sid);
                            let _ = save_raw_to_keyring(&new, &val);
                            let _ = delete_raw_from_keyring(&old);
                        }
                    }
                }

                // Migrate conn-{id}
                let conn_ids = load_from_keyring::<Vec<String>>(&pk(&profile_id, KEY_CONNECTIONS))
                    .unwrap_or_default();
                for cid in &conn_ids {
                    let old = format!("conn-{}", cid);
                    if let Ok(val) = get_raw_from_keyring(&old) {
                        let new = format!("p-{}/conn-{}", profile_id, cid);
                        let _ = save_raw_to_keyring(&new, &val);
                        let _ = delete_raw_from_keyring(&old);
                    }
                }

                // Migrate upv2-sess-{id}
                let sess_ids = load_from_keyring::<Vec<String>>(&pk(&profile_id, KEY_UPV2_SESSIONS))
                    .unwrap_or_default();
                for sid in &sess_ids {
                    let old = format!("upv2-sess-{}", sid);
                    if let Ok(val) = get_raw_from_keyring(&old) {
                        let new = format!("p-{}/upv2-sess-{}", profile_id, sid);
                        let _ = save_raw_to_keyring(&new, &val);
                        let _ = delete_raw_from_keyring(&old);
                    }
                }

                // Migrate login-attempt-{id}
                let attempt_ids = load_from_keyring::<Vec<String>>(&pk(&profile_id, KEY_LOGIN_ATTEMPTS))
                    .unwrap_or_default();
                for aid in &attempt_ids {
                    let old = format!("login-attempt-{}", aid);
                    if let Ok(val) = get_raw_from_keyring(&old) {
                        let new = format!("p-{}/login-attempt-{}", profile_id, aid);
                        let _ = save_raw_to_keyring(&new, &val);
                        let _ = delete_raw_from_keyring(&old);
                    }
                }

                // Clean up legacy PIN hash key
                let _ = delete_raw_from_keyring(LEGACY_PIN_HASH_KEY);

                profiles.push(profile);
                let _ = save_to_keyring(PROFILES_INDEX_KEY, &profiles);
                let _ = save_to_keyring(LAST_PROFILE_KEY, &profile_id);
                info!("Migration complete — created profile {}", profile_id);
            }
        }

        // Determine which profile was last active
        let last_profile = load_from_keyring::<String>(LAST_PROFILE_KEY);

        Self {
            keypairs: Mutex::new(Vec::new()),
            active_keypair: Mutex::new(None),
            seeds: Mutex::new(Vec::new()),
            active_seed: Mutex::new(None),
            connections: Mutex::new(Vec::new()),
            pending_requests: Mutex::new(Vec::new()),
            signer_running: Mutex::new(false),
            relay_urls: Mutex::new(vec![
                "wss://relay.damus.io".to_string(),
                "wss://relay.primal.net".to_string(),
                "wss://nos.lol".to_string(),
            ]),
            signer_shutdown: Mutex::new(None),
            signer_client: Mutex::new(None),
            upv2_login_key: Mutex::new(HashMap::new()),
            upv2_sessions: Mutex::new(Vec::new()),
            upv2_challenges: Mutex::new(Vec::new()),
            login_attempts: Mutex::new(Vec::new()),
            last_online_at: Mutex::new(HashMap::new()),
            pending_reconnect: Mutex::new(None),
            connected_relays: Mutex::new(HashSet::new()),
            pin_hash: Mutex::new(None),
            lock_timeout_minutes: Mutex::new(5),
            nip46_enabled: Mutex::new(true),
            signing_history: Mutex::new(Vec::new()),
            user_relay_urls: Mutex::new(HashMap::new()),
            pc55_running: Mutex::new(false),
            pc55_shutdown: Mutex::new(None),
            pc55_connections: Mutex::new(Vec::new()),
            pc55_response_channels: Mutex::new(HashMap::new()),
            profiles: Mutex::new(profiles),
            active_profile: Mutex::new(last_profile),
        }
    }
    /// Load all data for a specific profile into the in-memory state.
    /// Called after successful PIN verification.
    pub fn load_profile(&self, profile_id: &str) {
        info!("Loading profile: {}", profile_id);

        // Helper: profile-scoped key
        let k = |suffix: &str| pk(profile_id, suffix);

        // Load keypairs
        let keypairs = {
            let pubkeys = load_from_keyring::<Vec<String>>(&k(KEY_KEYPAIRS_INDEX))
                .unwrap_or_default();
            pubkeys.iter()
                .filter_map(|pubkey| load_from_keyring::<KeypairInfo>(&format!("p-{}/kp-{}", profile_id, pubkey)))
                .collect::<Vec<_>>()
        };

        // Load seeds
        let seeds = {
            let seed_ids = load_from_keyring::<Vec<String>>(&k(KEY_SEEDS_INDEX))
                .unwrap_or_default();
            seed_ids.iter()
                .filter_map(|id| load_from_keyring::<SeedInfo>(&format!("p-{}/seed-info-{}", profile_id, id)))
                .collect::<Vec<_>>()
        };

        // Load connections
        let connections = {
            let conn_ids = load_from_keyring::<Vec<String>>(&k(KEY_CONNECTIONS))
                .unwrap_or_default();
            conn_ids.iter()
                .filter_map(|id| load_from_keyring::<Connection>(&format!("p-{}/conn-{}", profile_id, id)))
                .collect::<Vec<_>>()
        };

        let relay_urls = load_from_keyring::<Vec<String>>(&k(KEY_RELAYS))
            .unwrap_or_else(|| vec![
                "wss://relay.damus.io".to_string(),
                "wss://relay.primal.net".to_string(),
                "wss://nos.lol".to_string(),
            ]);

        let upv2_login_keys: HashMap<String, Upv2LoginKey> =
            load_from_keyring::<HashMap<String, Upv2LoginKey>>(&k(KEY_UPV2_LOGIN))
                .unwrap_or_default();

        let upv2_sessions = {
            let sess_ids = load_from_keyring::<Vec<String>>(&k(KEY_UPV2_SESSIONS))
                .unwrap_or_default();
            sess_ids.iter()
                .filter_map(|id| load_from_keyring::<Upv2Session>(&format!("p-{}/upv2-sess-{}", profile_id, id)))
                .collect::<Vec<_>>()
        };

        let login_attempts = {
            let attempt_ids = load_from_keyring::<Vec<String>>(&k(KEY_LOGIN_ATTEMPTS))
                .unwrap_or_default();
            attempt_ids.iter()
                .filter_map(|id| load_from_keyring::<LoginAttempt>(&format!("p-{}/login-attempt-{}", profile_id, id)))
                .collect::<Vec<_>>()
        };

        let last_online_at: HashMap<String, u64> =
            load_from_keyring::<HashMap<String, u64>>(&k(KEY_LAST_ONLINE))
                .unwrap_or_default();

        let lock_timeout_minutes = load_from_keyring::<u32>(&k(KEY_LOCK_TIMEOUT))
            .unwrap_or(5);

        let active = load_from_keyring::<String>(&k(KEY_ACTIVE_KEYPAIR))
            .filter(|ap| keypairs.iter().any(|kp| kp.pubkey == *ap))
            .or_else(|| keypairs.first().map(|kp| kp.pubkey.clone()));

        let active_seed = load_from_keyring::<String>(&k(KEY_ACTIVE_SEED))
            .filter(|sid| seeds.iter().any(|s| s.id == *sid))
            .or_else(|| seeds.first().map(|s| s.id.clone()));

        // Find the profile's PIN hash
        let pin_hash = {
            let profiles = self.profiles.lock().unwrap();
            profiles.iter().find(|p| p.id == profile_id).map(|p| p.pin_hash.clone())
        };

        let nip46_enabled = load_from_keyring::<bool>(&k(KEY_NIP46_ENABLED))
            .unwrap_or(true);

        let signing_history = load_from_keyring::<Vec<SigningHistoryEntry>>(&k(KEY_SIGNING_HISTORY))
            .unwrap_or_default();

        let user_relay_urls = load_from_keyring::<HashMap<String, Vec<String>>>(&k(KEY_USER_RELAYS))
            .unwrap_or_default();

        // Update all state fields
        *self.keypairs.lock().unwrap() = keypairs;
        *self.active_keypair.lock().unwrap() = active;
        *self.seeds.lock().unwrap() = seeds;
        *self.active_seed.lock().unwrap() = active_seed;
        *self.connections.lock().unwrap() = connections;
        *self.pending_requests.lock().unwrap() = Vec::new();
        *self.relay_urls.lock().unwrap() = relay_urls;
        *self.upv2_login_key.lock().unwrap() = upv2_login_keys;
        *self.upv2_sessions.lock().unwrap() = upv2_sessions;
        *self.upv2_challenges.lock().unwrap() = Vec::new();
        *self.login_attempts.lock().unwrap() = login_attempts;
        *self.last_online_at.lock().unwrap() = last_online_at;
        *self.pin_hash.lock().unwrap() = pin_hash;
        *self.lock_timeout_minutes.lock().unwrap() = lock_timeout_minutes;
        *self.nip46_enabled.lock().unwrap() = nip46_enabled;
        *self.signing_history.lock().unwrap() = signing_history;
        *self.user_relay_urls.lock().unwrap() = user_relay_urls;
        *self.active_profile.lock().unwrap() = Some(profile_id.to_string());

        // Persist last-used profile
        let _ = save_to_keyring(LAST_PROFILE_KEY, &profile_id.to_string());

        info!("Profile {} loaded: {} keypairs, {} seeds",
            profile_id,
            self.keypairs.lock().unwrap().len(),
            self.seeds.lock().unwrap().len(),
        );
    }

    /// Get the active profile ID, or panic if none is set
    pub fn profile_id(&self) -> String {
        self.active_profile.lock().unwrap().clone()
            .expect("No active profile — load_profile() must be called first")
    }

    pub fn keypair_count(&self) -> usize {
        self.keypairs.lock().unwrap().len()
    }

    pub fn to_app_payload(&self) -> AppStatePayload {
        let profiles = self.profiles.lock().unwrap();
        AppStatePayload {
            keypairs: self.keypairs.lock().unwrap().clone(),
            active_keypair: self.active_keypair.lock().unwrap().clone(),
            seeds: self.seeds.lock().unwrap().clone(),
            active_seed: self.active_seed.lock().unwrap().clone(),
            initialized: true,
            pin_set: self.pin_hash.lock().unwrap().is_some(),
            lock_timeout_minutes: *self.lock_timeout_minutes.lock().unwrap(),
            profiles: profiles.iter().map(|p| ProfileListItem {
                id: p.id.clone(),
                name: p.name.clone(),
            }).collect(),
            active_profile: self.active_profile.lock().unwrap().clone(),
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
        let pid = self.profile_id();
        let keypairs = self.keypairs.lock().unwrap();
        let pubkeys: Vec<String> = keypairs.iter().map(|kp| kp.pubkey.clone()).collect();
        save_to_keyring(&pk(&pid, KEY_KEYPAIRS_INDEX), &pubkeys)?;
        for kp in keypairs.iter() {
            save_to_keyring(&format!("p-{}/kp-{}", pid, kp.pubkey), kp)?;
        }
        Ok(())
    }

    pub fn save_seeds(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let seeds = self.seeds.lock().unwrap();
        let seed_ids: Vec<String> = seeds.iter().map(|s| s.id.clone()).collect();
        save_to_keyring(&pk(&pid, KEY_SEEDS_INDEX), &seed_ids)?;
        for s in seeds.iter() {
            save_to_keyring(&format!("p-{}/seed-info-{}", pid, s.id), s)?;
        }
        Ok(())
    }

    pub fn save_connections(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let connections = self.connections.lock().unwrap();
        let conn_ids: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
        save_to_keyring(&pk(&pid, KEY_CONNECTIONS), &conn_ids)?;
        for c in connections.iter() {
            save_to_keyring(&format!("p-{}/conn-{}", pid, c.id), c)?;
        }
        Ok(())
    }

    pub fn save_relays(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let relays = self.relay_urls.lock().unwrap();
        save_to_keyring(&pk(&pid, KEY_RELAYS), &*relays)
    }

    pub fn save_user_relays(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let ur = self.user_relay_urls.lock().unwrap();
        save_to_keyring(&pk(&pid, KEY_USER_RELAYS), &*ur)
    }

    pub fn save_upv2_login_key(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let keys = self.upv2_login_key.lock().unwrap();
        if keys.is_empty() {
            let _ = delete_raw_from_keyring(&pk(&pid, KEY_UPV2_LOGIN));
            Ok(())
        } else {
            save_to_keyring(&pk(&pid, KEY_UPV2_LOGIN), &*keys)
        }
    }

    pub fn save_upv2_sessions(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let sessions = self.upv2_sessions.lock().unwrap();
        let sess_ids: Vec<String> = sessions.iter().map(|s| s.session_id.clone()).collect();
        save_to_keyring(&pk(&pid, KEY_UPV2_SESSIONS), &sess_ids)?;
        for s in sessions.iter() {
            save_to_keyring(&format!("p-{}/upv2-sess-{}", pid, s.session_id), s)?;
        }
        Ok(())
    }

    pub fn save_login_attempts(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let attempts = self.login_attempts.lock().unwrap();
        let attempt_ids: Vec<String> = attempts.iter().map(|a| a.id.clone()).collect();
        save_to_keyring(&pk(&pid, KEY_LOGIN_ATTEMPTS), &attempt_ids)?;
        for a in attempts.iter() {
            save_to_keyring(&format!("p-{}/login-attempt-{}", pid, a.id), a)?;
        }
        Ok(())
    }

    pub fn save_last_online_at(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let map = self.last_online_at.lock().unwrap();
        save_to_keyring(&pk(&pid, KEY_LAST_ONLINE), &*map)
    }

    pub fn save_nip46_enabled(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let enabled = *self.nip46_enabled.lock().unwrap();
        save_to_keyring(&pk(&pid, KEY_NIP46_ENABLED), &enabled)
    }

    pub fn save_signing_history(&self) -> Result<(), String> {
        let pid = self.profile_id();
        let history = self.signing_history.lock().unwrap();
        save_to_keyring(&pk(&pid, KEY_SIGNING_HISTORY), &*history)
    }

    /// Record a signing outcome, keeping the latest 100 entries
    pub fn record_signing_history(&self, entry: SigningHistoryEntry) {
        let mut history = self.signing_history.lock().unwrap();
        history.insert(0, entry);
        history.truncate(100);
        drop(history);
        let _ = self.save_signing_history();
    }

    /// Save the profiles index to keyring
    pub fn save_profiles(&self) -> Result<(), String> {
        let profiles = self.profiles.lock().unwrap();
        save_to_keyring(PROFILES_INDEX_KEY, &*profiles)
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
