use crate::{audio::AudioRecorder, clipboard, format_text, settings, transcribe};
use crate::transcribe::TranscriptionResult;

use super::ports::{Formatter, Paster, Recorder, SettingsStore, Transcriber};
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
    clipboard::copy_and_paste(text, true)
  }

  fn copy(&self, text: &str) -> Result<(), String> {
    clipboard::copy_to_clipboard(text)
  }
}

pub struct OpenAiCompatibleFormatter;

#[async_trait::async_trait]
impl Formatter for OpenAiCompatibleFormatter {
  async fn format(
    &self,
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    text: &str,
  ) -> Result<String, String> {
    format_text::format_text(base_url, api_key, model, system_prompt, text).await
  }
}

pub struct OpenAiCompatibleTranscriber;

#[async_trait::async_trait]
impl Transcriber for OpenAiCompatibleTranscriber {
  async fn transcribe(
    &self,
    settings: &AppSettings,
    audio_wav: Vec<u8>,
    prompt: Option<&str>,
  ) -> Result<TranscriptionResult, String> {
    transcribe::transcribe(
      &settings.base_url,
      &settings.api_key,
      &settings.model,
      &settings.provider,
      audio_wav,
      prompt,
    )
    .await
  }
}
