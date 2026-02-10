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
                        let _ = commands::show_settings_window_internal(app);
                    }
                    "reset_position" => {
                        if let Some(window) = app.get_webview_window("main") {
                            commands::ensure_main_visible(&window);
                            let _ = commands::position_window_bottom_internal(&window);
                        }
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
                        let _ = commands::show_settings_window_internal(tray.app_handle());
                    }
                })
                .build(app)?;

            // Set crisp window icon (workaround: Tauri ICO parser only reads first entry)
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))
                .expect("failed to load icon");
            if let Some(window) = app.get_webview_window("settings") {
                let _ = window.set_icon(icon.clone());
            }

            // Position window at bottom center, enable click-through
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(icon);
                let _ = commands::position_window_bottom_internal(&window);
                commands::init_click_through(&window);
            }
            commands::start_cursor_tracker(app.handle());
            commands::start_audio_level_emitter(app.handle());

            if let Some(settings_window) = app.get_webview_window("settings") {
                let app_handle = app.handle().clone();
                settings_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = commands::hide_settings_window_internal(&app_handle);
                    }
                });
            }

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
            commands::set_cursor_passthrough,
            commands::set_app_active,
            commands::set_hover_active,
            commands::fetch_provider_models,
            commands::get_transcription_history,
            commands::delete_transcription_history_item,
            commands::clear_transcription_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
