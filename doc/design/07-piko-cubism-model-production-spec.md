# Piko Cubism 模型制作交付规范

## 1. 结论

真正达到 Live2D 官方示例质感，需要一套由 Live2D Cubism Editor 导出的 Piko 模型资产。

当前阶段采用 Live2D 官方示例模型作为默认角色形象，不再用临时照片或 CSS 形象模拟 Cubism 效果。等具备 Piko 分层原画和 Cubism 工程后，再把官方模型替换成真正的 Piko 模型。

项目运行层已经支持：

- `.model3.json`
- `.moc3`
- texture atlas
- `.physics3.json`
- `.pose3.json`
- `.motion3.json`
- `.exp3.json`
- 语义动作 profile

但 `.moc3` 不能由当前前端代码或普通图片自动生成。它需要在 Cubism Editor 中完成分层建模、网格、变形器、参数、物理、动作并导出。

## 2. 目标效果

Piko 应达到以下标准：

- 非照片切换，不用整图换姿势。
- 有自然呼吸、眨眼、头部转向、眼球跟随。
- 有物理：头发、耳朵、尾巴、衣摆或挂件轻摆。
- 有可复用动作：待机、问候、思考、开心、惊讶、担心、庆祝、困倦。
- 有表情：默认、开心、调皮、好奇、困倦、惊讶、担心、庆祝。
- 点击或状态变化能触发动作。
- 桌面宠物窗口中清晰可读，不需要用户放大才能辨认。

## 3. 源文件要求

### 3.1 分层原画

建议画布：

- 2048 x 2048 或 3072 x 3072
- 透明背景
- 正面偏 3/4 视角
- 头身比例偏桌宠可爱风，避免全身过细

必须拆分为独立图层：

- `Head_Base`
- `Face_Base`
- `Hair_Back`
- `Hair_Front_L`
- `Hair_Front_R`
- `Ear_L`
- `Ear_R`
- `Eye_L_White`
- `Eye_L_Iris`
- `Eye_L_Highlight`
- `Eye_L_Lid`
- `Eye_R_White`
- `Eye_R_Iris`
- `Eye_R_Highlight`
- `Eye_R_Lid`
- `Brow_L`
- `Brow_R`
- `Mouth_Default`
- `Mouth_Open`
- `Mouth_Smile`
- `Body_Base`
- `Arm_L`
- `Arm_R`
- `Hand_L`
- `Hand_R`
- `Leg_L`
- `Leg_R`
- `Tail`
- `Accessory_*`

推荐源文件格式：

- PSD：给 Cubism Editor 建模使用
- PNG：每层导出备份

### 3.2 Cubism Editor 项目

交付项目源文件：

- `Piko.cmo3`
- `Piko.can3`，如果动作以 Animation Workspace 制作

## 4. Cubism 参数要求

基础参数：

- `ParamAngleX`
- `ParamAngleY`
- `ParamAngleZ`
- `ParamEyeBallX`
- `ParamEyeBallY`
- `ParamEyeLOpen`
- `ParamEyeROpen`
- `ParamMouthOpenY`
- `ParamMouthForm`
- `ParamBodyAngleX`
- `ParamBodyAngleY`
- `ParamBodyAngleZ`
- `ParamBreath`

推荐附加参数：

- `ParamBrowLY`
- `ParamBrowRY`
- `ParamBrowLAngle`
- `ParamBrowRAngle`
- `ParamTail`
- `ParamEarL`
- `ParamEarR`
- `ParamAccessorySwing`

## 5. 物理要求

至少配置：

- 头发前发物理
- 头发后发物理
- 耳朵轻摆
- 尾巴轻摆
- 衣摆或挂件轻摆

导出：

- `Piko.physics3.json`

## 6. 动作要求

导出到 `motions/`：

- `idle_01.motion3.json`
- `idle_02.motion3.json`
- `greet_01.motion3.json`
- `thinking_01.motion3.json`
- `happy_01.motion3.json`
- `playful_01.motion3.json`
- `surprised_01.motion3.json`
- `worried_01.motion3.json`
- `sleepy_01.motion3.json`
- `celebrate_01.motion3.json`
- `tap_01.motion3.json`

动作分组建议：

- `Idle`
- `TapBody`
- `Greet`
- `Think`
- `Emotion`

## 7. 表情要求

导出到 `expressions/`：

- `exp_idle.exp3.json`
- `exp_happy.exp3.json`
- `exp_playful.exp3.json`
- `exp_curious.exp3.json`
- `exp_sleepy.exp3.json`
- `exp_surprised.exp3.json`
- `exp_worried.exp3.json`
- `exp_celebrate.exp3.json`

## 8. 运行时交付目录

最终放入：

```text
public/live2d/piko/
  Piko.model3.json
  Piko.moc3
  Piko.physics3.json
  Piko.pose3.json
  Piko.cdi3.json
  textures/
    texture_00.png
    texture_01.png
  motions/
    idle_01.motion3.json
    idle_02.motion3.json
    greet_01.motion3.json
    thinking_01.motion3.json
    happy_01.motion3.json
    playful_01.motion3.json
    surprised_01.motion3.json
    worried_01.motion3.json
    sleepy_01.motion3.json
    celebrate_01.motion3.json
    tap_01.motion3.json
  expressions/
    exp_idle.exp3.json
    exp_happy.exp3.json
    exp_playful.exp3.json
    exp_curious.exp3.json
    exp_sleepy.exp3.json
    exp_surprised.exp3.json
    exp_worried.exp3.json
    exp_celebrate.exp3.json
```

## 9. 应用接入

当前官方模型配置：

```text
public/live2d/profiles/official-mao.profile.json
```

当前官方模型入口：

```json
"/live2d/sample/Mao.model3.json"
```

`public/live2d/official.profile.json` 和 `public/live2d/piko.profile.json` 暂时保留为兼容文件，内容同样指向官方示例模型。

当前模型注册在前端：

```text
src/features/app/appShared.tsx
```

已内置可选模型：

- `official-mao`：已启用，资产在 `public/live2d/sample/`
- `official-epsilon`：预留，需从 Live2D 官方 Sample Data 下载后启用
- `official-miara`：预留，需从 Live2D 官方 Sample Data 下载后启用

新增官方模型时：

1. 从 Live2D Sample Data 页面下载对应模型，并确认许可条款。
2. 将 runtime 资源放入 `public/live2d/models/<model-id>/`。
3. 在 `public/live2d/profiles/<model-id>.profile.json` 中配置 `modelUrl / fit / motions / expressions`。
4. 在 `live2dModelOptions` 中将对应模型 `enabled` 改为 `true`。
5. 在面板的“Live2D 模型”下拉中选择该模型。

未来替换为真正 Piko Cubism 模型时，新增：

```text
public/live2d/piko/
  Piko.model3.json
  Piko.moc3
  Piko.physics3.json
  Piko.pose3.json
  Piko.cdi3.json
  textures/
  motions/
  expressions/
```

更新：

```text
public/live2d/official.profile.json
```

将 `modelUrl` 改为：

```json
"/live2d/piko/Piko.model3.json"
```

然后按模型导出的 motion group 和 expression name 更新：

- `motions`
- `idleMotions`
- `tapMotions`
- `expressions`
- `fit`

## 10. 验收标准

在 `http://127.0.0.1:5173/` 中：

- `.live2d-character-pet[data-live2d-status="ready"]`
- 不出现 `.live-character-pet` fallback
- 鼠标移动时头和眼睛跟随
- 30 秒内至少出现一次自然待机动作
- 点击 Piko 会触发 `tapMotions`
- 进入 thinking / happy / worried / celebrate 状态时动作和表情变化明显
- 不裁切头部、脚部、尾巴或关键装饰

## 11. 当前限制

当前仓库没有：

- Piko 的分层 PSD
- Piko 的 Cubism Editor 工程 `.cmo3`
- 可导出 `.moc3` 的 Cubism Editor 或命令行工具

因此当前项目无法在本地直接生成真正的 Piko `.moc3`。可完成的是运行层、配置层和交付目录规范；模型制作与导出需要 Cubism Editor。
