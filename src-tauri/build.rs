fn main() {
    std::fs::write(
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("agent-target.txt"),
        std::env::var("TARGET").unwrap(),
    )
    .unwrap();
    tauri_build::build();

    // Compile the EventKit Objective-C bridge on macOS.
    // This links directly into the main Tauri binary so it inherits the
    // host app's Calendar TCC authorization automatically.
    #[cfg(target_os = "macos")]
    {
        use std::env;
        use std::path::PathBuf;

        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let src = PathBuf::from("src/calendar_bridge.m");
        let obj = out_dir.join("calendar_bridge.o");

        let status = std::process::Command::new("clang")
            .arg("-c")
            .arg("-fobjc-arc")
            .arg("-framework")
            .arg("Foundation")
            .arg("-framework")
            .arg("EventKit")
            .arg("-o")
            .arg(&obj)
            .arg(&src)
            .status()
            .expect("Failed to run clang to compile calendar_bridge.m");

        if !status.success() {
            panic!("Failed to compile calendar_bridge.m");
        }

        // Tell cargo to link the object file
        println!("cargo:rustc-link-search=native={}", out_dir.display());
        println!("cargo:rustc-link-lib=static=calendar_bridge");

        // Convert .o to .a (static library)
        let lib = out_dir.join("libcalendar_bridge.a");
        let _ = std::fs::remove_file(&lib);
        let status = std::process::Command::new("ar")
            .arg("rcs")
            .arg(&lib)
            .arg(&obj)
            .status()
            .expect("Failed to run ar");

        if !status.success() {
            panic!("Failed to create static library for calendar_bridge");
        }

        println!("cargo:rustc-link-lib=framework=EventKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rerun-if-changed=src/calendar_bridge.m");
    }
}
