mod keys;
mod nip46;
mod pc55;
mod state;
mod updater;
mod upv2;

use state::AppState;
use tauri::Manager;
use tracing::info;

/// Round the corners of the calling window (Windows 11 borderless popup) AND suppress the OS
/// window border, so only the app's own CSS border shows (otherwise there are two borders).
/// No-op elsewhere.
#[cfg(target_os = "windows")]
#[tauri::command]
fn round_window_corners(window: tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE};
    const DWMWCP_ROUND: i32 = 2; // DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_ROUND
    const DWMWA_BORDER_COLOR: i32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE; // "no border"
    if let Ok(hwnd) = window.hwnd() {
        let pref: i32 = DWMWCP_ROUND;
        let none: u32 = DWMWA_COLOR_NONE;
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as _,
                &pref as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            );
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_BORDER_COLOR as _,
                &none as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn round_window_corners(_window: tauri::WebviewWindow) {}

/// Size the popup and place it at the bottom-right of the monitor work area, computed entirely in
/// Rust from the ACTUAL window size (so we never mis-assume the width) and the real work area (so we
/// clear the taskbar). Deterministic — no JS coordinates / DPI assumptions.
#[cfg(target_os = "windows")]
#[tauri::command]
fn place_notif(window: tauri::WebviewWindow, width: f64, height: f64) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let mut wa = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut wa as *mut RECT as *mut core::ffi::c_void, 0)
    };
    if ok != 0 {
        let scale = window.scale_factor().unwrap_or(1.0);
        let margin = (10.0 * scale).round() as i32;
        // Use the ACTUAL outer size (physical) so the right/bottom margins are correct regardless of
        // the real window width/height.
        let (ww, hh) = window.outer_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or(((width * scale) as i32, (height * scale) as i32));
        let x = wa.right - ww - margin;
        let y = wa.bottom - hh - margin;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn place_notif(window: tauri::WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Ok(Some(m)) = window.current_monitor() {
        let s = m.size();
        let p = m.position();
        let scale = window.scale_factor().unwrap_or(1.0);
        let margin = (10.0 * scale).round() as i32;
        let (ww, hh) = window.outer_size()
            .map(|o| (o.width as i32, o.height as i32))
            .unwrap_or(((width * scale) as i32, (height * scale) as i32));
        let x = p.x + s.width as i32 - ww - margin;
        // Rough taskbar/dock allowance since there's no work-area query here.
        let y = p.y + s.height as i32 - hh - margin - (48.0 * scale).round() as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();
    info!("DENOS starting...");

    let app_state = AppState::new();
    let profiles_count = app_state.profiles.lock().unwrap().len();
    info!("Loaded {} profiles from keyring", profiles_count);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched — show and focus the existing window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

            let show_i = MenuItem::with_id(app, "show", "Show DENOS", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("DENOS — Nostr Signer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide the MAIN window to tray instead of quitting. Other windows (e.g. the
                // signing-request popup `signer-notif`) must close for real — hiding them would
                // leave a stale window that blocks any future popup from being created.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            round_window_corners,
            place_notif,
            // Key management
            keys::ping,
            keys::get_app_state,
            keys::generate_keypair,
            keys::import_nsec,
            keys::import_seed,
            keys::delete_keypair,
            keys::set_active_keypair,
            keys::export_nsec,
            keys::export_private_key_hex,
            keys::list_keypairs,
            // Seed management
            keys::generate_seed,
            keys::import_seed_phrase,
            keys::derive_next_keypair,
            keys::derive_keypair_at_index,
            keys::delete_seed,
            keys::set_active_seed,
            keys::rename_seed,
            keys::rename_keypair,
            keys::export_seed_words,
            // eCash state persistence
            keys::save_ecash_state,
            keys::load_ecash_state,
            // PIN lock
            keys::set_pin,
            keys::verify_pin,
            keys::change_pin,
            keys::remove_pin,
            keys::set_lock_timeout,
            // Profile management
            keys::list_profiles,
            keys::create_profile,
            keys::unlock_profile,
            keys::delete_profile,
            // NIP-46 signer
            nip46::get_signer_state,
            nip46::start_signer,
            nip46::stop_signer,
            nip46::get_bunker_uri,
            nip46::parse_nostrconnect_uri,
            nip46::connect_nostrconnect,
            nip46::approve_request,
            nip46::reject_request,
            nip46::list_connections,
            nip46::delete_connection,
            nip46::set_connection_policy,
            nip46::set_custom_rule,
            nip46::remove_custom_rule,
            nip46::update_connection_rules,
            nip46::resolve_reconnect,
            nip46::set_connection_auto_replace,
            nip46::add_relay,
            nip46::remove_relay,
            nip46::reset_relays,
            nip46::list_relays,
            nip46::add_user_relay,
            nip46::remove_user_relay,
            nip46::fetch_user_relays,
            nip46::fetch_user_blossom_servers,
            nip46::publish_user_relays,
            nip46::publish_user_blossom_servers,
            nip46::sign_event_local,
            nip46::toggle_nip46_enabled,
            nip46::get_signing_history,
            // NIP-UPV2
            upv2::set_upv2_password,
            upv2::toggle_upv2_enabled,
            upv2::delete_upv2_password,
            upv2::list_upv2_sessions,
            upv2::revoke_upv2_session,
            upv2::get_upv2_login_key,
            upv2::dismiss_login_attempt,
            upv2::dismiss_all_offline_attempts,
            upv2::set_upv2_session_policy,
            upv2::set_upv2_custom_rule,
            upv2::remove_upv2_custom_rule,
            upv2::set_upv2_session_auto_replace,
            // NIP-PC55 local signer
            pc55::start_pc55_server,
            pc55::stop_pc55_server,
            pc55::get_pc55_state,
            // Updater
            updater::check_for_update,
            updater::download_and_install_update,
            updater::upload_to_blossom,
            updater::cancel_blossom_upload,
            updater::publish_update_event,
            updater::fetch_version_history,
            updater::write_temp_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DENOS");
}
