/// Foreground application detection module.
///
/// Periodically polls the active window to determine what app category the user
/// is currently in, so the pet can adjust its behavior accordingly.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// App categories that influence pet behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppCategory {
    /// IDE / code editor — pet should be quiet, prefer `working` state.
    Ide,
    /// Web browser — normal interaction.
    Browser,
    /// Video conference (Zoom, Teams, etc.) — pet should be silent, prefer `resting`.
    VideoConference,
    /// Game — pet should be silent, prefer `resting`.
    Game,
    /// Unrecognized — default behavior.
    Other,
}

impl std::fmt::Display for AppCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppCategory::Ide => write!(f, "ide"),
            AppCategory::Browser => write!(f, "browser"),
            AppCategory::VideoConference => write!(f, "video_conference"),
            AppCategory::Game => write!(f, "game"),
            AppCategory::Other => write!(f, "other"),
        }
    }
}

/// Classify an application name into a category.
pub fn classify(app_name: &str) -> AppCategory {
    let lower = app_name.to_lowercase();

    // IDE / Editors
    if lower.contains("code")
        || lower.contains("clion")
        || lower.contains("intellij")
        || lower.contains("pycharm")
        || lower.contains("webstorm")
        || lower.contains("rustrover")
        || lower.contains("goland")
        || lower.contains("rider")
        || lower.contains("phpstorm")
        || lower.contains("rubymine")
        || lower.contains("xcode")
        || lower.contains("zed")
        || lower.contains("vim")
        || lower.contains("nvim")
        || lower.contains("emacs")
        || lower.contains("sublime")
        || lower.contains("cursor")
        || lower.contains("windsurf")
        || lower.contains("vscodium")
        || lower.contains("atom")
        || lower.contains("fleet")
    {
        return AppCategory::Ide;
    }

    // Browsers
    if lower.contains("chrome")
        || lower.contains("firefox")
        || lower.contains("safari")
        || lower.contains("edge")
        || lower.contains("brave")
        || lower.contains("opera")
        || lower.contains("arc")
        || lower.contains("vivaldi")
        || lower.contains("waterfox")
        || lower.contains("tor browser")
        || lower.contains("zen")
    {
        return AppCategory::Browser;
    }

    // Video Conference
    if lower.contains("zoom")
        || lower.contains("teams")
        || lower.contains("meet")
        || lower.contains("webex")
        || lower.contains("slack call")
        || lower.contains("discord")
        || lower.contains("skype")
        || lower.contains("feishu")
        || lower.contains("lark")
        || lower.contains("钉钉")
        || lower.contains("腾讯会议")
    {
        return AppCategory::VideoConference;
    }

    // Games
    if lower.contains("steam")
        || lower.contains("epic")
        || lower.contains("battle.net")
        || lower.contains("origin")
        || lower.contains("ubisoft")
        || lower.contains("riot")
        || lower.contains("minecraft")
    {
        return AppCategory::Game;
    }

    AppCategory::Other
}

/// Shared state for foreground app awareness.
pub struct ForegroundAppState {
    pub current_category: Mutex<AppCategory>,
    pub sensing_paused: Mutex<bool>,
    pub last_app_name: Mutex<Option<String>>,
}

impl Default for ForegroundAppState {
    fn default() -> Self {
        Self {
            current_category: Mutex::new(AppCategory::Other),
            sensing_paused: Mutex::new(false),
            last_app_name: Mutex::new(None),
        }
    }
}

/// Platform-specific: get the foreground application name.
#[cfg(target_os = "macos")]
pub fn get_foreground_app_name() -> Option<String> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let front_app = workspace.frontmostApplication();

    // Try bundle identifier first (more stable), fall back to local name
    front_app
        .as_deref()
        .and_then(|app| app.bundleIdentifier())
        .map(|b| b.to_string())
        .or_else(|| {
            front_app
                .as_deref()
                .and_then(|app| app.localizedName())
                .map(|n| n.to_string())
        })
}

#[cfg(target_os = "windows")]
pub fn get_foreground_app_name() -> Option<String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowModuleFileNameW};

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == HWND(std::ptr::null_mut()) {
            return None;
        }

        let mut buf = [0u16; 512];
        let len = GetWindowModuleFileNameW(hwnd, &mut buf);
        if len == 0 {
            return None;
        }

        let path = String::from_utf16_lossy(&buf[..len as usize]);
        // Extract just the filename
        path.rsplit(|c| c == '\\' || c == '/')
            .next()
            .map(|s| s.to_string())
    }
}

#[cfg(target_os = "linux")]
pub fn get_foreground_app_name() -> Option<String> {
    // Try xdotool first
    std::process::Command::new("xdotool")
        .args(["getwindowfocus", "getwindowname"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
