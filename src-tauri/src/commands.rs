use tauri::{Emitter, LogicalSize, PhysicalPosition, State, WebviewWindow};

use crate::settings::AppSettings;
use crate::state::AppState;

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

#[tauri::command]
pub fn resize_window(window: WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    // Reposition to keep bottom anchored
    position_window_bottom_internal(&window)?;
    Ok(())
}

#[tauri::command]
pub fn position_window_bottom(window: WebviewWindow) -> Result<(), String> {
    position_window_bottom_internal(&window)
}

pub fn position_window_bottom_internal(window: &WebviewWindow) -> Result<(), String> {
    let window_size = window.outer_size().map_err(|e| e.to_string())?;

    // Prefer platform work-area APIs (Windows taskbar-aware). Fallback to monitor bounds.
    #[cfg(target_os = "windows")]
    if let Some((left, top, right, bottom)) = windows_work_area() {
        let work_width = (right - left) as f64;
        let work_height = (bottom - top) as f64;
        let window_width = window_size.width as f64;
        let window_height = window_size.height as f64;

        let x = left as f64 + (work_width - window_width) / 2.0;
        let y = top as f64 + work_height - window_height - 10.0;

        window
            .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;

    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();

    let screen_width = monitor_size.width as f64;
    let screen_height = monitor_size.height as f64;
    let window_width = window_size.width as f64;
    let window_height = window_size.height as f64;

    let x = monitor_pos.x as f64 + (screen_width - window_width) / 2.0;
    let y = monitor_pos.y as f64 + screen_height - window_height - 10.0;

    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_work_area() -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};

    let mut rect = RECT::default();
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut rect as *mut _ as _), 0) }
        .as_bool();
    if !ok {
        return None;
    }
    Some((rect.left, rect.top, rect.right, rect.bottom))
}
