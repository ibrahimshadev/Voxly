#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod audio;
mod clipboard;
mod commands;
mod domain;
mod format_text;
mod models_api;
mod settings;
mod state;
mod transcribe;
mod transcription_history;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::AppState::default())
        .setup(|app| {
            // Create tray menu
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let reset_position_item =
                MenuItem::with_id(app, "reset_position", "Reset Position", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &reset_position_item, &quit_item])?;

            // Build tray icon
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = commands::show_settings_window_internal(app);
                    }
                    "reset_position" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = commands::position_window_bottom_internal(&window);
                        }
                        let _ = commands::sync_settings_window_position(app.clone());
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
                            if window.is_visible().unwrap_or(false) {
                                let _ = commands::hide_settings_window_internal(&app);
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Position window at bottom center, enable click-through
            if let Some(window) = app.get_webview_window("main") {
                let _ = commands::position_window_bottom_internal(&window);
                commands::init_click_through(&window);
            }
            commands::start_cursor_tracker(app.handle());
            let _ = commands::hide_settings_window_internal(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_and_transcribe,
            commands::get_settings,
            commands::save_settings,
            commands::save_vocabulary,
            commands::test_connection,
            commands::position_window_bottom,
            commands::show_settings_window,
            commands::hide_settings_window,
            commands::sync_settings_window_position,
            commands::set_cursor_passthrough,
            commands::fetch_provider_models,
            commands::get_transcription_history,
            commands::delete_transcription_history_item,
            commands::clear_transcription_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
