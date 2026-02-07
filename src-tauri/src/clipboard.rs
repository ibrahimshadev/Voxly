use std::thread;
use std::time::Duration;

use arboard::Clipboard;
use enigo::{Direction::{Click, Press, Release}, Enigo, Key, Keyboard, Settings};

#[cfg(target_os = "macos")]
fn wrap_accessibility_error(message: String) -> String {
  let normalized = message.to_ascii_lowercase();
  let permission_error = normalized.contains("accessibility")
    || normalized.contains("not permitted")
    || normalized.contains("permission denied")
    || normalized.contains("not trusted")
    || normalized.contains("trust");

  if permission_error {
    "Accessibility permission required. Grant access to Dikt in System Settings > Privacy & Security > Accessibility, then restart the app.".to_string()
  } else {
    message
  }
}

#[cfg(not(target_os = "macos"))]
fn wrap_accessibility_error(message: String) -> String {
  message
}

pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
  let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
  clipboard.set_text(text).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn copy_and_paste(text: &str, restore_clipboard: bool) -> Result<(), String> {
  let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
  let original_clipboard = if restore_clipboard {
    clipboard.get_text().ok()
  } else {
    None
  };

  clipboard.set_text(text).map_err(|e| e.to_string())?;

  thread::sleep(Duration::from_millis(50));

  let mut enigo = Enigo::new(&Settings::default()).map_err(|e| wrap_accessibility_error(e.to_string()))?;
  let modifier = paste_modifier_key();
  enigo.key(modifier, Press).map_err(|e| wrap_accessibility_error(e.to_string()))?;
  enigo.key(Key::Unicode('v'), Click).map_err(|e| wrap_accessibility_error(e.to_string()))?;
  enigo.key(modifier, Release).map_err(|e| wrap_accessibility_error(e.to_string()))?;

  if let Some(original_text) = original_clipboard {
    thread::sleep(Duration::from_millis(50));
    clipboard.set_text(original_text).map_err(|e| e.to_string())?;
  }

  Ok(())
}

fn paste_modifier_key() -> Key {
  // macOS uses Command, Windows/Linux use Control.
  #[cfg(target_os = "macos")]
  {
    Key::Meta
  }
  #[cfg(not(target_os = "macos"))]
  {
    Key::Control
  }
}
