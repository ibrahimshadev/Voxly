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
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;
    let current_size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    let desired_width = (width as f64 * scale).round() as i32;
    let desired_height = (height as f64 * scale).round() as i32;

    let center_x = current_pos.x + (current_size.width as i32 / 2);
    let bottom_y = current_pos.y + current_size.height as i32;

    let mut new_x = center_x - (desired_width / 2);
    let mut new_y = bottom_y - desired_height;

    let (min_x, min_y, max_x, max_y) = work_area_bounds(&window)?;

    let max_x = max_x - desired_width;
    let max_y = max_y - desired_height;

    new_x = clamp_i32(new_x, min_x, max_x);
    new_y = clamp_i32(new_y, min_y, max_y);

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(new_x, new_y))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn position_window_bottom(window: WebviewWindow) -> Result<(), String> {
    position_window_bottom_internal(&window)
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

fn clamp_i32(value: i32, min: i32, max: i32) -> i32 {
    if max < min {
        return min;
    }
    value.clamp(min, max)
}

fn work_area_bounds(window: &WebviewWindow) -> Result<(i32, i32, i32, i32), String> {
    #[cfg(target_os = "windows")]
    if let Some((left, top, right, bottom)) = windows_work_area() {
        return Ok((left, top, right, bottom));
    }

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor found")?;

    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();

    Ok((
        monitor_pos.x,
        monitor_pos.y,
        monitor_pos.x + monitor_size.width as i32,
        monitor_pos.y + monitor_size.height as i32,
    ))
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
