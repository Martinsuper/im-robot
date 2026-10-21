# Local security patch

Source: crates.io sherpa-onnx-sys 1.13.8, Apache-2.0 (see LICENSE).
Build dependency `zip` is changed from 2 to 9.0.0 to remove RUSTSEC-2026-0367, RUSTSEC-2026-0368 and RUSTSEC-2026-0369. The ZIP path is for iOS XCFramework archives; desktop builds consume tar.bz2 archives.

Build dependency `ureq` is upgraded from 2.12 to 3.4.2, removing its dependency on the vulnerable `webpki-roots` 0.26 certificate bundle (RUSTSEC-2026-0381). The downloader uses ureq 3's agent and streaming body APIs; environment proxy discovery remains enabled by default. The lockfile selects `webpki-roots` 1.0.10.

Native FFI, native library versions and archive extraction logic are unchanged. Remove these patches when upstream adopts fixed dependencies.

Upstream crate archive SHA-256: `14bbeabb73f73f1c1f4a278af0ee9ae90a19f9727482027047fb9422fa14f8fe`.
