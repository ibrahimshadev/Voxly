use gtk::prelude::*;

pub fn setup(window: &tauri::WebviewWindow) {
    // Set initial input shape (empty = entire window transparent to input).
    rebuild_input_shape(window);
}

/// Rebuild the input shape region from the current hit rects.
/// Called every time update_region is invoked.
pub fn rebuild_input_shape(window: &tauri::WebviewWindow) {
    let gtk_window = match window.gtk_window() {
        Ok(w) => w,
        Err(_) => return,
    };

    let gdk_window = match gtk_window.window() {
        Some(w) => w,
        None => return,
    };

    let rects = super::HIT_RECTS.lock().unwrap();
    let scale = *super::SCALE_FACTOR.lock().unwrap();

    if rects.is_empty() {
        // No interactive regions — entire window is transparent to input
        let empty_region = cairo::Region::create();
        gdk_window.input_shape_combine_region(&empty_region, 0, 0);
        return;
    }

    let region = cairo::Region::create();
    for rect in rects.iter() {
        let r = cairo::RectangleInt::new(
            (rect.x * scale) as i32,
            (rect.y * scale) as i32,
            (rect.w * scale) as i32,
            (rect.h * scale) as i32,
        );
        let _ = region.union_rectangle(&r);
    }

    gdk_window.input_shape_combine_region(&region, 0, 0);
}
