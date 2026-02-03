use std::sync::Mutex;

use crate::settings::AppSettings;

use super::{
  ports::{Paster, Recorder, SettingsStore, Transcriber},
  types::{DictationState, DictationUpdate},
};

pub struct DictationSessionManager {
  state: Mutex<DictationState>,
  settings: Mutex<AppSettings>,

  recorder: Box<dyn Recorder>,
  settings_store: Box<dyn SettingsStore>,
  transcriber: Box<dyn Transcriber>,
  paster: Box<dyn Paster>,
}

impl DictationSessionManager {
  pub fn new(
    recorder: Box<dyn Recorder>,
    settings_store: Box<dyn SettingsStore>,
    transcriber: Box<dyn Transcriber>,
    paster: Box<dyn Paster>,
  ) -> Self {
    let initial_settings = settings_store.load();
    Self {
      state: Mutex::new(DictationState::Idle),
      settings: Mutex::new(initial_settings),
      recorder,
      settings_store,
      transcriber,
      paster,
    }
  }

  pub fn get_settings(&self) -> Result<AppSettings, String> {
    Ok(
      self
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .clone(),
    )
  }

  pub fn save_settings(&self, settings: AppSettings) -> Result<(), String> {
    self.settings_store.save(&settings)?;
    let mut guard = self
      .settings
      .lock()
      .map_err(|_| "Settings lock poisoned".to_string())?;
    *guard = settings;
    Ok(())
  }

  pub fn start_recording<F>(&self, mut on_update: F) -> Result<(), String>
  where
    F: FnMut(DictationUpdate),
  {
    {
      let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
      if *state != DictationState::Idle {
        return Err("Busy".to_string());
      }
      *state = DictationState::Recording;
    }

    on_update(DictationUpdate::new(DictationState::Recording));

    match self.recorder.start() {
      Ok(()) => Ok(()),
      Err(e) => {
        let _ = self.set_state(DictationState::Idle);
        on_update(DictationUpdate::new(DictationState::Error).message(e.clone()));
        Err(e)
      }
    }
  }

  pub async fn stop_and_process<F>(&self, mut on_update: F) -> Result<String, String>
  where
    F: FnMut(DictationUpdate),
  {
    {
      let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
      if *state != DictationState::Recording {
        return Err("Not recording".to_string());
      }
      *state = DictationState::Transcribing;
    }

    on_update(DictationUpdate::new(DictationState::Transcribing));

    let result = async {
      let wav_data = self.recorder.stop()?;

      let settings = self
        .settings
        .lock()
        .map_err(|_| "Settings lock poisoned".to_string())?
        .clone();

      let text = self.transcriber.transcribe(&settings, wav_data).await?;

      {
        let _ = self.set_state(DictationState::Pasting);
      }
      on_update(DictationUpdate::new(DictationState::Pasting));

      self.paster.paste(&text)?;

      {
        let _ = self.set_state(DictationState::Done);
      }
      on_update(DictationUpdate::new(DictationState::Done).text(text.clone()));

      Ok::<_, String>(text)
    }
    .await;

    // Always return to Idle at the end of a run.
    let _ = self.set_state(DictationState::Idle);

    match result {
      Ok(text) => Ok(text),
      Err(err) => {
        on_update(DictationUpdate::new(DictationState::Error).message(err.clone()));
        Err(err)
      }
    }
  }

  fn set_state(&self, next: DictationState) -> Result<(), String> {
    let mut state = self.state.lock().map_err(|_| "State lock poisoned".to_string())?;
    *state = next;
    Ok(())
  }
}
