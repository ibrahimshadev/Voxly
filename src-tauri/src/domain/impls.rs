use crate::{audio::AudioRecorder, clipboard, settings, transcribe};

use super::ports::{Paster, Recorder, SettingsStore, Transcriber};
use crate::settings::AppSettings;

pub struct CpalRecorder(AudioRecorder);

impl Default for CpalRecorder {
  fn default() -> Self {
    Self(AudioRecorder::default())
  }
}

impl Recorder for CpalRecorder {
  fn start(&self) -> Result<(), String> {
    self.0.start()
  }

  fn stop(&self) -> Result<Vec<u8>, String> {
    self.0.stop()
  }
}

pub struct FileAndKeyringSettingsStore;

impl SettingsStore for FileAndKeyringSettingsStore {
  fn load(&self) -> AppSettings {
    settings::load_settings()
  }

  fn save(&self, settings: &AppSettings) -> Result<(), String> {
    settings::save_settings(settings)
  }
}

pub struct ClipboardPaster;

impl Paster for ClipboardPaster {
  fn paste(&self, text: &str) -> Result<(), String> {
    clipboard::copy_and_paste(text)
  }
}

pub struct OpenAiCompatibleTranscriber;

#[async_trait::async_trait]
impl Transcriber for OpenAiCompatibleTranscriber {
  async fn transcribe(&self, settings: &AppSettings, audio_wav: Vec<u8>) -> Result<String, String> {
    transcribe::transcribe(&settings.base_url, &settings.api_key, &settings.model, audio_wav).await
  }
}
