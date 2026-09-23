# Live2D 移除 · 交付报告

> 任务卡：`.sdlc/01-prd/tasks/live2d-removal.md`
> 执行环境：`/Volumes/W_W/claude-workspace/im-robot`，基线 commit `ceddb6f`
> 未执行 `npm install` / `npm uninstall`（按 Constraints 要求，仅改 `package.json` 文本）

## 1. 实际删除的文件/目录清单

目录（整棵删除，git 记录 178 个文件）：

```
public/live2d/                              （core/, models/, profiles/, sample/, official.profile.json, piko.profile.json）
```

文件（2 个）：

```
src/features/app/Live2DCharacterPet.tsx       489 行
src/features/app/Live2DCharacterPet.test.ts    94 行
```

删除方式：`git rm -r`（即时暂存删除）。

未被删除、确认保留：

```
src/features/app/LiveCharacterPet.tsx          （当前生效的 character 风格渲染器，一字未改）
public/pets/piko-character-sheet.png
public/pets/piko-character-sheet-cutout.png
public/pets/robot-cat-states.png / openpets-default.webp / piko-app-icon.png / LICENSE.openpets.txt
```

## 2. 按文件分组移除的符号清单

### src/features/app/appShared.tsx（-158 / +6）

导出符号，全部删除：

| 符号 | 种类 |
| --- | --- |
| `type Live2DModelId` | 联合类型（10 个 `official-*` 取值） |
| `const live2dModelStorageKey` | `"piko-live2d-model-id"` |
| `const live2dOfficialMigrationStorageKey` | `"piko-live2d-official-model-migrated"` |
| `const defaultLive2DModelId` | `"official-hiyori"` |
| `const live2dModelOptions` | 10 条模型注册表（含 `profileUrl` / `enabled` / `note`） |
| `function getLive2DModelId()` | |
| `function setLive2DModelId()` | （内含 `emit("piko-live2d-model-changed")`） |
| `function getLive2DProfileUrl()` | |
| `function getNextLive2DModelId()` | |
| `function useLive2DModelId()` | 含 `piko-live2d-model-changed` 事件监听 + Tauri listen |

其他改动：

- `getPetVisualStyle()`：整块删除 `live2dOfficialMigrationStorageKey !== "4"` 迁移分支，**未新增任何替代迁移**，删除后代码中不存在任何 `piko-live2d-*` 键写入。
- `petVisualStyleOptions` 的 `character` 项 label：`"Live2D 官方模型"` → **`"Piko 角色形象"`**（value `"character"` 不变）。
- 保留：`PetVisualStyle` 的 `"character"` 取值、`defaultPetVisualStyle`、`petVisualStyleStorageKey`、`customPetImageStorageKey`、`LiveCharacterPet` 的 import 与第 276 行的渲染分支。
- `emit` / `listen` / `UnlistenFn`（来自 `@tauri-apps/api/event`）仍被其余 3 处使用，import 保持不变。

### src/features/app/appShared.test.ts（-38 / +1）

- 删除整个 `describe("live2d model registry", ...)` 块（3 个 `it`：默认启用清单、profile url 解析、模型循环切换）。
- 删除 import 项：`defaultLive2DModelId`、`getLive2DProfileUrl`、`getNextLive2DModelId`、`live2dModelOptions`（收敛为 `import { getAvailablePetVisualStyleOptions, getNextPetVisualStyle } from "./appShared";`）。
- **未动** `describe("pet visual style switching", ...)` 两个用例。

### src/features/panel/PanelWindow.tsx（-38）

- import：`live2dModelOptions`、`setLive2DModelId`、`useLive2DModelId`
- 变量：`live2dModelId`、`enabledLive2DModelOptions`、`disabledLive2DModelOptions`、`live2dModelLabel`
- JSX：整个「Live2D 模型」`<label>` + `<select>` 块（含其上方 `TODO(R3/R5)` 注释，共 10 行注释）
- JSX：「未启用模型」提示块（`disabledLive2DModelOptions.length` 那段 `<p className="empty-state">`）
- `<CompanionHero>` 调用去掉 `modelLabel=` prop
- **保留**：`petVisualStyleLabel`（仍来自 `petVisualStyleOptions` 的 label）

### src/features/panel/PanelChrome.tsx（-4 / +2）

- `CompanionHero` 的 props 类型去掉 `modelLabel: string | null`
- 渲染逻辑去掉 `{modelLabel ? ` · ${modelLabel}` : ""}`，现为 `<span>{styleLabel}</span>`

### src/App.css（-19）

删除规则：

```
.live2d-character-pet, .live2d-character-host, .live2d-character-canvas { ... }
.live2d-character-pet { position: relative; }
.live2d-character-host, .live2d-character-canvas, .live2d-character-pet .live-character-pet { position: absolute; inset: 0; }
```

**保留** `.live-character-pet`（现位于 `src/App.css:437`）。

### vite.config.ts（-4）

删除 `manualChunks` 中 `vendor-pixi` 与 `vendor-live2d` 两个分支（`vendor-react` / `vendor-markdown` / `vendor-tauri` / `vendor` 不变）。

### package.json（-3）

`dependencies` 移除：

```
"@hazart-pkg/live2d-core": "^1.0.1"
"pixi.js": "^8.19.0"
"untitled-pixi-live2d-engine": "^1.2.0"
```

## 3. 验收命令真实输出

### 1) src 下 live2d 引用

```console
$ grep -rni "live2d" src --include=*.ts --include=*.tsx --include=*.css
[exit=1]      ← 无任何输出
```

### 2) 被删文件/目录不存在

```console
$ ls src/features/app/Live2DCharacterPet.tsx src/features/app/Live2DCharacterPet.test.ts public/live2d 2>&1
ls: public/live2d: No such file or directory
ls: src/features/app/Live2DCharacterPet.test.ts: No such file or directory
ls: src/features/app/Live2DCharacterPet.tsx: No such file or directory
[exit=1]
```

### 3) 必须保留的东西还在

```console
$ ls src/features/app/LiveCharacterPet.tsx public/pets/piko-character-sheet.png
public/pets/piko-character-sheet.png
src/features/app/LiveCharacterPet.tsx

$ grep -n "LiveCharacterPet" src/features/app/appShared.tsx
4:import { LiveCharacterPet } from "./LiveCharacterPet";
276:    return <LiveCharacterPet mode={mode} emotion={emotion} reaction={reaction} compact={compact} mouseDelta={mouseDelta} style={style} />;

$ grep -n '"character"' src/features/app/appShared.tsx | head -3
44:export type PetVisualStyle = "lumi" | "custom" | "classic" | "character";
52:  { label: "Piko 角色形象", value: "character" },
275:  if (effectiveVisualStyle === "character") {
```

### 4) 依赖已移除

```console
$ grep -n "live2d\|pixi" package.json
[exit=1]      ← 无任何输出
```

### 5) 类型 / lint / 单测

```console
$ npx tsc --noEmit
tsc exit: 0            ← 无任何输出
```

```console
$ npm run lint
...
✖ 71 problems (0 errors, 71 warnings)
```

（71 条全部是改动前即已存在的 warning：`no-explicit-any`、`react-hooks/set-state-in-effect` 等，与本次改动无关；**0 errors**。）

```console
$ npm test

> im-robot@1.2.7 test
> vitest run


 RUN  v4.1.7 /Volumes/W_W/claude-workspace/im-robot


 Test Files  12 passed (12)
      Tests  108 passed (108)
   Start at  20:38:59
   Duration  220ms (transform 398ms, setup 0ms, import 558ms, tests 38ms, environment 1ms)
```

补充自查（非任务卡要求，确认无残留引用）：

```console
$ grep -rn "Live2DCharacterPet\|live2dModelOptions\|setLive2DModelId\|useLive2DModelId\|getLive2DProfileUrl\|getNextLive2DModelId\|defaultLive2DModelId\|Live2DModelId\|live2dModelStorageKey\|live2dOfficialMigrationStorageKey\|modelLabel" src tests playwright.config.ts index.html
[exit=1]      ← src / tests / playwright 配置 / index.html 均无命中
```

## 4. public/live2d 删除前后体积

删除前（执行时实测）：

```console
$ du -sh public/live2d
 24M	public/live2d

$ find public/live2d -type f | wc -l
     178
```

删除前（另一种口径，git 追踪字节数）：

```console
$ git ls-tree -r HEAD public/live2d | awk '{print $3}' | git cat-file --batch-check | awk '{s+=$3} END {printf "%d bytes\n", s}'
tracked bytes: 24379236  = 24.38 MB / 23.2 MiB
```

删除后：

```console
$ du -sh public/live2d
du: public/live2d: No such file or directory
```

public 目录整体对比：

| 口径 | 删除前 | 删除后 |
| --- | --- | --- |
| `du -sk public` | — | `6052 KB`（`du -sh` = `5.9M`） |
| git 追踪字节数 | `30560433`（29.1 MB） | — |

即 `public/` 由 29.1 MB 降到 5.9 MB，减少约 23.2 MiB。

> 说明：删除前的 `du -sh public` 未在同一时刻取样，故上表用两种方式分别给出，均取自真实命令输出。

## 5. getPetVisualStyle() 改动后的完整代码

改动前：

```ts
export function getPetVisualStyle(): PetVisualStyle {
  if (typeof window === "undefined") return defaultPetVisualStyle;
  if (window.localStorage.getItem(live2dOfficialMigrationStorageKey) !== "4") {
    window.localStorage.setItem(live2dOfficialMigrationStorageKey, "4");
    window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
    window.localStorage.setItem(live2dModelStorageKey, defaultLive2DModelId);
    return defaultPetVisualStyle;
  }
  const stored = window.localStorage.getItem(petVisualStyleStorageKey);
  if (stored === "custom" && !getCustomPetImagePath()) return "classic";
  if (petVisualStyleOptions.some((option) => option.value === stored)) return stored as PetVisualStyle;
  if (stored) {
    window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
  }
  return defaultPetVisualStyle;
}
```

改动后（`src/features/app/appShared.tsx`，实际文件现状）：

```ts
export function getPetVisualStyle(): PetVisualStyle {
  if (typeof window === "undefined") return defaultPetVisualStyle;
  const stored = window.localStorage.getItem(petVisualStyleStorageKey);
  if (stored === "custom" && !getCustomPetImagePath()) return "classic";
  if (petVisualStyleOptions.some((option) => option.value === stored)) return stored as PetVisualStyle;
  if (stored) {
    window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
  }
  return defaultPetVisualStyle;
}
```

### 老用户 localStorage `piko-pet-visual-style === "character"` 时的行为

逐步走一遍：

1. `typeof window === "undefined"` 为 false → 继续。
2. 迁移分支已整块删除，不再读/写 `piko-live2d-official-model-migrated`，因此**不会因为该键缺失而强制重置风格**（这是本次最关键的行为变化：以前凡是没写过迁移标记的设备，一上来就被打回 `"classic"`）。
3. `stored = "character"`。
4. `stored === "custom"` 不成立 → 跳过。
5. `petVisualStyleOptions.some((o) => o.value === "character")` 为 **true**（`character` 选项保留，只是 label 改成了「Piko 角色形象」）→ **直接返回 `"character"`**。
6. 不写任何 localStorage，不写任何 `piko-live2d-*` 键，也不再清零 `piko-pet-visual-style`。

结论：老用户升级后**保持 `character` 风格不变**，仍渲染 `LiveCharacterPet`（canvas 精灵图，素材 `public/pets/piko-character-sheet.png`），面板「精灵形象」下拉框里该项显示为 **「Piko 角色形象」**。旧的 `piko-live2d-model-id` / `piko-live2d-official-model-migrated` 键按任务卡要求**不做清理**，留着无害（已无任何代码读取）。

补充：若 stored 是未知脏值（例如过去某次写入的非法值），行为同原先——写回 `defaultPetVisualStyle`（`"classic"`）并返回它；这条兜底逻辑本次未改。

## 6. 没做 / 做不了的事

- **未运行 `npm install` / `npm uninstall`**（任务卡 Constraints 明确禁止）。因此 `package-lock.json` **仍是旧内容**，其中仍然记录 `@hazart-pkg/live2d-core` / `pixi.js` / `untitled-pixi-live2d-engine` 及其传递依赖；`node_modules/` 里这三个包也还在。需要由 coordinator 统一处理（预计会顺带更新 lockfile）。在此之前 `npm ci` 仍会安装这 3 个包，但它们已无引用，不会进 bundle（`.sdlc` 之外的 `src` 已零命中）。
- **未运行 `npm run build` / `npm run test:e2e`**（任务卡禁止）。所以「构建产物确实减小 24MB」只有静态推导（资产已不在 `public/`，且 `vite` 原样拷贝 `public/`），未用真实构建产物验证。
- **未改动 `package-lock.json`**（同上，属于 npm install 的产物）。
- **未清理老用户 localStorage** 里的 `piko-live2d-model-id`、`piko-live2d-official-model-migrated` 两个残留键——按任务卡 §2 要求刻意保留。
- **未改动 `src/features/app/LiveCharacterPet.tsx` 与 `public/pets/**`**（任务卡「不要删的东西」），两者 git status 均无变更。
- **未删除 `character` 风格本身**，只改了它的显示名；`PetVisualStyle` 联合类型、`appShared.tsx:275` 的 `effectiveVisualStyle === "character"` 渲染分支、`petVisualStyleOptions` 中的该项均原样保留。
- 仓库根部的 `.understand-anything/knowledge-graph.json` 里仍有描述 `Live2DCharacterPet.tsx` 等已删文件的知识图谱条目（属于第三方生成的索引文件，不在任务卡允许改动的文件清单内），**未改动**。
- 改动已通过 `git rm` 暂存 deletion，但未 commit，等 coordinator 决定。
