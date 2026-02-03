use serde::{Deserialize, Serialize};

#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationState {
  Idle,
  Recording,
  Transcribing,
  Pasting,
  Done,
  Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationUpdate {
  pub state: DictationState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
}

impl DictationUpdate {
  pub fn new(state: DictationState) -> Self {
    Self {
      state,
      message: None,
      text: None,
    }
  }

  pub fn message(mut self, message: impl Into<String>) -> Self {
    self.message = Some(message.into());
    self
  }

  pub fn text(mut self, text: impl Into<String>) -> Self {
    self.text = Some(text.into());
    self
  }
}
