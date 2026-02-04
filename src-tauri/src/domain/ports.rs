use crate::settings::AppSettings;

pub trait SettingsStore: Send + Sync {
  fn load(&self) -> AppSettings;
  fn save(&self, settings: &AppSettings) -> Result<(), String>;
}

pub trait Recorder: Send + Sync {
  fn start(&self) -> Result<(), String>;
  fn stop(&self) -> Result<Vec<u8>, String>;
}

pub trait Paster: Send + Sync {
  fn paste(&self, text: &str) -> Result<(), String>;
}

#[async_trait::async_trait]
pub trait Transcriber: Send + Sync {
  async fn transcribe(
    &self,
    settings: &AppSettings,
    audio_wav: Vec<u8>,
    prompt: Option<&str>,
  ) -> Result<String, String>;
}
