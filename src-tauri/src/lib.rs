mod keys;
mod nip46;
mod pc55;
mod state;
mod updater;
mod upv2;

use state::AppState;
use tauri::Manager;
use tracing::info;

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
                // Hide to tray instead of quitting
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            updater::publish_update_event,
            updater::fetch_version_history,
            updater::write_temp_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DENOS");
}
