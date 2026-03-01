use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};
use std::collections::HashMap;

use crate::AppState;

/// DENOS creator's public key (hex)
const DENOS_CREATOR_PUBKEY: &str = "3cea4806b1e1a9829d30d5cb8a78011d4271c6474eb31531ec91f28110fe3f40";

/// The d-tag for the "latest" pointer event (replaceable, auto-updater target)
const UPDATE_D_TAG_LATEST: &str = "denos-latest";

/// The s-tag value used to group all version history events for easy querying
const VERSIONS_GROUP_TAG: &str = "denos-versions";

/// Platform-specific binary info in the update manifest
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlatformBinary {
    /// SHA-256 hash of the binary (also serves as the Blossom file ID)
    pub hash: String,
    /// File extension (e.g., "nsis.zip", "AppImage.tar.gz", "app.tar.gz")
    pub ext: String,
}

/// The update manifest stored in the kind:30078 event content
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    /// Map of target triple → binary info
    /// e.g., "windows-x86_64" → { hash, ext }
    pub platforms: HashMap<String, PlatformBinary>,
}

/// Info returned to the frontend when an update is available
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub current_version: String,
    pub new_version: String,
    pub notes: String,
    pub pub_date: String,
    /// Whether a binary is available for the current platform
    pub has_platform_binary: bool,
    /// The platform key (e.g., "windows-x86_64")
    pub platform: String,
    /// The Blossom hash for this platform's binary
    pub binary_hash: Option<String>,
    /// The file extension for this platform's binary
    pub binary_ext: Option<String>,
}

/// Determine the Tauri update platform target string
fn get_current_platform() -> String {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_name = match os {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "darwin",
        _ => os,
    };
    format!("{}-{}", os_name, arch)
}

/// Check for updates by fetching the kind:30078 event from relays.
/// Returns Some(UpdateInfo) if a newer version is available, None otherwise.
#[tauri::command]
pub async fn check_for_update(
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let creator_pk = PublicKey::from_hex(DENOS_CREATOR_PUBKEY)
        .map_err(|e| format!("Invalid creator pubkey: {}", e))?;

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // Fetch the latest kind:30078 event with d=denos-latest from the creator
    let filter = Filter::new()
        .kind(Kind::Custom(30078))
        .author(creator_pk)
        .identifier(UPDATE_D_TAG_LATEST)
        .limit(1);

    let events: Vec<Event> = match client.fetch_events(filter, std::time::Duration::from_secs(8)).await {
        Ok(evs) => evs.into_iter().collect(),
        Err(e) => {
            warn!("[Updater] Failed to fetch update event: {}", e);
            return Err(format!("Failed to fetch update info: {}", e));
        }
    };

    let event = match events.first() {
        Some(e) => e,
        None => {
            info!("[Updater] No update event found on relays");
            return Ok(None);
        }
    };

    // Parse the manifest from event content
    let manifest: UpdateManifest = serde_json::from_str(&event.content)
        .map_err(|e| format!("Failed to parse update manifest: {}", e))?;

    // Compare versions (simple string comparison — works for semver)
    if !is_newer_version(&current_version, &manifest.version) {
        info!("[Updater] Current version {} is up to date (latest: {})", current_version, manifest.version);
        return Ok(None);
    }

    info!("[Updater] Update available: {} → {}", current_version, manifest.version);

    let platform = get_current_platform();
    // On Linux, prefer the raw binary for package-managed installs (deb/rpm/pkg)
    // AppImage users get the AppImage, package-managed users get the raw binary
    let platform_binary = if platform == "linux-x86_64" || platform == "linux-aarch64" {
        let is_appimage = std::env::var("APPIMAGE").is_ok();
        if is_appimage {
            manifest.platforms.get(&platform)
        } else {
            // Try linux-x86_64-bin first, fall back to the AppImage entry
            let bin_key = format!("{}-bin", platform);
            manifest.platforms.get(&bin_key).or_else(|| manifest.platforms.get(&platform))
        }
    } else {
        manifest.platforms.get(&platform)
    };

    Ok(Some(UpdateInfo {
        current_version,
        new_version: manifest.version,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        has_platform_binary: platform_binary.is_some(),
        platform,
        binary_hash: platform_binary.map(|b| b.hash.clone()),
        binary_ext: platform_binary.map(|b| b.ext.clone()),
    }))
}

/// Simple semver comparison: returns true if `new` is greater than `current`
fn is_newer_version(current: &str, new: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|s| s.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let c = parse(current);
    let n = parse(new);
    for i in 0..std::cmp::max(c.len(), n.len()) {
        let cv = c.get(i).copied().unwrap_or(0);
        let nv = n.get(i).copied().unwrap_or(0);
        if nv > cv {
            return true;
        }
        if nv < cv {
            return false;
        }
    }
    false
}

/// Download and install an update from Blossom servers.
/// Cycles through configured Blossom servers, verifies SHA-256, then runs the installer.
#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    hash: String,
    ext: String,
    blossom_servers: Vec<String>,
) -> Result<String, String> {
    use sha2::{Sha256, Digest};
    use std::io::Write;

    if blossom_servers.is_empty() {
        return Err("No Blossom servers configured".to_string());
    }

    info!("[Updater] Downloading update: {}.{}", hash, ext);

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut last_error = String::new();
    let mut binary_data: Option<Vec<u8>> = None;

    // Try each Blossom server
    for server in &blossom_servers {
        let base = server.trim_end_matches('/');
        let url = format!("{}/{}.{}", base, hash, ext);
        info!("[Updater] Trying: {}", url);

        match http_client.get(&url).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.bytes().await {
                        Ok(bytes) => {
                            // Verify SHA-256
                            let mut hasher = Sha256::new();
                            hasher.update(&bytes);
                            let computed = format!("{:x}", hasher.finalize());

                            if computed == hash {
                                info!("[Updater] SHA-256 verified: {} ({} bytes)", computed, bytes.len());
                                binary_data = Some(bytes.to_vec());
                                break;
                            } else {
                                last_error = format!("Hash mismatch from {}: expected {} got {}", server, hash, computed);
                                warn!("[Updater] {}", last_error);
                            }
                        }
                        Err(e) => {
                            last_error = format!("Failed to read body from {}: {}", server, e);
                            warn!("[Updater] {}", last_error);
                        }
                    }
                } else {
                    last_error = format!("{} returned {}", server, resp.status());
                    warn!("[Updater] {}", last_error);
                }
            }
            Err(e) => {
                last_error = format!("Failed to connect to {}: {}", server, e);
                warn!("[Updater] {}", last_error);
            }
        }
    }

    let data = binary_data.ok_or_else(|| format!("All Blossom servers failed. Last error: {}", last_error))?;

    // Write to temp directory
    let temp_dir = std::env::temp_dir();
    let filename = format!("denos_update_{}.{}", &hash[..8], ext);
    let temp_path = temp_dir.join(&filename);

    let mut file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    file.write_all(&data)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;
    drop(file);

    info!("[Updater] Saved to: {:?}", temp_path);

    // Platform-specific install
    let os = std::env::consts::OS;
    match os {
        "windows" => {
            // Launch NSIS installer silently, then exit the current app
            info!("[Updater] Launching Windows installer: {:?}", temp_path);
            std::process::Command::new(&temp_path)
                .args(&["/S", "/NCRC"])
                .spawn()
                .map_err(|e| format!("Failed to launch installer: {}", e))?;

            // Give installer a moment to start, then exit
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            std::process::exit(0);
        }
        #[cfg(target_os = "linux")]
        "linux" => {
            use std::os::unix::fs::PermissionsExt;

            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to chmod: {}", e))?;

            let is_appimage = std::env::var("APPIMAGE").is_ok();

            if is_appimage {
                // AppImage: replace the AppImage file directly
                let current_exe = std::env::current_exe()
                    .map_err(|e| format!("Failed to get current exe: {}", e))?;

                std::fs::rename(&temp_path, &current_exe)
                    .map_err(|e| format!("Failed to replace AppImage: {}", e))?;

                info!("[Updater] AppImage replaced, restarting…");
            } else {
                // Package-managed (deb/rpm/pkg): use pkexec to copy with root permissions
                let current_exe = std::env::current_exe()
                    .map_err(|e| format!("Failed to get current exe: {}", e))?;

                let status = std::process::Command::new("pkexec")
                    .args(&["cp", &temp_path.to_string_lossy(), &current_exe.to_string_lossy()])
                    .status()
                    .map_err(|e| format!("Failed to run pkexec: {}", e))?;

                if !status.success() {
                    return Err("Update cancelled or pkexec failed".to_string());
                }

                // Clean up temp file
                let _ = std::fs::remove_file(&temp_path);

                info!("[Updater] Binary replaced via pkexec, restarting…");
            }

            app.restart();
        }
        #[cfg(target_os = "macos")]
        "macos" => {
            // Mount the DMG
            let mount_output = std::process::Command::new("hdiutil")
                .args(&["attach", &temp_path.to_string_lossy(), "-nobrowse", "-noautoopen"])
                .output()
                .map_err(|e| format!("Failed to mount DMG: {}", e))?;

            if !mount_output.status.success() {
                return Err(format!("Failed to mount DMG: {}", String::from_utf8_lossy(&mount_output.stderr)));
            }

            // Parse mount point from hdiutil output (last column of last line with /Volumes/)
            let stdout = String::from_utf8_lossy(&mount_output.stdout);
            let mount_point = stdout.lines()
                .filter_map(|line| {
                    let trimmed = line.trim();
                    if let Some(idx) = trimmed.find("/Volumes/") {
                        Some(trimmed[idx..].to_string())
                    } else {
                        None
                    }
                })
                .last()
                .ok_or_else(|| "Could not find mount point in hdiutil output".to_string())?;

            info!("[Updater] DMG mounted at: {}", mount_point);

            // Find the .app inside the mounted DMG
            let mount_dir = std::path::Path::new(&mount_point);
            let app_bundle = std::fs::read_dir(mount_dir)
                .map_err(|e| format!("Failed to read DMG contents: {}", e))?
                .filter_map(|e| e.ok())
                .find(|e| e.path().extension().map_or(false, |ext| ext == "app"))
                .ok_or_else(|| "No .app found in DMG".to_string())?;

            let app_name = app_bundle.file_name();
            let dest = std::path::Path::new("/Applications").join(&app_name);

            info!("[Updater] Copying {:?} to {:?}", app_bundle.path(), dest);

            // Remove old app and copy new one
            let _ = std::fs::remove_dir_all(&dest);
            let copy_status = std::process::Command::new("cp")
                .args(&["-R", &app_bundle.path().to_string_lossy(), &dest.to_string_lossy()])
                .status()
                .map_err(|e| format!("Failed to copy app: {}", e))?;

            if !copy_status.success() {
                // Unmount before returning error
                let _ = std::process::Command::new("hdiutil").args(&["detach", &mount_point]).status();
                return Err("Failed to copy .app to /Applications".to_string());
            }

            // Unmount DMG
            let _ = std::process::Command::new("hdiutil")
                .args(&["detach", &mount_point])
                .status();

            // Clean up temp DMG
            let _ = std::fs::remove_file(&temp_path);

            info!("[Updater] macOS app updated, restarting…");
            app.restart();
        }
        _ => {
            return Err(format!("Unsupported OS: {}", os));
        }
    }
}

/// Upload a file to a Blossom server using BUD-02 PUT.
/// Emits `upload-progress` events with bytes_sent/total_bytes.
/// Returns the URL on success.
#[tauri::command]
pub async fn upload_to_blossom(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    server_url: String,
    platform: String,
) -> Result<String, String> {
    use sha2::{Sha256, Digest};
    use base64::Engine;
    use tauri::Emitter;

    let data = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Compute SHA-256 hash
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let file_hash = format!("{:x}", hasher.finalize());

    let file_size = data.len();
    let server_host = url::Url::parse(&server_url)
        .map(|u| u.host_str().unwrap_or("unknown").to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    info!("[Blossom] Uploading {}: {} bytes, hash={}", file_path, file_size, file_hash);

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // Create BUD-02 auth event (kind 24242) — signed via signer_client
    let expiration = Timestamp::from(
        Timestamp::now().as_u64() + 300 // 5 min expiry
    );

    let auth_builder = EventBuilder::new(Kind::Custom(24242), "Upload")
        .tag(Tag::custom(TagKind::Custom("t".into()), vec!["upload".to_string()]))
        .tag(Tag::custom(TagKind::Custom("x".into()), vec![file_hash.clone()]))
        .tag(Tag::custom(TagKind::Custom("size".into()), vec![file_size.to_string()]))
        .tag(Tag::expiration(expiration));

    let auth_event = client.sign_event_builder(auth_builder).await
        .map_err(|e| format!("Failed to sign auth event: {}", e))?;

    let auth_json = serde_json::to_string(&auth_event)
        .map_err(|e| format!("Failed to serialize auth event: {}", e))?;
    let auth_b64 = base64::engine::general_purpose::STANDARD.encode(auth_json.as_bytes());

    // PUT to Blossom server with progress tracking
    let base = server_url.trim_end_matches('/');
    let upload_url = format!("{}/upload", base);

    // Create a streaming body that emits progress events
    let chunk_size: usize = 65536; // 64KB chunks
    let total = file_size;
    let app_clone = app.clone();
    let platform_clone = platform.clone();
    let server_clone = server_host.clone();

    let stream = async_stream::stream! {
        let mut sent: usize = 0;
        for chunk_start in (0..data.len()).step_by(chunk_size) {
            let chunk_end = std::cmp::min(chunk_start + chunk_size, data.len());
            let chunk = data[chunk_start..chunk_end].to_vec();
            sent += chunk.len();

            let _ = app_clone.emit("upload-progress", serde_json::json!({
                "platform": platform_clone,
                "server": server_clone,
                "bytes_sent": sent,
                "total_bytes": total,
            }));

            yield Ok::<_, std::io::Error>(bytes::Bytes::from(chunk));
        }
    };

    let body = reqwest::Body::wrap_stream(stream);

    let http_client = reqwest::Client::new();
    let resp = http_client.put(&upload_url)
        .header("Authorization", format!("Nostr {}", auth_b64))
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", total.to_string())
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {}", e))?;

    if resp.status().is_success() {
        let blob_url = format!("{}/{}", base, file_hash);
        info!("[Blossom] Upload success: {}", blob_url);
        Ok(blob_url)
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Upload failed ({}): {}", status, body))
    }
}

/// Publish a kind:30078 update manifest event.
/// Publishes TWO events:
///   1. d="denos-latest" — replaceable pointer for auto-updaters
///   2. d="denos-v{version}" + s="denos-versions" — permanent version history record
#[tauri::command]
pub async fn publish_update_event(
    state: State<'_, AppState>,
    manifest_json: String,
) -> Result<String, String> {
    // Parse to validate and extract version
    let manifest: UpdateManifest = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Invalid manifest JSON: {}", e))?;

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // 1) Publish the "latest" pointer (replaceable — overwritten each release)
    //    Strip "source" field — updaters don't need it, only the versioned event keeps it
    let latest_json = {
        let mut val: serde_json::Value = serde_json::from_str(&manifest_json)
            .map_err(|e| format!("Invalid manifest JSON: {}", e))?;
        if let Some(obj) = val.as_object_mut() { obj.remove("source"); }
        serde_json::to_string(&val).unwrap_or_else(|_| manifest_json.clone())
    };
    let latest_builder = EventBuilder::new(Kind::Custom(30078), &latest_json)
        .tag(Tag::identifier(UPDATE_D_TAG_LATEST));

    let latest_event = client.sign_event_builder(latest_builder).await
        .map_err(|e| format!("Failed to sign latest event: {}", e))?;

    let latest_id = latest_event.id.to_hex();

    client.send_event(latest_event).await
        .map_err(|e| format!("Failed to publish latest: {}", e))?;

    info!("[Updater] Published denos-latest event: {}", latest_id);

    // 2) Publish the versioned history record (permanent — unique d-tag per version)
    let version_d_tag = format!("denos-v{}", manifest.version);
    let version_builder = EventBuilder::new(Kind::Custom(30078), &manifest_json)
        .tag(Tag::identifier(&version_d_tag))
        .tag(Tag::custom(TagKind::from("s"), vec![VERSIONS_GROUP_TAG.to_string()]))
        .tag(Tag::custom(TagKind::from("version"), vec![manifest.version.clone()]));

    let version_event = client.sign_event_builder(version_builder).await
        .map_err(|e| format!("Failed to sign version event: {}", e))?;

    let version_id = version_event.id.to_hex();

    client.send_event(version_event).await
        .map_err(|e| format!("Failed to publish version event: {}", e))?;

    info!("[Updater] Published denos-v{} event: {}", manifest.version, version_id);

    Ok(latest_id)
}

/// Fetch all published version history events from Nostr.
/// Queries kind:30078 events with s="denos-versions" from the DENOS creator.
#[tauri::command]
pub async fn fetch_version_history(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let creator_pk = PublicKey::from_hex(DENOS_CREATOR_PUBKEY)
        .map_err(|e| format!("Invalid creator pubkey: {}", e))?;

    let client = {
        let sc = state.signer_client.lock().unwrap();
        sc.clone().ok_or_else(|| "Signer not running".to_string())?
    };

    // Query all version events with s=denos-versions
    let filter = Filter::new()
        .kind(Kind::Custom(30078))
        .author(creator_pk)
        .custom_tag(SingleLetterTag::lowercase(Alphabet::S), VERSIONS_GROUP_TAG);

    let events: Vec<Event> = match client.fetch_events(filter, std::time::Duration::from_secs(8)).await {
        Ok(evs) => {
            let mut v: Vec<Event> = evs.into_iter().collect();
            v.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // newest first
            v
        }
        Err(e) => return Err(format!("Failed to fetch version history: {}", e)),
    };

    let mut results: Vec<serde_json::Value> = Vec::new();
    for event in &events {
        // Parse the manifest from content
        if let Ok(manifest) = serde_json::from_str::<UpdateManifest>(&event.content) {
            // Build platform download URLs from the manifest
            let mut platforms = serde_json::Map::new();
            for (target, binary) in &manifest.platforms {
                platforms.insert(target.clone(), serde_json::json!({
                    "hash": binary.hash,
                    "ext": binary.ext,
                }));
            }

            results.push(serde_json::json!({
                "version": manifest.version,
                "notes": manifest.notes,
                "pub_date": manifest.pub_date,
                "platforms": platforms,
                "created_at": event.created_at.as_u64(),
            }));
        }
    }

    info!("[Updater] Fetched {} version history entries", results.len());
    Ok(results)
}
/// Write base64-encoded data to a temp file and return the path.
/// Used by the publish flow to stage binaries before Blossom upload.
#[tauri::command]
pub async fn write_temp_file(
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;

    let data = base64::engine::general_purpose::STANDARD.decode(&data_base64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join(&filename);

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    file.write_all(&data)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    let path_str = path.to_string_lossy().to_string();
    info!("[Updater] Wrote temp file: {} ({} bytes)", path_str, data.len());
    Ok(path_str)
}
