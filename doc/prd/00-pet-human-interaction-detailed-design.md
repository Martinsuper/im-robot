# Piko 人宠交互详细实现方案

## 1. 背景与目标

当前 Piko 已具备桌面常驻、点击对话、拖动、文件拖放、基础状态机、情绪、成长、人格、换装和性能优化等能力。下一阶段目标是让精灵从“可点击的桌面挂件”升级为“能理解用户动作、给出合适反馈、长期形成陪伴关系的桌面伙伴”。

本方案聚焦精灵与用户的交互设计和工程落地：

- 统一人类动作入口，避免交互逻辑继续分散在 `PetWindow.tsx`。
- 将点击、拖动、抚摸、长按、拖放、专注、闲置、聊天等行为抽象为语义事件。
- 让交互事件驱动状态、情绪、人格、成长、声音、对话和记忆。
- 支持安静模式下低打扰、可控的主动陪伴。

## 2. 设计原则

1. 先识别语义，再触发表现。
   鼠标点击、移动、拖放只是原始输入，系统需要先判断用户是在呼唤、抚摸、拖动、投喂任务，还是长时间冷落。

2. 精灵反馈需要短期可见、长期有意义。
   每次交互要有即时动画/音效/台词，同时也应沉淀为亲密度、成长经验、行为偏好或记忆。

3. 主动行为必须可降噪。
   `minimal` 模式下只响应明确交互；`balanced` 模式下轻微陪伴；`expressive` 模式下才允许更多主动问候和玩耍。

4. 高风险任务不通过宠物动作直接执行。
   文件、系统操作、工具调用仍遵循“预览、确认、可撤销”的产品边界。

## 3. 总体架构

```text
用户行为
  ↓
PetWindow 捕获原始事件
  ↓
InteractionManager 识别语义交互
  ↓
PetState / EmotionManager / PersonalityManager / GrowthManager
  ↓
PetSprite / petAudio / BubbleWindow / Memory
```

建议新增模块：

```text
src/features/pet/interaction/
├── interactionTypes.ts
├── InteractionManager.ts
├── InteractionRules.ts
├── InteractionContext.ts
├── interactionStorage.ts
├── index.ts
└── interaction.test.ts
```

模块职责：

| 文件 | 职责 |
| --- | --- |
| `interactionTypes.ts` | 定义人类交互事件、上下文和精灵反应结果 |
| `InteractionManager.ts` | 统一入口，接收交互事件并输出反应 |
| `InteractionRules.ts` | 维护点击、双击、抚摸、拖放、闲置等规则 |
| `InteractionContext.ts` | 汇总当前模式、情绪、安静模式、短期统计 |
| `interactionStorage.ts` | 保存长期统计，如亲密度、互动次数、最近互动时间 |
| `interaction.test.ts` | 覆盖规则转换、安静模式、抚摸识别等关键行为 |

## 4. 核心类型

```ts
import type { PetEmotion, PetEvent } from "../petState";

export type HumanInteractionType =
  | "click"
  | "double_click"
  | "long_press"
  | "hover"
  | "hover_leave"
  | "drag_start"
  | "drag_move"
  | "drag_end"
  | "drop_file"
  | "drop_text"
  | "pet_stroke"
  | "chat_open"
  | "chat_submitted"
  | "chat_completed"
  | "user_idle_started"
  | "user_idle_ended"
  | "focus_started"
  | "focus_completed"
  | "ignored";

export interface HumanInteractionEvent {
  type: HumanInteractionType;
  timestamp: number;
  intensity?: number;
  payload?: {
    durationMs?: number;
    distancePx?: number;
    fileCount?: number;
    message?: string;
  };
}

export interface InteractionContext {
  quietMode: "minimal" | "balanced" | "expressive";
  petMode: string;
  petEmotion: string;
  isResting: boolean;
  recentInteractionCount: number;
  lastInteractionAt?: number;
  intimacy: number;
  energy: number;
}

export interface PetInteractionResult {
  petEvent?: PetEvent;
  emotion?: PetEmotion;
  message?: string;
  sound?: "click" | "greet" | "curious" | "celebrate" | "notice" | "error";
  openBubble?: boolean;
  openPanel?: boolean;
  saveStats?: boolean;
}
```

## 5. 交互事件映射

| 用户行为 | 语义事件 | 精灵状态 | 情绪 | 反馈 |
| --- | --- | --- | --- | --- |
| 单击精灵 | `click` | `INTERACT` | `happy` | 打开对话气泡，播放点击音 |
| 双击精灵 | `double_click` | `WAKE` / `REST` | `sleepy` / `happy` | 休息或唤醒 |
| 长按精灵 | `long_press` | 保持当前状态 | `curious` | 打开上下文菜单 |
| 鼠标悬停 | `hover` | 保持当前状态 | `curious` | 视线跟随 |
| 拖动开始 | `drag_start` | `DRAG_STARTED` | `surprised` | 身体倾斜 |
| 拖动结束 | `drag_end` | `DRAG_RELEASED` | `playful` | 惯性滑动 |
| 小范围连续移动 | `pet_stroke` | `PET_STROKED` | `happy` | 摸摸反馈 |
| 文件拖放 | `drop_file` | `ATTACHMENT_READY` | `excited` | 准备附件处理 |
| 文本/URL 拖放 | `drop_text` | `LISTEN` | `curious` | 打开对话气泡 |
| 用户进入闲置 | `user_idle_started` | `REST` | `sleepy` | 低频动画 |
| 用户返回 | `user_idle_ended` | `WAKE` | `happy` | 问候 |
| 专注完成 | `focus_completed` | `CHAT_COMPLETED` | `happy` | 庆祝 |

## 6. InteractionManager 规则

`InteractionManager` 应保持纯 TypeScript 逻辑，便于单元测试：

```ts
export class InteractionManager {
  handle(
    event: HumanInteractionEvent,
    context: InteractionContext
  ): PetInteractionResult {
    if (context.quietMode === "minimal") {
      return this.handleMinimal(event, context);
    }

    switch (event.type) {
      case "click":
        return {
          petEvent: { type: "INTERACT" },
          emotion: "happy",
          sound: "click",
          openBubble: true,
          saveStats: true,
        };

      case "double_click":
        return {
          petEvent: { type: context.isResting ? "WAKE" : "REST" },
          sound: "greet",
          saveStats: true,
        };

      case "pet_stroke":
        return {
          petEvent: { type: "PET_STROKED" },
          emotion: "happy",
          sound: "greet",
          saveStats: true,
        };

      case "drop_file":
        return {
          petEvent: { type: "ATTACHMENT_READY" },
          emotion: "excited",
          sound: "curious",
          saveStats: true,
        };

      case "focus_completed":
        return {
          petEvent: { type: "CHAT_COMPLETED" },
          emotion: "happy",
          sound: "celebrate",
          saveStats: true,
        };

      default:
        return {};
    }
  }

  private handleMinimal(
    event: HumanInteractionEvent,
    context: InteractionContext
  ): PetInteractionResult {
    if (event.type === "click") {
      return { openBubble: true, saveStats: true };
    }

    if (event.type === "double_click") {
      return { petEvent: { type: context.isResting ? "WAKE" : "REST" } };
    }

    return {};
  }
}
```

## 7. `PetWindow` 改造

`PetWindow.tsx` 当前直接 `dispatch` 多种事件。改造后应增加统一入口：

```ts
const interactionManager = useMemo(() => new InteractionManager(), []);

function handleHumanInteraction(event: HumanInteractionEvent) {
  const result = interactionManager.handle(event, {
    quietMode,
    petMode: petState.mode,
    petEmotion: petState.emotion,
    isResting,
    recentInteractionCount: 0,
    intimacy: 0,
    energy: 1,
  });

  if (result.petEvent) dispatch(result.petEvent);
  if (result.sound && quietMode !== "minimal") playInteractionSound(result.sound);
  if (result.openBubble) void runCommand("show_bubble");
  if (result.openPanel) void runCommand("open_panel");
  if (result.saveStats) saveInteractionStats(event);
}
```

原点击逻辑调整为：

```ts
onClick={() => {
  if (didDrag.current) {
    didDrag.current = false;
    return;
  }

  handleHumanInteraction({
    type: "click",
    timestamp: Date.now(),
  });
}}
```

双击逻辑调整为：

```ts
onDoubleClick={(event) => {
  event.stopPropagation();
  handleHumanInteraction({
    type: "double_click",
    timestamp: Date.now(),
  });
}}
```

## 8. 抚摸识别

抚摸需要和拖动区分：

```text
拖动：最终位移明显，目标是移动精灵窗口。
抚摸：路径距离较长，但最终位移较小，目标是在精灵身上来回移动。
长按：低位移、低路径距离、持续超过阈值，打开菜单。
```

建议规则：

| 条件 | 判定 |
| --- | --- |
| 最终位移 `> 16px` | 拖动 |
| 路径距离 `> 24px` 且最终位移 `< 16px` | 抚摸 |
| 按住 `> 520ms` 且最终位移 `< 4px` | 长按 |

松手时计算：

```ts
const totalDistance = calculatePathDistance(strokeSamples.current);
const displacement = calculateDisplacement(strokeSamples.current);

if (totalDistance > 24 && displacement < 16) {
  handleHumanInteraction({
    type: "pet_stroke",
    timestamp: Date.now(),
    intensity: Math.min(1, totalDistance / 120),
  });
}
```

## 9. 状态机扩展

建议在 `petState.ts` 增加语义事件：

```ts
| { type: "PET_STROKED" }
| { type: "PLAYFUL_INTERACTION" }
| { type: "USER_RETURNED" }
| { type: "USER_IGNORED" }
| { type: "DRAG_STARTED" }
| { type: "DRAG_RELEASED" }
| { type: "FILE_OFFERED" };
```

示例 reducer：

```ts
case "PET_STROKED":
  return {
    mode: "idle",
    message: "Piko 很喜欢这样。",
    emotion: "happy",
    reaction: "greet",
  };

case "PLAYFUL_INTERACTION":
  return {
    mode: "idle",
    message: "Piko 想和你玩一会儿。",
    emotion: "playful",
    reaction: "celebrate",
  };

case "USER_RETURNED":
  return {
    mode: "idle",
    message: "欢迎回来。",
    emotion: "happy",
    reaction: "greet",
  };
```

## 10. 情绪、人格与成长接入

### 情绪系统

`EmotionTriggers` 已有 `click`、`double_click`、`hover`、`pet`、`file_drop` 等规则。下一步应由 `InteractionManager` 调用情绪触发器，根据结果合成 `PetInteractionResult`。

```text
HumanInteractionEvent("pet_stroke")
  ↓
EmotionTriggers.processEvent({ type: "pet" })
  ↓
happy / intensity / duration
  ↓
PetInteractionResult
```

### 人格系统

`BehaviorSystem` 当前主要输出 `console.debug`，建议改为回调真实事件：

```ts
constructor(
  personalityManager: PersonalityManager,
  private onBehavior: (event: PetEvent) => void
) {}
```

人格影响：

| 人格维度 | 影响 |
| --- | --- |
| `energy` 高 | 更频繁小动作、游走、主动问候 |
| `curiosity` 高 | 更容易对悬停、文件、截图表现好奇 |
| `humor` 高 | 更多 playful reaction |
| `humor` 低 | 更安静，更偏工作模式 |

### 成长系统

建议新增交互统计：

```ts
export interface InteractionStats {
  totalInteractions: number;
  todayInteractions: number;
  petStrokeCount: number;
  chatCount: number;
  fileDropCount: number;
  focusCompletedCount: number;
  lastInteractionAt?: number;
  intimacy: number;
}
```

经验值规则：

| 交互 | 成长影响 |
| --- | --- |
| `click` | 亲密度 +1 |
| `pet_stroke` | 亲密度 +2 |
| `chat_completed` | 沟通经验 +3 |
| `drop_file` | 协作经验 +4 |
| `focus_completed` | 陪伴经验 +5 |
| `ignored` | 降低活跃度，不扣亲密度 |

## 11. 主动行为策略

| 模式 | 策略 |
| --- | --- |
| `minimal` | 只响应用户明确交互，不主动弹窗，不播放声音 |
| `balanced` | 允许注意力脉冲、低频游走、提醒和任务完成庆祝 |
| `expressive` | 允许主动问候、陪玩、小动作和更多情绪表达 |

主动行为建议：

```text
用户 12s 没互动：attentionPulse
用户 5-15s 空闲：随机游走
用户专注 25min：提醒休息
用户回来：打招呼
用户完成任务：庆祝
长时间未互动：休息/yawn，不弹窗
```

## 12. 实施阶段

### Phase 1：交互事件层

- 新增 `interactionTypes.ts`。
- 新增 `InteractionManager.ts`。
- `PetWindow.tsx` 使用 `handleHumanInteraction`。
- 保持现有点击、双击、拖放体验不变。
- 增加 `interaction.test.ts`。

验收：

- 单击仍打开对话气泡。
- 双击仍休息/唤醒。
- 拖文件仍进入附件处理。
- `quietMode = minimal` 时不会播放声音。

### Phase 2：抚摸和长按优化

- 增加 `pet_stroke` 识别。
- 增加 `PET_STROKED` 状态。
- 避免和拖动、长按菜单冲突。

验收：

- 小范围来回移动会触发摸摸。
- 拖动精灵不会误判为摸摸。
- 长按仍可打开菜单。

### Phase 3：情绪与人格接入

- `InteractionManager` 调用 `EmotionTriggers`。
- `BehaviorSystem` 改为回调 `PetEvent`。
- 根据 `quietMode` 和人格维度调整主动行为频率。

验收：

- `click` 触发开心。
- `hover` 触发好奇。
- `pet_stroke` 触发开心或 playful。
- 高 `energy` 更容易触发小动作。

### Phase 4：成长和记忆

- 新增 `InteractionStats`。
- 记录亲密度、今日互动、文件协作、聊天次数。
- 接入 `GrowthManager` 和 `AchievementSystem`。
- 在面板展示基础成长数据。

验收：

- 互动次数可持久化。
- 亲密度随交互增长。
- 完成任务能增加成长经验。
- 成就系统能识别交互里程碑。

## 13. 测试计划

单元测试：

- `InteractionManager` 在不同 `quietMode` 下的输出。
- `pet_stroke`、`drag_end`、`long_press` 的判定边界。
- `InteractionStats` 日期切换和累计逻辑。

组件测试：

- `PetWindow` 点击、双击、拖放事件是否调用统一交互入口。
- `minimal` 模式下声音和主动弹窗是否被抑制。

E2E 检查：

- 桌面精灵可点击打开气泡。
- 拖动后位置正常保存。
- 拖文件到精灵后进入附件确认。
- 抚摸不会导致窗口异常移动。

## 14. 风险与约束

- Tauri 透明窗口下鼠标事件在不同平台可能存在差异，需要在 macOS、Windows、Linux 分别验证。
- 抚摸识别容易与拖动冲突，需要通过阈值和样本数控制误判。
- 主动行为不能影响用户专注，必须受 `quietMode` 控制。
- 长期统计初期可用 `localStorage`，但正式版本建议迁移到 Rust 侧持久化存储。

## 15. 第一批落地优先级

1. `InteractionManager` 和统一事件入口。
2. `pet_stroke` 抚摸识别。
3. `EmotionTriggers` 实际接入。
4. `BehaviorSystem` 输出真实 `PetEvent`。
5. `InteractionStats` 记录亲密度和今日互动。
