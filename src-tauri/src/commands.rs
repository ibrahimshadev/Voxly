use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

use crate::domain::types::VocabularyEntry;
use crate::settings::AppSettings;
use crate::state::AppState;

const SETTINGS_WINDOW_GAP: i32 = 8;

#[cfg(target_os = "windows")]
static CURSOR_PASSTHROUGH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
pub fn start_recording(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    let window = window.clone();
    state.manager.start_recording(move |update| {
        let _ = window.emit("dictation:update", update);
    })
}

#[tauri::command]
pub async fn stop_and_transcribe(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let window = window.clone();
    state
        .manager
        .stop_and_process(move |update| {
            let _ = window.emit("dictation:update", update);
        })
        .await
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.manager.get_settings()
}

#[tauri::command]
pub fn save_settings(settings: AppSettings, state: State<'_, AppState>) -> Result<(), String> {
    state.manager.save_settings(settings)
}

#[tauri::command]
pub fn save_vocabulary(
    vocabulary: Vec<VocabularyEntry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.manager.save_vocabulary(vocabulary)
}

#[tauri::command]
pub async fn test_connection(settings: AppSettings) -> Result<String, String> {
    if settings.api_key.trim().is_empty() {
        return Err("Missing API key".to_string());
    }

    if settings.base_url.trim().is_empty() {
        return Err("Missing base URL".to_string());
    }

    if settings.model.trim().is_empty() {
        return Err("Missing model".to_string());
    }

    Ok("Settings look valid.".to_string())
}

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        return min;
    }
    value.clamp(min, max)
}

#[tauri::command]
pub fn position_window_bottom(window: WebviewWindow) -> Result<(), String> {
    position_window_bottom_internal(&window)
}

#[tauri::command]
pub fn show_settings_window(app: AppHandle) -> Result<(), String> {
    show_settings_window_internal(&app)
}

#[tauri::command]
pub fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    hide_settings_window_internal(&app)
}

#[tauri::command]
pub fn sync_settings_window_position(app: AppHandle) -> Result<(), String> {
    if let Some(settings_window) = app.get_webview_window("settings") {
        if settings_window.is_visible().unwrap_or(false) {
            position_settings_window_internal(&app)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_cursor_passthrough(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::Ordering;
        window
            .set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
        CURSOR_PASSTHROUGH.store(ignore, Ordering::Relaxed);
    }
    let _ = (&window, ignore);
    Ok(())
}

/// Background thread that polls cursor position and re-enables cursor events
/// when the cursor enters the pill's hot zone. Only active on Windows.
#[allow(unused_variables)]
pub fn start_cursor_tracker(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(50));

            if !CURSOR_PASSTHROUGH.load(std::sync::atomic::Ordering::Relaxed) {
                continue;
            }

            let window = match app.get_webview_window("main") {
                Some(w) => w,
                None => break,
            };

            if !window.is_visible().unwrap_or(false) {
                continue;
            }

            let win_pos = match window.outer_position() {
                Ok(p) => p,
                Err(_) => continue,
            };

            let win_size = match window.outer_size() {
                Ok(s) => s,
                Err(_) => continue,
            };

            let cursor = match cursor_position() {
                Some(p) => p,
                None => continue,
            };

            // Hot zone: center 40% width, bottom 50% height of the window.
            // Covers the pill in any state with generous margins.
            let zone_w = win_size.width as i32 * 2 / 5;
            let zone_h = win_size.height as i32 / 2;
            let zone_left = win_pos.x + (win_size.width as i32 - zone_w) / 2;
            let zone_right = zone_left + zone_w;
            let zone_top = win_pos.y + win_size.height as i32 - zone_h;
            let zone_bottom = win_pos.y + win_size.height as i32;

            if cursor.0 >= zone_left
                && cursor.0 <= zone_right
                && cursor.1 >= zone_top
                && cursor.1 <= zone_bottom
            {
                let _ = window.set_ignore_cursor_events(false);
                CURSOR_PASSTHROUGH.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok.is_ok() {
        Some((point.x, point.y))
    } else {
        None
    }
}

pub fn show_settings_window_internal(app: &AppHandle) -> Result<(), String> {
    position_settings_window_internal(app)?;

    let settings_window = app
        .get_webview_window("settings")
        .ok_or("Settings window not found".to_string())?;

    settings_window.show().map_err(|e| e.to_string())?;
    settings_window.set_focus().map_err(|e| e.to_string())?;

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.emit("settings-window-opened", ());
    }
    let _ = settings_window.emit("settings-window-opened", ());

    Ok(())
}

pub fn hide_settings_window_internal(app: &AppHandle) -> Result<(), String> {
    if let Some(settings_window) = app.get_webview_window("settings") {
        settings_window.hide().map_err(|e| e.to_string())?;
        let _ = settings_window.emit("settings-window-closed", ());
    }

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.emit("settings-window-closed", ());
    }

    Ok(())
}

pub fn position_window_bottom_internal(window: &WebviewWindow) -> Result<(), String> {
    let window_size = window.outer_size().map_err(|e| e.to_string())?;

    // Prefer platform work-area APIs (Windows taskbar-aware). Fallback to monitor bounds.
    let (left, top, right, bottom) = work_area_bounds(window)?;
    let work_width = (right - left) as f64;
    let work_height = (bottom - top) as f64;
    let window_width = window_size.width as f64;
    let window_height = window_size.height as f64;

    let x = left as f64 + (work_width - window_width) / 2.0;
    let y = top as f64 + work_height - window_height - 10.0;

    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn position_settings_window_internal(app: &AppHandle) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found".to_string())?;
    let settings_window = app
        .get_webview_window("settings")
        .ok_or("Settings window not found".to_string())?;

    let main_pos = main_window.outer_position().map_err(|e| e.to_string())?;
    let main_size = main_window.outer_size().map_err(|e| e.to_string())?;
    let settings_size = settings_window.outer_size().map_err(|e| e.to_string())?;

    let mut x = main_pos.x + (main_size.width as i32 - settings_size.width as i32) / 2;
    let mut y = main_pos.y - settings_size.height as i32 - SETTINGS_WINDOW_GAP;

    let (min_x, min_y, max_x, max_y) = work_area_bounds(&main_window)?;
    x = clamp_i32(x, min_x, max_x - settings_size.width as i32);
    y = clamp_i32(y, min_y, max_y - settings_size.height as i32);

    settings_window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn work_area_bounds(window: &WebviewWindow) -> Result<(i32, i32, i32, i32), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;

    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();

    let monitor_bounds = (
        monitor_pos.x,
        monitor_pos.y,
        monitor_pos.x + monitor_size.width as i32,
        monitor_pos.y + monitor_size.height as i32,
    );

    #[cfg(target_os = "windows")]
    if let Some((left, top, right, bottom)) = windows_work_area() {
        if rect_inside_rect(
            left,
            top,
            right,
            bottom,
            monitor_bounds.0,
            monitor_bounds.1,
            monitor_bounds.2,
            monitor_bounds.3,
        ) {
            return Ok((left, top, right, bottom));
        }
    }

    Ok(monitor_bounds)
}

#[cfg(target_os = "windows")]
fn rect_inside_rect(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    outer_left: i32,
    outer_top: i32,
    outer_right: i32,
    outer_bottom: i32,
) -> bool {
    left >= outer_left && top >= outer_top && right <= outer_right && bottom <= outer_bottom
}

#[cfg(target_os = "windows")]
fn windows_work_area() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    let mut rect = RECT::default();
    let result = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut _ as _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if result.is_err() {
        return None;
    }
    Some((rect.left, rect.top, rect.right, rect.bottom))
}
