// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Fix WebKitGTK rendering on Linux systems with integrated/problematic GPU drivers.
        // Without this, some systems show a white screen instead of the app.
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }

        // Disable WebKitGTK's bubblewrap sandbox for package-managed installs (.deb, .rpm, Arch).
        // The sandbox blocks outbound WebSocket connections (relays) and localhost binding (NIP-PC55).
        // AppImage bundles its own WebKitGTK and isn't affected by the system sandbox.
        if std::env::var("APPIMAGE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }
    }

    denos_lib::run()
}
