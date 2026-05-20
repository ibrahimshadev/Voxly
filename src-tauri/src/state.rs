use crate::domain::{
    impls::{
        ClipboardPaster, CpalRecorder, FileAndKeyringSettingsStore, OpenAiCompatibleFormatter,
        OpenAiCompatibleTranscriber,
    },
    manager::DictationSessionManager,
};
use crate::meeting::MeetingSessionManager;

pub struct AppState {
    pub manager: DictationSessionManager,
    pub meeting_manager: MeetingSessionManager,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            manager: DictationSessionManager::new(
                Box::new(CpalRecorder::default()),
                Box::new(FileAndKeyringSettingsStore),
                Box::new(OpenAiCompatibleTranscriber),
                Box::new(ClipboardPaster),
                Box::new(OpenAiCompatibleFormatter),
            ),
            meeting_manager: MeetingSessionManager::default(),
        }
    }
}
