# 任务卡 · R3-1/R3-2 精灵状态机与情绪收敛

> 由 coordinator 派发。执行前请完整阅读本文件、`01-模块-桌面精灵与陪伴.md` §5–§6、
> `09-R0执行清单.md` §15.4。

## 目标

把 `petState.ts` 的 9 个 mode 收敛为 **7 个**，情绪 9 种收敛为 **4 种**，
**并取消 reaction 这一层**（01 §5.2）。

## 目标定义（01 §5 照抄，不要自己改）

### 7 个状态

| 状态 | 触发 | 表现 | 自动恢复 |
| --- | --- | --- | --- |
| `idle` | 默认 | 呼吸循环、偶尔小动作 | — |
| `listening` | 悬停 / 聚焦输入 | 抬头、视线跟随 | 指针离开后 800ms |
| `thinking` | 对话进行中 | 思考气泡 / 轻微晃动 | 对话结束 |
| `speaking` | 流式回复中 | 嘴部或身体节奏动 | 回复结束 |
| `resting` | 双击 / 长时间无交互 | 闭眼、慢呼吸 | 双击唤醒 |
| `success` | 提醒完成 / 专注结束 | 跳跃 + 庆祝 | 2.4s 后回 idle |
| `error` | 出错了 | 轻微摇头 / 担心表情 | 2.4s 后回 idle |

**删除**：`working`（并入 `thinking`）、`confirming`（并入 `thinking`）。

### 4 种情绪

`neutral` / `happy` / `curious` / `sleepy`。

映射现状情绪：`excited`/`playful` → `happy`；`surprised` → `curious`；
`thoughtful` → `curious`；`worried` → `sleepy`（`sleepy` 语义是「低唤醒」，安心与担忧都归入）。

**必须由明确事件驱动**，单个情绪 3~6s 后回落 `neutral`，不允许随机漂移。

### reaction 层取消

`PetReaction`（7 种）不再存在。它的三种去处：
1. **音频**（`PetWindow.tsx` 里 `switch (petState.reaction)` 那段播放音效的逻辑）
   → 改为由**事件**驱动（`PET_STROKED` 播抚摸音、`REMINDER_FIRED` 播庆祝音……）。
2. **动画**（`LiveCharacterPet.tsx` 的 `getActionTheme`、`appShared.tsx` 的
   `getRobotCatFrame`）→ 由 `mode + emotion` 决定，reaction 不再入参。
3. **CSS**（`App.css` 的 `.pet-reaction--*` 5 条规则）→ 删除。

## 视觉验证协议（必须做，这是本任务的验收核心）

coordinator 已确认本机 `screencapture` 可用、且有合成鼠标工具。验证循环：

```bash
# 截精灵窗口（逻辑坐标 1690,206 260x300）
screencapture -x -R1690,176,280,360 /tmp/pet-states/<名字>.png

# 合成鼠标事件（coordinator 的工具，已编译好）
/tmp/pikoclick/click <x> <y> [left|right]     # 单击
/tmp/pikoclick/drag <x1> <y1> <x2> <y2> [steps]  # 拖拽

# 精灵窗口中心 = (1820, 356)（当前 pet-position.json 下）
# 对比两张截图是否真的变了（精灵是动画，相同状态的截图也会因帧不同而不同，
# 所以要看「内容」而不是比 md5）
```

**每改一个状态映射，就截一次图对比**。参考基线（coordinator 已截，可直接看）：

- `/tmp/pet-states/baseline.png` — idle（橙色像素小方块，居中，呼吸）
- `/tmp/pet-states/hover.png` — hover 后（视线/姿态变化）
- `/tmp/pet-states/drag.png` — 拖拽中

## 触发路径（验证用）

| 状态 | 怎么触发 |
| --- | --- |
| `idle` | 默认 |
| `listening` | 鼠标悬停在精灵上 |
| `thinking` | 在对话窗口发消息 |
| `speaking` | 流式回复中（难截，可只在代码层保证转移正确） |
| `resting` | 双击精灵 |
| `success` | 让一个提醒到点（或专注结束） |
| `error` | 断网发消息（或临时把 base url 改坏） |

## 约束

- **不要碰** `src/features/panel/**`、`src/features/chat/**`、`src/App.css` 之外的
  面板样式、`src/features/app/providerPresets.ts`。
- `App.css` 只允许删 `.pet-reaction--*` 相关规则；其他面板样式不要动。
- **不要删除任何 backend/引擎文件**（`emotion/`、`growth/`、`outfit/`、
  `optimization/`、`personality/` 目录保留）——只改它们对外的表现接线。
  若某模块因 reaction 取消而失去唯一消费者，**在报告里说明**，由 coordinator 决定去留。
- 精灵表行号映射（`petSpriteStates` 的 row/frames/duration）**不许改动**，
  否则动画会错位。`working` 与 `thinking` 并入后，它们原本的行映射直接删除即可。
- 全部完成后必须让 `cargo test`、`npm test`、`npm run build`、`npm run lint`、
  `npx tsc --noEmit` 全绿。
- **不要运行 `npm run test:e2e`**（coordinator 统一跑）。

## Observable acceptance（必须贴出真实输出）

```bash
npx tsc --noEmit                     # 0
npm run lint                         # 0 errors
npm test                             # 全过（petState.test.ts 需同步更新）
npm run build                        # 通过
(cd src-tauri && cargo test)         # 105 passed（不得减少）

# 状态数收敛
grep -c '  | "' src/features/pet/petState.ts                    # mode+emotion 行数
grep -n "PetReaction" src --include=*.ts --include=*.tsx        # 期望无输出
grep -n "pet-reaction--" src/App.css                            # 期望无输出
```

外加：**至少 4 张**改后截图（idle / listening / thinking / resting），
与基线对比说明每个状态的表现仍正确。

## 交付格式

**写入 `.sdlc/01-prd/tasks/pet-state.report.md`**：

1. 改动文件列表。
2. 上面验收命令的真实输出。
3. 7 状态 × 触发方式 × 截图文件 的对照表（每状态一行，截图路径）。
4. 情绪映射表（旧 → 新）。
5. reaction 的三种去处的具体落点（音频 / 动画 / CSS）。
6. 失去消费者的模块清单（coordinator 决定去留）。
7. 没做/做不了的事。
