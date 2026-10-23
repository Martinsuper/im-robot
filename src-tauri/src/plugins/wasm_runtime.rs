//! Bounded WASI execution; no inherited environment, filesystem, network or host stdio.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};
use wasmtime::{Config, Engine, Module, Store, StoreLimits, StoreLimitsBuilder, UpdateDeadline};
use wasmtime_wasi::{p1::WasiP1Ctx, WasiCtxBuilder};
const MAX_MODULE: u64 = 16 * 1024 * 1024;
const MAX_INPUT: usize = 1024 * 1024;
const FUEL: u64 = 10_000_000;
const MEMORY: usize = 64 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(2);
struct Context {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
}
struct Cached {
    modified: Option<SystemTime>,
    size: u64,
    module: Module,
}
struct Runtime {
    engine: Engine,
    modules: Mutex<HashMap<PathBuf, Cached>>,
}
static RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
    let mut config = Config::new();
    config
        .consume_fuel(true)
        .epoch_interruption(true)
        .max_wasm_stack(512 * 1024);
    let engine = Engine::new(&config).map_err(|e| e.to_string())?;
    let ticker = engine.clone();
    crate::background::SUPERVISOR.spawn("wasm-epoch-clock", move |worker| {
        while worker.wait(Duration::from_millis(10)) {
            ticker.increment_epoch();
        }
        Ok(())
    });
    Ok(Runtime {
        engine,
        modules: Mutex::new(HashMap::new()),
    })
});
fn module_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    if Path::new(name).is_absolute()
        || Path::new(name)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(crate::error_codes::WASM_MODULE_PATH_INVALID.into());
    }
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let module = root.join(name).canonicalize().map_err(|e| e.to_string())?;
    if !module.starts_with(&root) || module.extension().and_then(|s| s.to_str()) != Some("wasm") {
        return Err(crate::error_codes::WASM_MODULE_OUTSIDE_PLUGIN.into());
    }
    Ok(module)
}
impl Runtime {
    fn module(&self, path: &Path) -> Result<Module, String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_MODULE {
            return Err(crate::error_codes::WASM_MODULE_TOO_LARGE.into());
        }
        let modified = metadata.modified().ok();
        let mut cache = self.modules.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache.get(path) {
            if modified.is_some() && cached.modified == modified && cached.size == metadata.len() {
                return Ok(cached.module.clone());
            }
        }
        // Read through a bound even when a file grows after metadata inspection.
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(MAX_MODULE + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MODULE {
            return Err(crate::error_codes::WASM_MODULE_TOO_LARGE.into());
        }
        let module = Module::new(&self.engine, bytes).map_err(|e| e.to_string())?;
        if cache.len() >= 16 {
            cache.clear();
        }
        cache.insert(
            path.into(),
            Cached {
                modified,
                size: metadata.len(),
                module: module.clone(),
            },
        );
        Ok(module)
    }
}
pub(super) fn execute(
    directory: &Path,
    name: &str,
    input: Vec<u8>,
) -> Result<(String, String), String> {
    if input.len() > MAX_INPUT {
        return Err(crate::error_codes::WASM_INPUT_TOO_LARGE.into());
    }
    if crate::background::SUPERVISOR
        .statuses()
        .iter()
        .any(|s| s.name == "wasm-epoch-clock" && s.state != "running")
    {
        return Err(crate::error_codes::WASM_RUNTIME_STOPPED.into());
    }
    let runtime = RUNTIME.as_ref().map_err(Clone::clone)?;
    let module = runtime.module(&module_path(directory, name)?)?;
    execute_module(&runtime.engine, &module, input, FUEL, DEADLINE)
}
fn execute_module(
    engine: &Engine,
    module: &Module,
    input: Vec<u8>,
    fuel: u64,
    deadline: Duration,
) -> Result<(String, String), String> {
    let stdout = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(1024 * 1024);
    let stderr = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(256 * 1024);
    let wasi = WasiCtxBuilder::new()
        .stdin(wasmtime_wasi::p2::pipe::MemoryInputPipe::new(input))
        .stdout(stdout.clone())
        .stderr(stderr.clone())
        .build_p1();
    let limits = StoreLimitsBuilder::new()
        .memory_size(MEMORY)
        .table_elements(10_000)
        .instances(1)
        .memories(1)
        .tables(2)
        .trap_on_grow_failure(true)
        .build();
    let mut store = Store::new(engine, Context { wasi, limits });
    store.limiter(|ctx| &mut ctx.limits);
    store.set_fuel(fuel).map_err(|e| e.to_string())?;
    let expires = Instant::now() + deadline;
    store.set_epoch_deadline(1);
    store.epoch_deadline_callback(move |_| {
        if Instant::now() >= expires {
            Err(wasmtime::Error::msg("wasm_execution_timeout"))
        } else {
            Ok(UpdateDeadline::Continue(1))
        }
    });
    let mut linker = wasmtime::Linker::new(engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |ctx: &mut Context| &mut ctx.wasi)
        .map_err(|e| e.to_string())?;
    let instance = linker
        .instantiate(&mut store, module)
        .map_err(|e| format!("wasm_instantiation_failed: {e:#}"))?;
    instance
        .get_typed_func::<(), ()>(&mut store, "_start")
        .map_err(|e| e.to_string())?
        .call(&mut store, ())
        .map_err(|e| format!("wasm_execution_failed: {e:#}"))?;
    Ok((
        String::from_utf8(stdout.contents().to_vec()).map_err(|e| e.to_string())?,
        String::from_utf8_lossy(&stderr.contents()).into(),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn engine() -> Engine {
        let mut config = Config::new();
        config.consume_fuel(true).epoch_interruption(true);
        Engine::new(&config).unwrap()
    }
    #[test]
    fn infinite_loops_and_memory_growth_trap() {
        let engine = engine();
        let looping =
            Module::new(&engine, "(module (func (export \"_start\") (loop br 0)))").unwrap();
        assert!(execute_module(&engine, &looping, vec![], 1000, DEADLINE)
            .unwrap_err()
            .contains("fuel"));
        let huge =
            Module::new(&engine, "(module (memory 2048) (func (export \"_start\")))").unwrap();
        assert!(execute_module(&engine, &huge, vec![], FUEL, DEADLINE).is_err());
    }
    #[test]
    fn epoch_deadline_interrupts_even_with_a_large_fuel_budget() {
        let engine = engine();
        let module =
            Module::new(&engine, "(module (func (export \"_start\") (loop br 0)))").unwrap();
        let ticker = engine.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            ticker.increment_epoch();
        });
        let result = execute_module(&engine, &module, vec![], u64::MAX, Duration::from_millis(1));
        thread.join().unwrap();
        assert!(result.unwrap_err().contains("wasm_execution_timeout"));
    }
    #[test]
    fn rejects_traversal_and_allows_valid_modules() {
        let dir = tempfile::tempdir().unwrap();
        assert!(module_path(dir.path(), "../outside.wasm").is_err());
        let engine = engine();
        let module = Module::new(&engine, "(module (func (export \"_start\")))").unwrap();
        assert!(execute_module(&engine, &module, vec![], 1000, DEADLINE).is_ok());
    }
}
