use crate::settings::AppSettings;

#[async_trait::async_trait]
pub trait Formatter: Send + Sync {
  async fn format(
    &self,
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    text: &str,
  ) -> Result<String, String>;
}

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
  fn copy(&self, text: &str) -> Result<(), String>;
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
