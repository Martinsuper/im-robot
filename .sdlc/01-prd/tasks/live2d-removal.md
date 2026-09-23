# 任务卡 · 彻底删除 Live2D 能力

> 由 coordinator 派发给 worker。执行前请完整阅读本文件，不要额外发挥。
> 背景与决策依据：`.sdlc/01-prd/09-R0执行清单.md` §10（NEW-13）。

## 背景（已核实，直接采信）

Live2D 能力已经**从产品中断开**：

- `petVisualStyle === "character"` 实际渲染 `LiveCharacterPet`（静态精灵图，无模型概念）
- 唯一会读 `live2dModelId` / `profileUrl` 的 `Live2DCharacterPet` **全库零引用**
- 面板里的「Live2D 模型」下拉框是**空操作**：选了只会写 localStorage，视觉不变
- `public/live2d` 的 24MB 资产从不加载，却仍打进构建产物
- 成因：`32a0b28`(2026-06-09) 引入 Live2D 时它是主渲染器；那批未提交的重构把它换成了回退组件，却没删掉主渲染器、选择器与资产

**用户已决策：删干净。**

## ⚠️ 不要删的东西（删了就是功能回退）

| 必须保留 | 原因 |
| --- | --- |
| `src/features/app/LiveCharacterPet.tsx` | 这是**当前真正生效**的角色渲染器（`character` 风格），名字带 Live 但它是 canvas 精灵图，与 Live2D 无关 |
| `public/pets/piko-character-sheet.png` 与 `piko-character-sheet-cutout.png` | 上面那个组件的素材 |
| `petVisualStyleOptions` 里的 `character` 选项与 `PetVisualStyle` 的 `"character"` 取值 | 用户可能正在用这个风格 |
| `public/pets/` 下其他文件（robot-cat-states.png 等） | 属于 `lumi` / `classic` 风格 |

> **`character` 这个风格要保留，但它的显示名要改。** 现在叫「Live2D 官方模型」，
> 是错的——删掉 Live2D 之后这个名字会变成纯粹的误导。请改成 **「Piko 角色形象」**。

## Change

### 1. 删除文件

```
src/features/app/Live2DCharacterPet.tsx
src/features/app/Live2DCharacterPet.test.ts
public/live2d/                        （整个目录，24MB / 178 个文件）
```

### 2. `src/features/app/appShared.tsx`（45 处引用）

删除以下导出及其全部引用：

```
type Live2DModelId
const live2dModelStorageKey
const live2dOfficialMigrationStorageKey
const defaultLive2DModelId
const live2dModelOptions
function getLive2DModelId()
function setLive2DModelId()
function getLive2DProfileUrl()
function getNextLive2DModelId()
function useLive2DModelId()
```

**`getPetVisualStyle()` 里的迁移分支必须小心处理**：

```ts
// 现在长这样
if (window.localStorage.getItem(live2dOfficialMigrationStorageKey) !== "4") {
  window.localStorage.setItem(live2dOfficialMigrationStorageKey, "4");
  window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
  window.localStorage.setItem(live2dModelStorageKey, defaultLive2DModelId);
  return defaultPetVisualStyle;
}
```

这个分支的存在意义只是「Live2D 模型清单变过，强制重置一次风格」。Live2D 删除后它没有意义了，
**整块删掉**，直接读 `petVisualStyleStorageKey`。

- 不要新增别的迁移。
- 不要在删除后往 localStorage 写入任何 `piko-live2d-*` 键。
- 老用户 localStorage 里残留的 `piko-live2d-model-id` 键**不用清理**（留着无害，清它反而增加一次启动写入）。

### 3. `src/features/app/appShared.test.ts`（14 处）

删除 `describe("live2d model registry", ...)` 整个块及其顶部对应的 import。
**不要**动该文件里其他用例。

### 4. `src/features/panel/PanelWindow.tsx`（19 处）

- 删除 import：`live2dModelOptions`、`setLive2DModelId`、`useLive2DModelId`
- 删除 `live2dModelId`、`enabledLive2DModelOptions`、`disabledLive2DModelOptions`、`live2dModelLabel` 四个变量（约 138-145 行）
- 删除「Live2D 模型」`<select>` 整块，以及它上面那段 `TODO(R3/R5)` 注释
- 删除「未启用模型」提示块（`disabledLive2DModelOptions.length` 那段，约 1141-1145 行）
- `CompanionHero` 的调用改为不再传 `modelLabel`（约 920 行）
- `petVisualStyleLabel` 保留（它来自 `petVisualStyleOptions` 的 label）

### 5. `src/features/panel/PanelChrome.tsx`

`CompanionHero` 的 `modelLabel` prop 去掉，包括它渲染逻辑里的
`{modelLabel ? ` · ${modelLabel}` : ""}` 部分。

### 6. `src/App.css`（7 处）

删除 `.live2d-character-pet`、`.live2d-character-host`、`.live2d-character-canvas`
以及 `.live2d-character-pet .live-character-pet` 相关规则。
**保留** `.live-character-pet` 自己的样式（那是当前生效的渲染器）。

### 7. `petVisualStyleOptions` 的 label

```ts
{ label: "Live2D 官方模型", value: "character" },   // ← 改成
{ label: "Piko 角色形象",   value: "character" },
```

### 8. `vite.config.ts`（26-28 行）

删除 `vendor-pixi` 与 `vendor-live2d` 两个 manualChunks 分支
（pixi 与 live2d 引擎即将从依赖里移除，留着这两个分支是死代码）。

### 9. `package.json`

删除这三个依赖：

```
"@hazart-pkg/live2d-core"
"pixi.js"
"untitled-pixi-live2d-engine"
```

已核实：这三个包**只**被 `Live2DCharacterPet.tsx` import，删除后无其他引用。

**但不要运行 `npm install` / `npm uninstall`**——node_modules 由 coordinator 统一处理，
避免与并行的构建/验证抢资源。只改 `package.json` 文本。

## Constraints

- 只允许改上面列出的文件/目录。
- **不要碰** `src/features/app/LiveCharacterPet.tsx`、`public/pets/**`。
- 不要顺手改任何与 Live2D 无关的东西（例如不要把 `character` 风格一起删掉）。
- 不要运行 `npm install`、`npm run build`、`npm run test:e2e`。
  可以运行 `npx tsc --noEmit`、`npm run lint`、`npm test`。

## Observable acceptance（必须贴出真实命令输出）

```bash
# 1. src 下不再有任何 live2d 引用（大小写不敏感）
grep -rni "live2d" src --include=*.ts --include=*.tsx --include=*.css
#    期望无输出

# 2. 被删的文件与目录确实不在了
ls src/features/app/Live2DCharacterPet.tsx src/features/app/Live2DCharacterPet.test.ts public/live2d
#    期望三者都报 No such file or directory

# 3. 必须保留的东西还在
ls src/features/app/LiveCharacterPet.tsx public/pets/piko-character-sheet.png
grep -n "LiveCharacterPet" src/features/app/appShared.tsx
grep -n '"character"' src/features/app/appShared.tsx | head -3

# 4. 依赖已从 package.json 移除
grep -n "live2d\|pixi" package.json            # 期望无输出

# 5. 类型 / lint / 单测
npx tsc --noEmit                                # 期望无输出
npm run lint                                    # 期望 0 errors
npm test                                        # 期望全过
```

## 交付格式

**完成后必须把下面的内容写入新文件 `.sdlc/01-prd/tasks/live2d-removal.report.md`**：

1. 实际删除的文件/目录清单。
2. 实际从各文件移除的符号清单（按文件分组）。
3. 上面 5 条验收命令的**真实输出**。
4. `public/live2d` 删除前后的体积（`du -sh`）。
5. `getPetVisualStyle()` 改动后的完整代码片段，说明老用户 localStorage 里
   `piko-pet-visual-style` 为 `"character"` 时的行为。
6. 任何你没做或做不了的事，直接说明不要跳过。
