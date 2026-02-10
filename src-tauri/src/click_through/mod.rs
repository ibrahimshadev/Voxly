#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;

use once_cell::sync::Lazy;
use std::sync::Mutex;

#[derive(serde::Deserialize, Clone, Debug)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

static HIT_RECTS: Lazy<Mutex<Vec<HitRect>>> = Lazy::new(|| Mutex::new(Vec::new()));
static SCALE_FACTOR: Lazy<Mutex<f64>> = Lazy::new(|| Mutex::new(1.0));

/// Check if a point (in physical pixels, relative to window top-left) falls
/// within any interactive hit rect. Used by Windows (WM_NCHITTEST).
#[allow(dead_code)]
pub fn point_in_hit_region(x: i32, y: i32) -> bool {
    let rects = HIT_RECTS.lock().unwrap();
    let scale = *SCALE_FACTOR.lock().unwrap();
    let px = x as f64;
    let py = y as f64;
    for rect in rects.iter() {
        let rx = rect.x * scale;
        let ry = rect.y * scale;
        let rw = rect.w * scale;
        let rh = rect.h * scale;
        if px >= rx && px < rx + rw && py >= ry && py < ry + rh {
            return true;
        }
    }
    false
}

/// Check if a point (in CSS pixels, relative to window top-left) falls
/// within any interactive hit rect. Used by macOS where hitTest: gives points.
#[cfg(target_os = "macos")]
pub fn point_in_hit_region_css(x: f64, y: f64) -> bool {
    let rects = HIT_RECTS.lock().unwrap();
    for rect in rects.iter() {
        if x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h {
            return true;
        }
    }
    false
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
