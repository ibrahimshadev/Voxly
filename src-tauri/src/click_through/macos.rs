use objc2::declare::ClassBuilder;
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{msg_send, sel};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the subclass has been applied (only do it once).
static SUBCLASS_APPLIED: AtomicBool = AtomicBool::new(false);

/// Override `hitTest:` on the content view to enable per-pixel click-through.
/// Returns nil (transparent) for points outside interactive rects, original result otherwise.
extern "C" fn hit_test_override(
    this: &AnyObject,
    _sel: Sel,
    point: objc2_foundation::NSPoint,
) -> *mut AnyObject {
    unsafe {
        // Get the view bounds height for Y-flip
        let bounds: objc2_foundation::NSRect = msg_send![this, bounds];
        let view_height = bounds.size.height;

        // Flip Y: NSView Y=0 is at bottom, CSS Y=0 is at top
        let css_x = point.x;
        let css_y = view_height - point.y;

        if super::point_in_hit_region(css_x, css_y, 1.0) {
            // Interactive area — call superclass hitTest:
            let superclass: *const AnyClass = msg_send![this, superclass];
            let result: *mut AnyObject = msg_send![super(this, &*superclass), hitTest: point];
            result
        } else {
            // Transparent — return nil to pass clicks through
            std::ptr::null_mut()
        }
    }
}

pub fn setup(window: &tauri::WebviewWindow) {
    if SUBCLASS_APPLIED.swap(true, Ordering::SeqCst) {
        return; // Already applied
    }

    unsafe {
        let ns_window: *mut AnyObject = match window.ns_window() {
            Ok(ptr) => ptr as *mut AnyObject,
            Err(_) => return,
        };

        // Get content view
        let content_view: *mut AnyObject = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }

        // Get the original class of the content view
        let original_class: *const AnyClass = msg_send![content_view, class];
        let class_name = (*original_class).name().to_str().unwrap_or("Unknown");

        // Create a subclass name
        let subclass_name = CString::new(format!("DiktHitTest_{}", class_name)).unwrap();

        // Check if already registered
        if let Some(_existing) = AnyClass::get(&subclass_name) {
            return;
        }

        // Create a new runtime subclass
        let mut builder = match ClassBuilder::new(&subclass_name, &*original_class) {
            Some(b) => b,
            None => return,
        };

        // Override hitTest: method
        builder.add_method(
            sel!(hitTest:),
            hit_test_override as extern "C" fn(_, _, _) -> _,
        );

        let new_class = builder.register();

        // Isa-swizzle: change the class of this specific instance
        let _: () = msg_send![content_view, setClass: new_class];

        // Make the window non-opaque so transparent areas pass through
        let _: () = msg_send![ns_window, setOpaque: false];
    }
}
