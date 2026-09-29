#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::Mutex;

#[derive(serde::Deserialize, Clone, Debug)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

static HIT_RECTS: Mutex<Vec<HitRect>> = Mutex::new(Vec::new());
static SCALE_FACTOR: Mutex<f64> = Mutex::new(1.0);

/// Check if a point (relative to window top-left) falls within any interactive
/// hit rect. The rects are in CSS pixels; `scale` converts them to the point's
/// units: the device scale factor for physical pixels (Windows WM_NCHITTEST),
/// 1.0 for CSS points (macOS hitTest:).
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn point_in_hit_region(x: f64, y: f64, scale: f64) -> bool {
    HIT_RECTS.lock().unwrap().iter().any(|rect| {
        let rx = rect.x * scale;
        let ry = rect.y * scale;
        x >= rx && x < rx + rect.w * scale && y >= ry && y < ry + rect.h * scale
    })
}

/// Platform-specific setup for per-pixel hit testing.
pub fn setup(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    windows::setup(window);
    #[cfg(target_os = "macos")]
    macos::setup(window);
    #[cfg(target_os = "linux")]
    linux::setup(window);

    let _ = window; // suppress unused warning on unsupported platforms
}

/// Update the interactive hit regions. Called by the frontend via IPC.
/// The window reference is needed on Linux to rebuild the GTK input shape.
#[allow(unused_variables)]
pub fn update_region(rects: Vec<HitRect>, scale_factor: f64, window: &tauri::WebviewWindow) {
    *SCALE_FACTOR.lock().unwrap() = scale_factor;
    *HIT_RECTS.lock().unwrap() = rects;

    #[cfg(target_os = "linux")]
    linux::rebuild_input_shape(window);
}

/// Re-apply platform-specific visibility recovery (watchdog).
/// Called by ensure_main_visible for crash recovery.
#[allow(unused_variables)]
pub fn ensure_visible(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    windows::ensure_visible(window);
}
