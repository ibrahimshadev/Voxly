use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::InvalidateRect;
use windows::Win32::UI::WindowsAndMessaging::*;

/// Whether WS_EX_TRANSPARENT is currently set (click-through active).
static PASSTHROUGH: AtomicBool = AtomicBool::new(true);

/// Stored HWND for the cursor tracker thread.
static WINDOW_HWND: AtomicIsize = AtomicIsize::new(0);

/// Toggle only WS_EX_TRANSPARENT on an HWND.
/// Never touches WS_EX_LAYERED — prevents WebView2 compositor surface corruption.
unsafe fn toggle_ex_transparent(hwnd: HWND, enable: bool) {
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let new_style = if enable {
        ex_style | WS_EX_TRANSPARENT.0 as isize
    } else {
        ex_style & !(WS_EX_TRANSPARENT.0 as isize)
    };
    if new_style != ex_style {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
    }
}

/// Ensure WS_EX_LAYERED is set and pin the window at full opacity.
/// Safe to call repeatedly — idempotent.
unsafe fn ensure_layered_visible(hwnd: HWND) {
    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if ex_style & WS_EX_LAYERED.0 as isize == 0 {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);
    }
    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
}

/// Set up click-through for the main window and start the cursor tracker.
///
/// Uses WS_EX_TRANSPARENT (OS-level) for cross-application click-through.
/// HTTRANSPARENT from WM_NCHITTEST only works within the same thread —
/// WS_EX_TRANSPARENT is the only mechanism that passes clicks to other apps.
///
/// A background thread checks cursor position against hit rects and toggles
/// WS_EX_TRANSPARENT accordingly. Also acts as a watchdog, re-applying
/// SetLayeredWindowAttributes every ~30s to prevent WebView2 invisibility.
pub fn setup(window: &tauri::WebviewWindow) {
    let hwnd_val = match window.hwnd().ok().map(|h| h.0 as isize) {
        Some(v) => v,
        None => return,
    };
    let hwnd = HWND(hwnd_val);

    unsafe {
        ensure_layered_visible(hwnd);
        toggle_ex_transparent(hwnd, true);
    }
    PASSTHROUGH.store(true, Ordering::Relaxed);
    WINDOW_HWND.store(hwnd_val, Ordering::Relaxed);

    // Cursor tracker thread: checks cursor position against hit rects
    // and toggles WS_EX_TRANSPARENT. Single authority for passthrough state.
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_val);
        let mut tick: u32 = 0;
        const WATCHDOG_INTERVAL: u32 = 600; // 600 × 50ms = 30s

        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));

            if !unsafe { IsWindow(hwnd).as_bool() } {
                break;
            }

            tick = tick.wrapping_add(1);
            if tick % WATCHDOG_INTERVAL == 0 {
                unsafe { ensure_layered_visible(hwnd); }
            }

            if !unsafe { IsWindowVisible(hwnd).as_bool() } {
                continue;
            }

            // Get window rect in screen coordinates
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
                continue;
            }

            // Get cursor position in screen coordinates
            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) }.is_err() {
                continue;
            }

            // Convert to window-local coordinates
            let x_local = point.x - rect.left;
            let y_local = point.y - rect.top;

            // Check against hit rects from the frontend
            let in_hit_region = super::point_in_hit_region(x_local, y_local);

            let passthrough = PASSTHROUGH.load(Ordering::Relaxed);
            let want_passthrough = !in_hit_region;

            if want_passthrough && !passthrough {
                unsafe { toggle_ex_transparent(hwnd, true); }
                PASSTHROUGH.store(true, Ordering::Relaxed);
            } else if !want_passthrough && passthrough {
                unsafe { toggle_ex_transparent(hwnd, false); }
                PASSTHROUGH.store(false, Ordering::Relaxed);
            }
        }
    });
}

/// Re-apply WS_EX_LAYERED + SetLayeredWindowAttributes for crash recovery.
pub fn ensure_visible(window: &tauri::WebviewWindow) {
    if let Some(hwnd_val) = window.hwnd().ok().map(|h| h.0 as isize) {
        let hwnd = HWND(hwnd_val);
        unsafe {
            ensure_layered_visible(hwnd);
            let _ = InvalidateRect(hwnd, None, true);
        }
    }
}
