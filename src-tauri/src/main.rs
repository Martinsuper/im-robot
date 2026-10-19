// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if im_robot_lib::typing_activity::keyboard_worker_main() {
        return;
    }
    im_robot_lib::run()
}
