// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Fix WebKitGTK rendering on Linux systems with integrated/problematic GPU drivers.
    // Without this, some systems show a white screen instead of the app.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    denos_lib::run()
}
