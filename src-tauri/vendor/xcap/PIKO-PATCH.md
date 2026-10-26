# Optional Linux video recording

## macOS 14 screenshot backend

Piko requires macOS 14 or newer. Static window/display capture uses ScreenCaptureKit's `SCScreenshotManager`, with native-resolution output, display-relative source rectangles, cursor exclusion, a bounded callback wait, and validated BGRA row conversion. No legacy capture fallback is retained. Foreground application detection uses `NSWorkspace.frontmostApplication` instead of the deprecated `activeApplication` dictionary. Screenshot and foreground-switch behavior must be checked on a signed desktop app with screen recording permission; unit tests cover padded and malformed pixel rows.

Source: crates.io xcap 0.9.8, Apache-2.0 (see LICENSE).
Piko uses static screenshots and does not expose video recording. Upstream compiles the PipeWire video backend unconditionally on Linux; its libspa bindings cannot compile against Ubuntu 22.04 headers. This patch makes only the Linux Wayland video backend opt-in via linux-video (and makes its pipewire dependency optional). Linux screenshot code, portal capture and X11 capture are unchanged. Calling disabled Wayland video recording returns an explicit error. Piko does not enable this feature.

Changes: Cargo.toml, src/linux/mod.rs, src/linux/impl_video_recorder.rs, src/error.rs. Remove the patch when upstream offers this feature split.

Upstream crate archive SHA-256: `da270fd7c8581d43d731cb690bcc791fc0a7b3bc96e131a4b6552d0379640a9e`.
