use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

use crate::domain::types::VocabularyEntry;
use crate::meeting::{
    MeetingDetail, MeetingDevices, MeetingMeta, MeetingStartOptions, MeetingUpdate,
};
use crate::settings::AppSettings;
use crate::state::AppState;
use crate::transcription_history::{HistoryPage, HistoryStats};

#[derive(serde::Serialize, Clone)]
struct AudioLevelPayload {
    rms_db: f32,
    peak_db: f32,
}

/// Full recovery for the main window: re-apply layered attributes, ensure
/// always-on-top, and show the window. Called by reset_position and the
/// periodic watchdog.
pub fn ensure_main_visible(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    crate::click_through::ensure_visible(window);
}

#[tauri::command]
pub fn update_hit_region(
    window: WebviewWindow,
    rects: Vec<crate::click_through::HitRect>,
) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    crate::click_through::update_region(rects, scale, &window);
    Ok(())
}

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
    let app = window.app_handle();
    let update_window = window.clone();
    let result = state
        .manager
        .stop_and_process(move |update| {
            let _ = update_window.emit("dictation:update", update);
        })
        .await;

    if let Some(message) = crate::transcription_history::take_runtime_error() {
        let _ = app.emit("transcription-history-error", message);
    }

    if result.is_ok() {
        let _ = app.emit("transcription-history-updated", ());
    }

    result
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

    let trimmed = settings.base_url.trim_end_matches('/');
    let url = format!("{trimmed}/models");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .bearer_auth(&settings.api_key)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Connection timed out — check your base URL.".to_string()
            } else if e.is_connect() {
                format!("Connection failed — could not reach {trimmed}")
            } else {
                format!("Request failed: {e}")
            }
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Authentication failed — check your API key.".to_string());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("Access denied — your API key may lack permissions.".to_string());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API returned {status}: {body}"));
    }

    Ok("Connection successful — API key is valid.".to_string())
}

#[tauri::command]
pub async fn fetch_provider_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    let result = crate::models_api::fetch_models(&base_url, &api_key).await;
    if let Err(ref e) = result {
        eprintln!("fetch_provider_models error: {e}");
    }
    result
}

#[tauri::command]
pub fn get_transcription_history(
    offset: Option<u32>,
    limit: Option<u32>,
    query: Option<String>,
) -> Result<HistoryPage, String> {
    crate::transcription_history::load_history_page(offset.unwrap_or(0), limit.unwrap_or(50), query)
}

#[tauri::command]
pub fn get_transcription_history_stats(today_start_ms: i64) -> Result<HistoryStats, String> {
    crate::transcription_history::history_stats(today_start_ms)
}

#[tauri::command]
pub fn delete_transcription_history_item(id: String) -> Result<(), String> {
    crate::transcription_history::delete_item(&id)
}

#[tauri::command]
pub fn clear_transcription_history() -> Result<(), String> {
    crate::transcription_history::clear_history()
}

#[tauri::command]
pub fn start_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: MeetingStartOptions,
) -> Result<MeetingMeta, String> {
    let settings = state.manager.get_settings()?;
    let meta = state.meeting_manager.start(app.clone(), &settings, opts)?;
    let _ = app.emit(
        "meeting:update",
        MeetingUpdate {
            state: "recording".to_string(),
            meeting_id: Some(meta.id.clone()),
            message: None,
            elapsed_secs: Some(0),
            file_size_bytes: meta.file_size_bytes,
            progress_pct: None,
        },
    );
    let _ = app.emit("meetings-updated", ());
    Ok(meta)
}

#[tauri::command]
pub fn stop_meeting(app: AppHandle, state: State<'_, AppState>) -> Result<MeetingMeta, String> {
    match state.meeting_manager.stop() {
        Ok(meta) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "stopped".to_string(),
                    meeting_id: Some(meta.id.clone()),
                    message: None,
                    elapsed_secs: meta.duration_secs.map(|value| value.round() as u64),
                    file_size_bytes: meta.file_size_bytes,
                    progress_pct: None,
                },
            );
            let _ = app.emit("meetings-updated", ());
            Ok(meta)
        }
        Err(error) => {
            let _ = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "error".to_string(),
                    meeting_id: None,
                    message: Some(error.clone()),
                    elapsed_secs: None,
                    file_size_bytes: None,
                    progress_pct: None,
                },
            );
            let _ = app.emit("meetings-updated", ());
            Err(error)
        }
    }
}

#[tauri::command]
pub fn transcribe_meeting(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MeetingMeta, String> {
    let settings = state.manager.get_settings()?;
    if !settings.meeting_consent_acknowledged {
        return Err("Acknowledge meeting consent in Settings first.".to_string());
    }
    let api_key = settings.assemblyai_api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("Add your AssemblyAI API key in Meeting settings.".to_string());
    }

    let meta = crate::meeting::transcribe::begin(&id)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::meeting::transcribe::run(app2, api_key, id).await;
    });
    let _ = app.emit("meetings-updated", ());
    Ok(meta)
}

#[tauri::command]
pub fn list_meetings(state: State<'_, AppState>) -> Result<Vec<MeetingMeta>, String> {
    state.meeting_manager.list()
}

#[tauri::command]
pub fn get_meeting(id: String, state: State<'_, AppState>) -> Result<MeetingDetail, String> {
    state.meeting_manager.get(&id)
}

#[tauri::command]
pub fn delete_meeting(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.meeting_manager.delete(&id)?;
    let _ = app.emit("meetings-updated", ());
    Ok(())
}

#[tauri::command]
pub fn list_meeting_devices(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MeetingDevices, String> {
    Ok(state.meeting_manager.devices(&app))
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

/// Background thread that broadcasts audio level events at ~20 FPS while recording.
/// Both the main window and settings window can subscribe to `audio:level`.
/// Exits when the main window is destroyed (app shutting down).
pub fn start_audio_level_emitter(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if app.get_webview_window("main").is_none() {
            break;
        }
        if !crate::audio::is_recording() {
            continue;
        }
        let (rms_db, peak_db) = crate::audio::current_level();
        let _ = app.emit("audio:level", AudioLevelPayload { rms_db, peak_db });
    });
}

pub fn show_settings_window_internal(app: &AppHandle) -> Result<(), String> {
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
