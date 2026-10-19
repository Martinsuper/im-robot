# Local security patch

Source: crates.io sherpa-onnx-sys 1.13.8, Apache-2.0 (see LICENSE).
Only Cargo.toml build-dependencies.zip is changed from 2 to 9.0.0 to remove RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369. Native FFI, downloaded native library versions and archive extraction code are unchanged. Remove this patch when the upstream crate adopts a fixed zip version. The ZIP path is for iOS XCFramework archives; desktop builds consume tar.bz2 archives.

Upstream crate archive SHA-256: `14bbeabb73f73f1c1f4a278af0ee9ae90a19f9727482027047fb9422fa14f8fe`.
