# R0-4 补充 · 原生右键菜单的 API 事实（已从本机 cargo registry 源码核实）

> 来源：`~/.cargo/registry/src/index.crates.io-*/tauri-2.11.2/src/`
> 你当前 `src-tauri/src/lib.rs` 里的 `show_pet_context_menu` 有 2 个会导致编译失败或运行失效的问题，见下。

## 1. `menu` 被 move 后又使用 —— 编译不过

现状代码：

```rust
app.manage(PetContextMenu(Mutex::new(Some(menu))));   // menu 被 move 走
menu.popup(window).map_err(|e| e.to_string())?;        // 再使用 menu：use of moved value
```

`Menu` 不是 `Copy`，`manage` 接收 `T` 的所有权，所以第二行必然编译失败。

## 2. `Manager::manage` 对已存在的类型**不会替换**，而是丢弃新值

`src/lib.rs:688`：

```rust
fn manage<T>(&self, state: T) -> bool { self.manager().state().set(state) }
```

`src/state.rs:118-133`：

```rust
pub(crate) fn set<T: Send + Sync + 'static>(&self, state: T) -> bool {
  let mut map = self.map.lock().unwrap();
  let type_id = TypeId::of::<T>();
  let already_set = map.contains_key(&type_id);
  if !already_set { /* 只在不存在时插入 */ }
  !already_set
}
```

也就是说：`run()` 里已经 `.manage(PetContextMenu::default())`，命令内部再 `app.manage(PetContextMenu(...))` 会返回 `false`、**不写入**，`set` 结束时这个新值被直接 drop —— 你想靠它「持有 Menu 避免被 Drop」的目的达不到。

**建议改法**（保持你的 `PetContextMenu(Mutex<Option<Menu<Wry>>>)` 设计）：

```rust
#[tauri::command]
fn show_pet_context_menu(app: AppHandle) -> Result<(), String> {
    let window = app.get_window("pet").ok_or("宠物窗口不存在")?;   // 见第 3 点
    let chat_item  = MenuItem::with_id(&app, "pet_ctx_chat",  "对话",        true, None::<&str>).map_err(|e| e.to_string())?;
    let break_item = MenuItem::with_id(&app, "pet_ctx_break", "休息 5 分钟", true, None::<&str>).map_err(|e| e.to_string())?;
    let panel_item = MenuItem::with_id(&app, "pet_ctx_panel", "打开面板",    true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&chat_item, &break_item, &panel_item]).map_err(|e| e.to_string())?;

    let store = app.state::<PetContextMenu>();
    {
        let mut slot = store.0.lock().map_err(|_| "无法准备右键菜单".to_string())?;
        *slot = Some(menu);                     // 存进来，避免 popup 之后被 Drop
    }
    let guard = store.0.lock().map_err(|_| "无法准备右键菜单".to_string())?;
    if let Some(menu) = guard.as_ref() {
        menu.popup(window).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

`run()` 里的 `.manage(PetContextMenu::default())` **保留**（`Mutex<Option<Menu>>` 默认是 `None`）。

## 3. `popup` 要 `Window`，不是 `WebviewWindow`

- `ContextMenu::popup<R>(&self, window: crate::Window<R>)`（`src/menu/mod.rs:746`，实现在 `src/menu/menu.rs:29`）。
- `app.get_webview_window("pet")` 返回 `WebviewWindow<R>`，它只有 `AsRef<Webview<R>>`（`src/webview/webview_window.rs:1446`），**没有 `Deref` 到 `Window`**。
- 用 `app.get_window("pet") -> Option<Window<R>>`（`src/lib.rs:543`）最省事；或者 `webview_window.as_ref().window()`（`src/webview/mod.rs:1595`）。

## 4. `popup` 是 trait 方法，必须引入 trait

```rust
use tauri::menu::ContextMenu;
```

当前文件只 `use tauri::menu::{Menu, MenuItem};`，不加这行 `menu.popup(...)` 找不到方法。

## 5. `focus: State<'_, FocusTimer>` 参数是多余的

你的命令里只写了 `let _ = focus;`。菜单事件处理器已经通过 `app_handle.state::<FocusTimer>()` 拿到了状态，所以命令参数可以整个删掉。

`Manager::on_menu_event` 的签名是 `Fn(&AppHandle<R>, MenuEvent)`（`src/manager/menu.rs:97`），你现在 `run()` 里的写法可以用。

## 6. 已核实的其它签名（可直接用）

```rust
#[tauri::command] fn show_bubble(app: AppHandle)                  // lib.rs:2750
#[tauri::command] fn open_panel(app: AppHandle)                   // lib.rs:2781
#[tauri::command] fn start_break(app: AppHandle, focus: State<'_, FocusTimer>, minutes: u64) -> Result<FocusSnapshot, String>   // lib.rs:4244
                                                                  // minutes 只接受 5 | 10 | 15
```

## 7. 编译验证

```bash
cd src-tauri && cargo check
```

本机**没有**在跑 cargo，你可以直接用。注意：`npm run build` 与 `npm run test:e2e` 仍不要跑（会跟并行的 worker 抢 `dist/` 与 `127.0.0.1:4173`）。
