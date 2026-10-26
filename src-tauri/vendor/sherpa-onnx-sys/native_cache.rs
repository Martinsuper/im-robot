use std::path::Path;

/// Check actual linker inputs, not just directories left behind by CI cache cleanup.
pub fn has_required_libraries(
    lib_dir: &Path,
    static_link: bool,
    target_os: &str,
    static_libs: &[&str],
) -> bool {
    let libs: &[&str] = if static_link {
        static_libs
    } else if target_os == "ios" {
        &["sherpa-onnx-c-api"]
    } else {
        &["sherpa-onnx-c-api", "onnxruntime"]
    };
    libs.iter().all(|name| {
        let filename = match (static_link, target_os) {
            (_, "windows") => format!("{name}.lib"),
            (true, _) => format!("lib{name}.a"),
            (false, "macos" | "ios") => format!("lib{name}.dylib"),
            (false, _) => format!("lib{name}.so"),
        };
        lib_dir
            .join(filename)
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() > 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn incomplete_cache_is_rejected_on_each_desktop_platform() {
        let root = std::env::temp_dir().join(format!("sherpa-cache-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let libs = ["sherpa-onnx-c-api", "onnxruntime"];
        for os in ["linux", "macos", "windows"] {
            let dir = root.join(os);
            fs::create_dir_all(&dir).unwrap();
            assert!(!has_required_libraries(&dir, true, os, &libs));
            let filename = |name| {
                if os == "windows" {
                    format!("{name}.lib")
                } else {
                    format!("lib{name}.a")
                }
            };
            fs::write(dir.join(filename(libs[0])), b"library").unwrap();
            assert!(!has_required_libraries(&dir, true, os, &libs));
            fs::write(dir.join(filename(libs[1])), b"").unwrap();
            assert!(!has_required_libraries(&dir, true, os, &libs));
            fs::write(dir.join(filename(libs[1])), b"library").unwrap();
            assert!(has_required_libraries(&dir, true, os, &libs));
        }
        for (os, extension) in [("linux", "so"), ("macos", "dylib"), ("ios", "dylib")] {
            let dir = root.join(format!("shared-{os}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join(format!("libsherpa-onnx-c-api.{extension}")),
                b"library",
            )
            .unwrap();
            assert_eq!(has_required_libraries(&dir, false, os, &libs), os == "ios");
            fs::write(dir.join(format!("libonnxruntime.{extension}")), b"library").unwrap();
            assert!(has_required_libraries(&dir, false, os, &libs));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
