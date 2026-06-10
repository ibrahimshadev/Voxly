use std::time::{Duration, Instant};

const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(500);
const MIN_EMIT_PCT_STEP: f32 = 1.0;

/// Parses one line of `ffmpeg -progress pipe:1` output into processed seconds.
/// Accepts `out_time=HH:MM:SS.ffffff` (canonical, version-stable) and
/// `out_time_us=<microseconds>` (fallback). Returns None for anything else —
/// including `out_time_ms=`, which is historically microseconds and ambiguous
/// across FFmpeg versions.
pub fn parse_out_time_secs(line: &str) -> Option<f64> {
    if let Some(value) = line.strip_prefix("out_time=") {
        let mut parts = value.trim().splitn(3, ':');
        let hours: f64 = parts.next()?.parse().ok()?;
        let minutes: f64 = parts.next()?.parse().ok()?;
        let seconds: f64 = parts.next()?.parse().ok()?;
        return Some(hours * 3600.0 + minutes * 60.0 + seconds);
    }
    if let Some(value) = line.strip_prefix("out_time_us=") {
        let us: i64 = value.trim().parse().ok()?;
        return Some(us as f64 / 1_000_000.0);
    }
    None
}

/// Percentage for the UI. None when duration is unknown/invalid (UI shows an
/// indeterminate bar). Clamped to 99.0 — the terminal "stopped" event is the
/// completion signal, never the bar reaching 100.
pub fn progress_pct(out_time_secs: f64, duration_secs: f64) -> Option<f32> {
    if duration_secs <= 0.0 {
        return None;
    }
    Some(((out_time_secs / duration_secs) * 100.0).clamp(0.0, 99.0) as f32)
}

/// Rate limiter for progress events: emit on the first call, then whenever the
/// percentage advanced at least one point or 500ms elapsed since the last emit.
pub struct ProgressThrottle {
    last: Option<(Instant, f32)>,
}

impl ProgressThrottle {
    pub fn new() -> Self {
        Self { last: None }
    }

    pub fn should_emit(&mut self, pct: f32, now: Instant) -> bool {
        let emit = match self.last {
            None => true,
            Some((last_instant, last_pct)) => {
                pct - last_pct >= MIN_EMIT_PCT_STEP
                    || now.duration_since(last_instant) >= MIN_EMIT_INTERVAL
            }
        };
        if emit {
            self.last = Some((now, pct));
        }
        emit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_out_time_hms() {
        assert_eq!(parse_out_time_secs("out_time=00:01:30.500000"), Some(90.5));
    }

    #[test]
    fn parses_out_time_us_fallback() {
        assert_eq!(parse_out_time_secs("out_time_us=90500000"), Some(90.5));
    }

    #[test]
    fn ignores_other_lines_and_ambiguous_ms_key() {
        assert_eq!(parse_out_time_secs("frame=120"), None);
        assert_eq!(parse_out_time_secs("out_time_ms=90500000"), None);
        assert_eq!(parse_out_time_secs("out_time=garbage"), None);
        assert_eq!(parse_out_time_secs(""), None);
    }

    #[test]
    fn pct_is_ratio_clamped_to_99() {
        assert_eq!(progress_pct(45.0, 90.0), Some(50.0));
        assert_eq!(progress_pct(150.0, 90.0), Some(99.0)); // apad runs past duration
        assert_eq!(progress_pct(-5.0, 90.0), Some(0.0));
    }

    #[test]
    fn pct_is_none_without_valid_duration() {
        assert_eq!(progress_pct(45.0, 0.0), None);
        assert_eq!(progress_pct(45.0, -1.0), None);
    }

    #[test]
    fn throttle_emits_first_then_on_step_or_interval() {
        let mut throttle = ProgressThrottle::new();
        let t0 = Instant::now();

        assert!(throttle.should_emit(10.0, t0));
        assert!(!throttle.should_emit(10.5, t0 + Duration::from_millis(100)));
        assert!(throttle.should_emit(11.5, t0 + Duration::from_millis(200))); // ≥1 pct step
        assert!(throttle.should_emit(11.6, t0 + Duration::from_millis(800))); // ≥500ms
    }
}
