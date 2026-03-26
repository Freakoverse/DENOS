use crate::state::{AppState, ProfileInfo, KeypairInfo, SeedInfo, save_raw_to_keyring, get_raw_from_keyring, delete_raw_from_keyring, save_to_keyring};
use nostr_sdk::prelude::*;
use nostr_sdk::nips::nip06::FromMnemonic;
use tauri::{AppHandle, Emitter, State};
use tracing::{info, error};
use sha2::{Sha256, Digest};
use uuid::Uuid;

/// Build a profile-scoped keyring key for the active profile
fn ppk(state: &AppState, suffix: &str) -> String {
    let pid = state.profile_id();
    format!("p-{}/{}", pid, suffix)
}

fn emit_state(app: &AppHandle, state: &State<'_, AppState>) {
    let payload = state.to_app_payload();
    if let Err(e) = app.emit("app-state", &payload) {
        error!("Failed to emit app state: {}", e);
    }
}

fn emit_log(app: &AppHandle, msg: &str) {
    let _ = app.emit("log-event", msg);
}

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

#[tauri::command]
pub fn get_app_state(state: State<'_, AppState>) -> crate::state::AppStatePayload {
    state.to_app_payload()
}

#[tauri::command]
pub fn generate_keypair(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<String, String> {
    // Generate proper secp256k1 keypair via nostr-sdk
    let keys = Keys::generate();
    let secret_key = keys.secret_key();
    let public_key = keys.public_key();

    let sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 encoding failed: {}", e))?;

    // Store secret key in OS keychain (profile-scoped)
    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name,
        seed_id: None,
        account_index: None,
    };

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    // Auto-activate if first keypair
    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }

    info!("Generated keypair: {}", &npub[..24]);
    emit_log(&app, &format!("[INFO] Generated keypair: {}...{}", &npub[..16], &npub[npub.len()-8..]));
    emit_state(&app, &state);

    Ok(pubkey_hex)
}

#[tauri::command]
pub fn import_nsec(
    app: AppHandle,
    state: State<'_, AppState>,
    nsec: String,
    name: Option<String>,
) -> Result<String, String> {
    let secret_key = SecretKey::from_bech32(&nsec)
        .map_err(|e| format!("Invalid nsec: {}", e))?;
    let keys = Keys::new(secret_key);
    let public_key = keys.public_key();

    let sk_hex = keys.secret_key().to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let keypairs = state.keypairs.lock().unwrap();
        if keypairs.iter().any(|kp| kp.pubkey == pubkey_hex) {
            return Err("This key is already imported".to_string());
        }
    }

    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name,
        seed_id: None,
        account_index: None,
    };

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }

    info!("Imported nsec: {}", &npub[..24]);
    emit_log(&app, &format!("[INFO] Imported key: {}...{}", &npub[..16], &npub[npub.len()-8..]));
    emit_state(&app, &state);

    Ok(pubkey_hex)
}

#[tauri::command]
pub fn import_seed(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: String,
    name: Option<String>,
) -> Result<String, String> {
    // Validate word count
    let words: Vec<&str> = mnemonic.trim().split_whitespace().collect();
    if words.len() != 12 && words.len() != 24 {
        return Err("Seed phrase must be 12 or 24 words".to_string());
    }

    // Use NIP-06 trait (FromMnemonic) for BIP-39 derivation
    let keys = Keys::from_mnemonic(mnemonic.trim(), None::<&str>)
        .map_err(|e| format!("Invalid mnemonic: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();

    let sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    {
        let keypairs = state.keypairs.lock().unwrap();
        if keypairs.iter().any(|kp| kp.pubkey == pubkey_hex) {
            return Err("This key is already imported".to_string());
        }
    }

    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name,
        seed_id: None,
        account_index: None,
    };

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }

    info!("Imported from seed: {}", &npub[..24]);
    emit_log(&app, &format!("[INFO] Imported from seed: {}...{}", &npub[..16], &npub[npub.len()-8..]));
    emit_state(&app, &state);

    Ok(pubkey_hex)
}

#[tauri::command]
pub fn delete_keypair(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<(), String> {
    let _ = delete_raw_from_keyring(&ppk(&state, &format!("sk-{}", pubkey)));

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.retain(|kp| kp.pubkey != pubkey);
    }
    state.save_keypairs()?;

    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.as_deref() == Some(&pubkey) {
            let keypairs = state.keypairs.lock().unwrap();
            *active = keypairs.first().map(|kp| kp.pubkey.clone());
        }
    }

    info!("Deleted keypair: {}...", &pubkey[..16]);
    emit_log(&app, &format!("[WARN] Deleted keypair: {}...", &pubkey[..16]));
    emit_state(&app, &state);

    Ok(())
}

#[tauri::command]
pub async fn set_active_keypair(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<(), String> {
    {
        let keypairs = state.keypairs.lock().unwrap();
        if !keypairs.iter().any(|kp| kp.pubkey == pubkey) {
            return Err("Keypair not found".to_string());
        }
    }

    // Check if signer is running — we'll need to restart it with the new keypair
    let was_running = *state.signer_running.lock().unwrap();

    // If signer is running, stop it first
    if was_running {
        info!("Stopping signer for keypair switch...");
        emit_log(&app, "[INFO] Restarting signer for new keypair...");
        // Send shutdown signal
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
        // Record last_online for the OLD keypair before switching
        if let Some(old_pk) = state.active_keypair.lock().unwrap().clone() {
            crate::upv2::record_last_online(&app, &old_pk);
        }
        // Give the signer loop a moment to shut down
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    {
        let mut active = state.active_keypair.lock().unwrap();
        *active = Some(pubkey.clone());
    }

    // Persist to keyring so it survives restarts
    let _ = save_to_keyring(&ppk(&state, "active-keypair"), &pubkey);

    info!("Active keypair: {}...", &pubkey[..16]);
    emit_log(&app, &format!("[INFO] Active keypair: {}...", &pubkey[..16]));
    emit_state(&app, &state);

    // If signer was running, restart it with the new keypair
    if was_running {
        let signer_keys = get_active_keys(&state)?;
        let signer_pubkey = signer_keys.public_key();
        let relay_urls: Vec<String> = state.relay_urls.lock().unwrap().clone();

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
        info!("NIP-46 signer restarted: {}", &signer_npub[..24]);
        emit_log(&app, &format!("[INFO] NIP-46 signer restarted: {}...{}",
            &signer_npub[..16], &signer_npub[signer_npub.len()-8..]));

        let app_handle = app.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::nip46::run_signer_loop(
                app_handle,
                signer_keys,
                relay_urls,
                shutdown_rx,
            ).await {
                error!("Signer loop error: {}", e);
            }
        });
    }

    // Emit signer state so UPv2 login key updates for the new keypair
    let signer_payload = state.to_signer_payload();
    let _ = app.emit("signer-state", &signer_payload);

    Ok(())
}

#[tauri::command]
pub fn export_nsec(
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<String, String> {
    {
        let keypairs = state.keypairs.lock().unwrap();
        if !keypairs.iter().any(|kp| kp.pubkey == pubkey) {
            return Err("Keypair not found".to_string());
        }
    }

    let sk_hex = get_raw_from_keyring(&ppk(&state, &format!("sk-{}", pubkey)))?;
    let secret_key = SecretKey::from_hex(&sk_hex)
        .map_err(|e| format!("Invalid stored key: {}", e))?;
    let nsec = secret_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    Ok(nsec)
}

#[tauri::command]
pub fn export_private_key_hex(
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<String, String> {
    {
        let keypairs = state.keypairs.lock().unwrap();
        if !keypairs.iter().any(|kp| kp.pubkey == pubkey) {
            return Err("Keypair not found".to_string());
        }
    }

    get_raw_from_keyring(&ppk(&state, &format!("sk-{}", pubkey)))
}

#[tauri::command]
pub fn list_keypairs(state: State<'_, AppState>) -> Vec<KeypairInfo> {
    state.keypairs.lock().unwrap().clone()
}

/// Retrieve the nostr-sdk Keys for the active keypair
pub fn get_active_keys(state: &AppState) -> Result<Keys, String> {
    let pubkey = state.active_keypair.lock().unwrap()
        .clone()
        .ok_or("No active keypair")?;

    let sk_hex = get_raw_from_keyring(&ppk(state, &format!("sk-{}", pubkey)))?;
    let secret_key = SecretKey::from_hex(&sk_hex)
        .map_err(|e| format!("Invalid stored key: {}", e))?;

    Ok(Keys::new(secret_key))
}

// ─── Seed Management ────────────────────────────────────────────────────

/// Generate a new BIP-39 seed, derive the first keypair (account 0), return mnemonic for backup
#[tauri::command]
pub fn generate_seed(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<GenerateSeedResult, String> {
    use bip39::Mnemonic;
    use rand::RngCore;

    // Generate 32 bytes of entropy (256 bits = 24-word mnemonic)
    let mut entropy = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut entropy);
    let mnemonic = Mnemonic::from_entropy(&entropy)
        .map_err(|e| format!("Mnemonic generation failed: {}", e))?;
    let mnemonic_str = mnemonic.to_string();

    let seed_id = uuid::Uuid::new_v4().to_string();
    let seed_name = name.unwrap_or_else(|| "My Seed".to_string());

    // Store mnemonic in OS keyring
    save_raw_to_keyring(&ppk(&state, &format!("seed-{}", seed_id)), &mnemonic_str)?;

    // Derive first keypair (account index 0)
    let keys = Keys::from_mnemonic_with_account(mnemonic_str.as_str(), None::<&str>, Some(0))
        .map_err(|e| format!("Key derivation failed: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Store secret key
    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    // Create keypair info
    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some("Account 1".to_string()),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
    };

    // Create seed info
    let seed_info = SeedInfo {
        id: seed_id.clone(),
        name: seed_name.clone(),
        keypair_pubkeys: vec![pubkey_hex.clone()],
    };

    // Save to state
    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    {
        let mut seeds = state.seeds.lock().unwrap();
        seeds.push(seed_info);
    }
    state.save_seeds()?;

    // Auto-activate if first keypair
    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }
    // Set as active seed
    {
        let mut active_seed = state.active_seed.lock().unwrap();
        *active_seed = Some(seed_id.clone());
    }

    info!("Generated seed '{}' with first keypair: {}", &seed_name, &npub[..24]);
    emit_log(&app, &format!("[INFO] Generated seed '{}' with first keypair", &seed_name));
    emit_state(&app, &state);

    Ok(GenerateSeedResult {
        seed_id,
        mnemonic: mnemonic_str,
        first_pubkey: pubkey_hex,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GenerateSeedResult {
    pub seed_id: String,
    pub mnemonic: String,
    pub first_pubkey: String,
}

/// Import an existing BIP-39 seed phrase, derive the first keypair
#[tauri::command]
pub fn import_seed_phrase(
    app: AppHandle,
    state: State<'_, AppState>,
    mnemonic: String,
    name: Option<String>,
) -> Result<String, String> {
    // Validate word count
    let words: Vec<&str> = mnemonic.trim().split_whitespace().collect();
    if words.len() != 12 && words.len() != 24 {
        return Err("Seed phrase must be 12 or 24 words".to_string());
    }

    // Validate by trying to derive
    let keys = Keys::from_mnemonic_with_account(mnemonic.trim(), None::<&str>, Some(0))
        .map_err(|e| format!("Invalid mnemonic: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check if this keypair already exists
    {
        let keypairs = state.keypairs.lock().unwrap();
        if keypairs.iter().any(|kp| kp.pubkey == pubkey_hex) {
            return Err("A keypair from this seed is already imported".to_string());
        }
    }

    let seed_id = uuid::Uuid::new_v4().to_string();
    let seed_name = name.unwrap_or_else(|| "Imported Seed".to_string());

    // Store mnemonic and secret key
    save_raw_to_keyring(&ppk(&state, &format!("seed-{}", seed_id)), mnemonic.trim())?;
    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some("Account 1".to_string()),
        seed_id: Some(seed_id.clone()),
        account_index: Some(0),
    };

    let seed_info = SeedInfo {
        id: seed_id.clone(),
        name: seed_name.clone(),
        keypair_pubkeys: vec![pubkey_hex.clone()],
    };

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    {
        let mut seeds = state.seeds.lock().unwrap();
        seeds.push(seed_info);
    }
    state.save_seeds()?;

    {
        let mut active = state.active_keypair.lock().unwrap();
        if active.is_none() {
            *active = Some(pubkey_hex.clone());
        }
    }
    {
        let mut active_seed = state.active_seed.lock().unwrap();
        *active_seed = Some(seed_id.clone());
    }

    info!("Imported seed '{}': {}", &seed_name, &npub[..24]);
    emit_log(&app, &format!("[INFO] Imported seed '{}' with first keypair", &seed_name));
    emit_state(&app, &state);

    Ok(seed_id)
}

/// Derive the next keypair from an existing seed
#[tauri::command]
pub fn derive_next_keypair(
    app: AppHandle,
    state: State<'_, AppState>,
    seed_id: String,
) -> Result<String, String> {
    // Find the seed
    let seed = {
        let seeds = state.seeds.lock().unwrap();
        seeds.iter().find(|s| s.id == seed_id).cloned()
            .ok_or("Seed not found")?
    };

    // Retrieve mnemonic from keyring
    let mnemonic = get_raw_from_keyring(&ppk(&state, &format!("seed-{}", seed_id)))?;

    // Find next account index
    let next_index = {
        let keypairs = state.keypairs.lock().unwrap();
        let max_idx = keypairs.iter()
            .filter(|kp| kp.seed_id.as_deref() == Some(&seed_id))
            .filter_map(|kp| kp.account_index)
            .max()
            .unwrap_or(0);
        // If there are already keypairs, increment; otherwise start at 0
        if seed.keypair_pubkeys.is_empty() { 0 } else { max_idx + 1 }
    };

    // Derive keypair at next account index
    let keys = Keys::from_mnemonic_with_account(mnemonic.as_str(), None::<&str>, Some(next_index))
        .map_err(|e| format!("Key derivation failed: {}", e))?;

    let secret_key = keys.secret_key();
    let public_key = keys.public_key();
    let sk_hex = secret_key.to_secret_hex();
    let pubkey_hex = public_key.to_hex();
    let npub = public_key.to_bech32()
        .map_err(|e| format!("Bech32 error: {}", e))?;

    // Check duplicate
    {
        let keypairs = state.keypairs.lock().unwrap();
        if keypairs.iter().any(|kp| kp.pubkey == pubkey_hex) {
            return Err("This keypair already exists".to_string());
        }
    }

    save_raw_to_keyring(&ppk(&state, &format!("sk-{}", pubkey_hex)), &sk_hex)?;

    let kp = KeypairInfo {
        pubkey: pubkey_hex.clone(),
        npub: npub.clone(),
        name: Some(format!("Account {}", next_index + 1)),
        seed_id: Some(seed_id.clone()),
        account_index: Some(next_index),
    };

    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.push(kp);
    }
    state.save_keypairs()?;

    // Update seed's keypair list
    {
        let mut seeds = state.seeds.lock().unwrap();
        if let Some(s) = seeds.iter_mut().find(|s| s.id == seed_id) {
            s.keypair_pubkeys.push(pubkey_hex.clone());
        }
    }
    state.save_seeds()?;

    info!("Derived keypair #{} from seed '{}': {}", next_index, &seed.name, &npub[..24]);
    emit_log(&app, &format!("[INFO] Derived new keypair from seed '{}'", &seed.name));
    emit_state(&app, &state);

    Ok(pubkey_hex)
}

/// Delete a seed and all its derived keypairs
#[tauri::command]
pub fn delete_seed(
    app: AppHandle,
    state: State<'_, AppState>,
    seed_id: String,
) -> Result<(), String> {
    // Find seed and its keypair pubkeys
    let keypair_pubkeys = {
        let seeds = state.seeds.lock().unwrap();
        seeds.iter()
            .find(|s| s.id == seed_id)
            .map(|s| s.keypair_pubkeys.clone())
            .ok_or("Seed not found")?
    };

    // Delete all derived secret keys from keyring
    for pk in &keypair_pubkeys {
        let _ = delete_raw_from_keyring(&ppk(&state, &format!("sk-{}", pk)));
    }

    // Delete seed mnemonic from keyring
    let _ = delete_raw_from_keyring(&ppk(&state, &format!("seed-{}", seed_id)));

    // Remove derived keypairs from state
    {
        let mut keypairs = state.keypairs.lock().unwrap();
        keypairs.retain(|kp| kp.seed_id.as_deref() != Some(&seed_id));
    }
    state.save_keypairs()?;

    // Remove seed from state
    {
        let mut seeds = state.seeds.lock().unwrap();
        seeds.retain(|s| s.id != seed_id);
    }
    state.save_seeds()?;

    // Fix active keypair if it was deleted
    {
        let mut active = state.active_keypair.lock().unwrap();
        if let Some(ref pk) = *active {
            if keypair_pubkeys.contains(pk) {
                let keypairs = state.keypairs.lock().unwrap();
                *active = keypairs.first().map(|kp| kp.pubkey.clone());
            }
        }
    }

    // Fix active seed
    {
        let mut active_seed = state.active_seed.lock().unwrap();
        if active_seed.as_deref() == Some(&seed_id) {
            let seeds = state.seeds.lock().unwrap();
            *active_seed = seeds.first().map(|s| s.id.clone());
        }
    }

    info!("Deleted seed {}", &seed_id[..8]);
    emit_log(&app, &format!("[WARN] Deleted seed and {} keypairs", keypair_pubkeys.len()));
    emit_state(&app, &state);

    Ok(())
}

/// Set the active seed
#[tauri::command]
pub fn set_active_seed(
    app: AppHandle,
    state: State<'_, AppState>,
    seed_id: String,
) -> Result<(), String> {
    {
        let seeds = state.seeds.lock().unwrap();
        if !seeds.iter().any(|s| s.id == seed_id) {
            return Err("Seed not found".to_string());
        }
    }

    {
        let mut active_seed = state.active_seed.lock().unwrap();
        *active_seed = Some(seed_id.clone());
    }

    // Persist to keyring so it survives restarts
    let _ = save_to_keyring(&ppk(&state, "active-seed"), &seed_id);

    info!("Active seed: {}...", &seed_id[..8]);
    emit_log(&app, &format!("[INFO] Active seed: {}...", &seed_id[..8]));
    emit_state(&app, &state);

    Ok(())
}

/// Rename a seed
#[tauri::command]
pub fn rename_seed(
    app: AppHandle,
    state: State<'_, AppState>,
    seed_id: String,
    name: String,
) -> Result<(), String> {
    {
        let mut seeds = state.seeds.lock().unwrap();
        if let Some(s) = seeds.iter_mut().find(|s| s.id == seed_id) {
            s.name = name.clone();
        } else {
            return Err("Seed not found".to_string());
        }
    }
    state.save_seeds()?;

    info!("Renamed seed {}", &seed_id[..8]);
    emit_log(&app, &format!("[INFO] Renamed seed to '{}'", &name));
    emit_state(&app, &state);

    Ok(())
}

/// Rename a keypair
#[tauri::command]
pub fn rename_keypair(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    {
        let mut keypairs = state.keypairs.lock().unwrap();
        if let Some(kp) = keypairs.iter_mut().find(|kp| kp.pubkey == pubkey) {
            kp.name = Some(name.clone());
        } else {
            return Err("Keypair not found".to_string());
        }
    }
    state.save_keypairs()?;

    info!("Renamed keypair {}...", &pubkey[..16]);
    emit_log(&app, &format!("[INFO] Renamed keypair to '{}'", &name));
    emit_state(&app, &state);

    Ok(())
}

/// Export seed words (mnemonic) from keyring — for viewing backup
#[tauri::command]
pub fn export_seed_words(
    state: State<'_, AppState>,
    seed_id: String,
) -> Result<String, String> {
    // Verify seed exists
    {
        let seeds = state.seeds.lock().unwrap();
        if !seeds.iter().any(|s| s.id == seed_id) {
            return Err("Seed not found".to_string());
        }
    }

    get_raw_from_keyring(&ppk(&state, &format!("seed-{}", seed_id)))
}

/// Save eCash state (proofs, mints, history, pending) for a given pubkey.
/// Each field is stored in its own keyring entry to avoid size limits.
#[tauri::command]
pub fn save_ecash_state(
    state: State<'_, AppState>,
    pubkey: String,
    proofs_json: String,
    mints_json: String,
    history_json: String,
    pending_json: String,
    discovered_json: String,
) -> Result<(), String> {
    let pid = state.profile_id();
    save_raw_to_keyring(&format!("p-{}/ecash-proofs-{}", pid, pubkey), &proofs_json)?;
    save_raw_to_keyring(&format!("p-{}/ecash-mints-{}", pid, pubkey), &mints_json)?;
    save_raw_to_keyring(&format!("p-{}/ecash-history-{}", pid, pubkey), &history_json)?;
    save_raw_to_keyring(&format!("p-{}/ecash-pending-{}", pid, pubkey), &pending_json)?;
    save_raw_to_keyring(&format!("p-{}/ecash-discovered-{}", pid, pubkey), &discovered_json)?;
    Ok(())
}

/// Load eCash state for a given pubkey.
/// Returns JSON strings for each field, or empty defaults if not found.
#[tauri::command]
pub fn load_ecash_state(
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<serde_json::Value, String> {
    let pid = state.profile_id();
    let proofs = get_raw_from_keyring(&format!("p-{}/ecash-proofs-{}", pid, pubkey))
        .unwrap_or_else(|_| "[]".to_string());
    let mints = get_raw_from_keyring(&format!("p-{}/ecash-mints-{}", pid, pubkey))
        .unwrap_or_else(|_| "{}".to_string());
    let history = get_raw_from_keyring(&format!("p-{}/ecash-history-{}", pid, pubkey))
        .unwrap_or_else(|_| "[]".to_string());
    let pending = get_raw_from_keyring(&format!("p-{}/ecash-pending-{}", pid, pubkey))
        .unwrap_or_else(|_| "[]".to_string());
    let discovered = get_raw_from_keyring(&format!("p-{}/ecash-discovered-{}", pid, pubkey))
        .unwrap_or_else(|_| "{}".to_string());

    Ok(serde_json::json!({
        "proofs": serde_json::from_str::<serde_json::Value>(&proofs).unwrap_or(serde_json::json!([])),
        "mints": serde_json::from_str::<serde_json::Value>(&mints).unwrap_or(serde_json::json!({})),
        "history": serde_json::from_str::<serde_json::Value>(&history).unwrap_or(serde_json::json!([])),
        "pending": serde_json::from_str::<serde_json::Value>(&pending).unwrap_or(serde_json::json!([])),
        "discovered": serde_json::from_str::<serde_json::Value>(&discovered).unwrap_or(serde_json::json!({})),
    }))
}

// ─── PIN Management ─────────────────────────────────────────────────────

fn hash_pin(pin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pin.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Set PIN for the currently active profile
#[tauri::command]
pub fn set_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<(), String> {
    if pin.len() != 8 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be exactly 8 digits".to_string());
    }
    let hashed = hash_pin(&pin);
    let profile_id = state.profile_id();

    // Update the profile's pin_hash in the profiles index
    {
        let mut profiles = state.profiles.lock().unwrap();
        if let Some(p) = profiles.iter_mut().find(|p| p.id == profile_id) {
            p.pin_hash = hashed.clone();
        }
    }
    state.save_profiles()?;

    *state.pin_hash.lock().unwrap() = Some(hashed);
    info!("PIN set successfully for profile {}", &profile_id[..8]);
    app.emit("app-state", state.to_app_payload()).ok();
    Ok(())
}

/// Verify PIN against a specific profile (or active profile if not specified)
#[tauri::command]
pub fn verify_pin(
    state: State<'_, AppState>,
    pin: String,
    profile_id: Option<String>,
) -> Result<bool, String> {
    let profiles = state.profiles.lock().unwrap();
    let pid = profile_id.unwrap_or_else(|| state.profile_id());
    match profiles.iter().find(|p| p.id == pid) {
        Some(profile) => {
            if profile.pin_hash.is_empty() {
                Err("No PIN is set for this profile".to_string())
            } else {
                Ok(hash_pin(&pin) == profile.pin_hash)
            }
        }
        None => Err("Profile not found".to_string()),
    }
}

#[tauri::command]
pub fn change_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    current_pin: String,
    new_pin: String,
) -> Result<(), String> {
    let profile_id = state.profile_id();

    // Verify current PIN
    {
        let profiles = state.profiles.lock().unwrap();
        let profile = profiles.iter().find(|p| p.id == profile_id)
            .ok_or("Active profile not found")?;
        if hash_pin(&current_pin) != profile.pin_hash {
            return Err("Current PIN is incorrect".to_string());
        }
    }

    // Validate new PIN
    if new_pin.len() != 8 || !new_pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("New PIN must be exactly 8 digits".to_string());
    }
    let hashed = hash_pin(&new_pin);

    // Update profile
    {
        let mut profiles = state.profiles.lock().unwrap();
        if let Some(p) = profiles.iter_mut().find(|p| p.id == profile_id) {
            p.pin_hash = hashed.clone();
        }
    }
    state.save_profiles()?;

    *state.pin_hash.lock().unwrap() = Some(hashed);
    info!("PIN changed for profile {}", &profile_id[..8]);
    app.emit("app-state", state.to_app_payload()).ok();
    Ok(())
}

#[tauri::command]
pub fn remove_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<(), String> {
    let profile_id = state.profile_id();

    // Verify current PIN
    {
        let profiles = state.profiles.lock().unwrap();
        let profile = profiles.iter().find(|p| p.id == profile_id)
            .ok_or("Active profile not found")?;
        if hash_pin(&pin) != profile.pin_hash {
            return Err("PIN is incorrect".to_string());
        }
    }

    // Clear PIN from profile (NOTE: profiles should always have a PIN,
    // but we support clearing for edge cases)
    {
        let mut profiles = state.profiles.lock().unwrap();
        if let Some(p) = profiles.iter_mut().find(|p| p.id == profile_id) {
            p.pin_hash = String::new();
        }
    }
    state.save_profiles()?;

    *state.pin_hash.lock().unwrap() = None;
    info!("PIN removed for profile {}", &profile_id[..8]);
    app.emit("app-state", state.to_app_payload()).ok();
    Ok(())
}

#[tauri::command]
pub fn set_lock_timeout(
    app: AppHandle,
    state: State<'_, AppState>,
    minutes: u32,
) -> Result<(), String> {
    save_to_keyring(&ppk(&state, "lock-timeout"), &minutes)?;
    *state.lock_timeout_minutes.lock().unwrap() = minutes;
    info!("Lock timeout set to {} minutes", minutes);
    app.emit("app-state", state.to_app_payload()).ok();
    Ok(())
}

// ─── Profile Management ─────────────────────────────────────────────────

/// List all profiles (id + name, no secrets)
#[tauri::command]
pub fn list_profiles(
    state: State<'_, AppState>,
) -> Vec<crate::state::ProfileListItem> {
    let profiles = state.profiles.lock().unwrap();
    profiles.iter().map(|p| crate::state::ProfileListItem {
        id: p.id.clone(),
        name: p.name.clone(),
    }).collect()
}

/// Create a new profile with the given PIN
#[tauri::command]
pub fn create_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    pin: String,
) -> Result<String, String> {
    if pin.len() != 8 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be exactly 8 digits".to_string());
    }

    let profile_id = Uuid::new_v4().to_string();
    let hashed = hash_pin(&pin);

    // Determine name: "PIN Account N+1"
    let profile_number = {
        let profiles = state.profiles.lock().unwrap();
        profiles.len() + 1
    };
    let name = format!("PIN Account {}", profile_number);

    let profile = ProfileInfo {
        id: profile_id.clone(),
        name: name.clone(),
        pin_hash: hashed.clone(),
    };

    {
        let mut profiles = state.profiles.lock().unwrap();
        profiles.push(profile);
    }
    state.save_profiles()?;

    // Load (activate) the new profile
    state.load_profile(&profile_id);

    info!("Created profile '{}' ({})", &name, &profile_id[..8]);
    app.emit("app-state", state.to_app_payload()).ok();

    Ok(profile_id)
}

/// Unlock a profile by verifying its PIN, then load its data
#[tauri::command]
pub fn unlock_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    pin: String,
) -> Result<bool, String> {
    // Verify PIN
    let valid = {
        let profiles = state.profiles.lock().unwrap();
        match profiles.iter().find(|p| p.id == profile_id) {
            Some(profile) => {
                if profile.pin_hash.is_empty() {
                    return Err("No PIN is set for this profile".to_string());
                }
                hash_pin(&pin) == profile.pin_hash
            }
            None => return Err("Profile not found".to_string()),
        }
    };

    if valid {
        // Load this profile's data
        state.load_profile(&profile_id);
        info!("Unlocked profile {}", &profile_id[..8]);
        app.emit("app-state", state.to_app_payload()).ok();
    }

    Ok(valid)
}

/// Delete a profile and all its data from keyring
#[tauri::command]
pub fn delete_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    pin: String,
) -> Result<(), String> {
    // Verify PIN for the profile being deleted
    {
        let profiles = state.profiles.lock().unwrap();
        let profile = profiles.iter().find(|p| p.id == profile_id)
            .ok_or("Profile not found")?;
        if !profile.pin_hash.is_empty() && hash_pin(&pin) != profile.pin_hash {
            return Err("PIN is incorrect".to_string());
        }
    }

    // Clean up all keyring entries for this profile
    let pid = &profile_id;
    // Delete per-item keys by reading indexes
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/keypairs-index", pid)) {
        if let Ok(pubkeys) = serde_json::from_str::<Vec<String>>(&index_json) {
            for pk in &pubkeys {
                let _ = delete_raw_from_keyring(&format!("p-{}/sk-{}", pid, pk));
                let _ = delete_raw_from_keyring(&format!("p-{}/kp-{}", pid, pk));
                for ecash_key in &["ecash-proofs-", "ecash-mints-", "ecash-history-", "ecash-pending-", "ecash-discovered-"] {
                    let _ = delete_raw_from_keyring(&format!("p-{}/{}{}", pid, ecash_key, pk));
                }
            }
        }
    }
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/seeds-index", pid)) {
        if let Ok(seed_ids) = serde_json::from_str::<Vec<String>>(&index_json) {
            for sid in &seed_ids {
                let _ = delete_raw_from_keyring(&format!("p-{}/seed-{}", pid, sid));
                let _ = delete_raw_from_keyring(&format!("p-{}/seed-info-{}", pid, sid));
            }
        }
    }
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/connections", pid)) {
        if let Ok(conn_ids) = serde_json::from_str::<Vec<String>>(&index_json) {
            for cid in &conn_ids {
                let _ = delete_raw_from_keyring(&format!("p-{}/conn-{}", pid, cid));
            }
        }
    }
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/upv2-sessions", pid)) {
        if let Ok(sess_ids) = serde_json::from_str::<Vec<String>>(&index_json) {
            for sid in &sess_ids {
                let _ = delete_raw_from_keyring(&format!("p-{}/upv2-sess-{}", pid, sid));
            }
        }
    }
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/login-attempts", pid)) {
        if let Ok(attempt_ids) = serde_json::from_str::<Vec<String>>(&index_json) {
            for aid in &attempt_ids {
                let _ = delete_raw_from_keyring(&format!("p-{}/login-attempt-{}", pid, aid));
            }
        }
    }
    // Delete signing history individual entries
    if let Ok(index_json) = get_raw_from_keyring(&format!("p-{}/signing-history", pid)) {
        if let Ok(entry_ids) = serde_json::from_str::<Vec<String>>(&index_json) {
            for eid in &entry_ids {
                let _ = delete_raw_from_keyring(&format!("p-{}/sh-{}", pid, eid));
            }
        }
    }

    // Delete index keys
    let suffixes = [
        "keypairs-index", "seeds-index", "connections", "relays",
        "upv2-login-key", "upv2-sessions", "login-attempts", "last-online-at",
        "lock-timeout", "active-keypair", "active-seed", "nip46-enabled",
        "signing-history", "user-relays",
    ];
    for suffix in &suffixes {
        let _ = delete_raw_from_keyring(&format!("p-{}/{}", pid, suffix));
    }

    // Remove from profiles list
    let is_active_profile = state.active_profile.lock().unwrap().as_deref() == Some(&profile_id);
    {
        let mut profiles = state.profiles.lock().unwrap();
        profiles.retain(|p| p.id != profile_id);
    }
    state.save_profiles()?;

    // If we deleted the active profile, switch to first remaining
    if is_active_profile {
        let first_id = {
            let profiles = state.profiles.lock().unwrap();
            profiles.first().map(|p| p.id.clone())
        };
        if let Some(_fid) = first_id {
            *state.active_profile.lock().unwrap() = None;
            // Don't auto-load — require PIN on next unlock
        }
    }

    info!("Deleted profile {}", &profile_id[..8]);
    app.emit("app-state", state.to_app_payload()).ok();

    Ok(())
}
