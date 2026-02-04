#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod audio;
mod clipboard;
mod commands;
mod domain;
mod settings;
mod state;
mod transcribe;

use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Emitter, Manager,
};

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .manage(state::AppState::default())
    .setup(|app| {
      // Create tray menu
      let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
      let reset_position_item = MenuItem::with_id(app, "reset_position", "Reset Position", true, None::<&str>)?;
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
              let _ = window.emit("show-settings", ());
            }
          }
          "reset_position" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
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
            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
              if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
              } else {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
          }
        })
        .build(app)?;

      // Position window at bottom center
      if let Some(window) = app.get_webview_window("main") {
        let _ = commands::position_window_bottom_internal(&window);
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
      commands::resize_window,
      commands::position_window_bottom,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
