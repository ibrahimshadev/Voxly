use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::meeting::recorder::RunningRecorder;
use crate::meeting::storage;
use crate::meeting::types::{
    MeetingDetail, MeetingDevices, MeetingMeta, MeetingStartOptions, MeetingStatus, MeetingUpdate,
};
use crate::settings::AppSettings;

struct ActiveMeeting {
    meta: MeetingMeta,
    started: Instant,
    recorder: RunningRecorder,
}

#[derive(Default)]
pub struct MeetingSessionManager {
    active: Mutex<Option<ActiveMeeting>>,
}

impl MeetingSessionManager {
    pub fn start(
        &self,
        app: AppHandle,
        settings: &AppSettings,
        mut options: MeetingStartOptions,
    ) -> Result<MeetingMeta, String> {
        if !settings.meeting_consent_acknowledged {
            return Err(
                "Acknowledge meeting recording consent in Settings before recording.".to_string(),
            );
        }

        let mut active = self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?;
        if active.is_some() {
            return Err("A meeting is already recording.".to_string());
        }

        if options.video_preset.trim().is_empty() {
            options.video_preset = settings.meeting_video_preset.clone();
        }
        if options.mic_device.is_none() {
            options.mic_device = settings.meeting_mic_device.clone();
        }
        if options.system_audio_device.is_none() {
            options.system_audio_device = settings.meeting_system_audio_device.clone();
        }
        if options.record_system_audio
            && options
                .mic_device
                .as_deref()
                .zip(options.system_audio_device.as_deref())
                .is_some_and(|(mic, system)| mic.trim().eq_ignore_ascii_case(system.trim()))
        {
            options.record_system_audio = false;
            options.system_audio_device = None;
        }

        if options.record_system_audio && !crate::meeting::loopback::system_audio_available() {
            return Err(
                "No Windows playback output is available for system-audio capture.".to_string(),
            );
        }

        let id = uuid::Uuid::new_v4().to_string();
        let started_at_ms = storage::now_ms()?;
        let title = options
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "Untitled meeting".to_string());

        storage::create_meeting_folder(&id)?;
        let output_path = storage::source_path(&id)?;

        let has_video = options.record_video && options.video_preset != "audio_only";
        let has_mic = options
            .mic_device
            .as_deref()
            .is_some_and(|value| options.record_mic && !value.trim().is_empty());
        let has_system_audio = options.record_system_audio;

        let meta = MeetingMeta {
            id: id.clone(),
            title,
            started_at_ms,
            ended_at_ms: None,
            duration_secs: None,
            has_video,
            has_mic,
            has_system_audio,
            file_size_bytes: None,
            status: MeetingStatus::Recording,
            transcript_status: None,
            transcript_error: None,
            assemblyai_transcript_id: None,
            transcript_started_at_ms: None,
        };

        let recorder = match RunningRecorder::spawn(app.clone(), id.clone(), &output_path, &options)
        {
            Ok(recorder) => recorder,
            Err(error) => {
                let _ = storage::delete_meeting(&id);
                return Err(error);
            }
        };
        let started = Instant::now();
        storage::upsert_meta(meta.clone())?;

        *active = Some(ActiveMeeting {
            meta: meta.clone(),
            started,
            recorder,
        });

        emit_progress(app, id, output_path);
        Ok(meta)
    }

    pub fn stop(&self) -> Result<MeetingMeta, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?
            .take();

        let Some(active) = active else {
            return Err("No meeting is recording.".to_string());
        };

        let active_meta = active.meta;
        let stop_result = active.recorder.stop();
        let ended_at_ms = storage::now_ms()?;
        let source_path = storage::source_path(&active_meta.id)?;
        let duration_secs = active.started.elapsed().as_secs_f64();
        let file_size_bytes = storage::file_size(&source_path);
        let status = if stop_result.is_ok() {
            MeetingStatus::Recorded
        } else {
            MeetingStatus::Error
        };
        let meta = storage::update_meta_by_id(&active_meta.id, |item| {
            item.ended_at_ms = Some(ended_at_ms);
            item.duration_secs = Some(duration_secs);
            item.file_size_bytes = file_size_bytes;
            item.status = status.clone();
            Ok(())
        })?
        .unwrap_or_else(|| {
            let mut meta = active_meta;
            meta.ended_at_ms = Some(ended_at_ms);
            meta.duration_secs = Some(duration_secs);
            meta.file_size_bytes = file_size_bytes;
            meta.status = status;
            meta
        });

        stop_result?;
        Ok(meta)
    }

    pub fn list(&self) -> Result<Vec<MeetingMeta>, String> {
        let active_id = self.active_id()?;
        storage::load_index_reconciled(active_id.as_deref())
    }

    pub fn get(&self, id: &str) -> Result<MeetingDetail, String> {
        let active_id = self.active_id()?;
        storage::get_detail_reconciled(id, active_id.as_deref())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?
            .as_ref()
            .is_some_and(|active| active.meta.id == id)
        {
            return Err("Stop the active meeting before deleting it.".to_string());
        }
        storage::delete_meeting(id)
    }

    pub fn devices(&self, app: &AppHandle) -> MeetingDevices {
        crate::meeting::devices::list_devices(app)
    }

    fn active_id(&self) -> Result<Option<String>, String> {
        Ok(self
            .active
            .lock()
            .map_err(|_| "Meeting state lock poisoned".to_string())?
            .as_ref()
            .map(|active| active.meta.id.clone()))
    }
}

fn emit_progress(app: AppHandle, id: String, output_path: std::path::PathBuf) {
    thread::spawn(move || {
        let started = Instant::now();
        loop {
            thread::sleep(Duration::from_secs(1));
            if !is_still_recording(&app, &id) {
                break;
            }

            let elapsed_secs = started.elapsed().as_secs();
            let file_size_bytes = storage::file_size(&output_path);
            let emit_result = app.emit(
                "meeting:update",
                MeetingUpdate {
                    state: "recording".to_string(),
                    meeting_id: Some(id.clone()),
                    message: None,
                    elapsed_secs: Some(elapsed_secs),
                    file_size_bytes,
                },
            );
            if emit_result.is_err() {
                break;
            }
        }
    });
}

fn is_still_recording(app: &AppHandle, id: &str) -> bool {
    let _ = app;
    storage::load_index()
        .ok()
        .and_then(|items| items.into_iter().find(|item| item.id == id))
        .is_some_and(|item| matches!(item.status, MeetingStatus::Recording))
}
