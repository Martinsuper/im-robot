# 任务卡 · R1-3 新建「记录」Tab

> 由 coordinator 派发给 worker。执行前请完整阅读本文件与 `04-模块-记录与记忆.md`。

## 目标

把现状里割裂的 **备忘 / AI 记忆 / 对话历史** 合并成一个界面：**记录**。
心智：**「我写下的」和「Piko 记住的」，都在这里，都能搜到。**

## 要创建 / 修改的文件

| 文件 | 动作 |
| --- | --- |
| `src/features/panel/tabs/RecordsTab.tsx` | **新建**（这是你的主战场） |
| `src/features/panel/tabs/records.css` | **新建**（你新增的样式只写在这里） |
| `src/features/panel/PanelHistory.tsx` | 修改：去掉 6 个过滤标签，改搜索 + 时间筛选 |
| `src/features/memory/MemoryCenter.tsx` | **只读复用**，不要改（R0-6 刚验收过） |

**不要碰**：`src/features/panel/PanelWindow.tsx`、`tabs/SettingsTab.tsx`、
`tabs/TodayTab.tsx`、`App.css`、`src/features/app/appShared.tsx`。
coordinator 正在同时改这些文件。

## 组件契约

```tsx
export function RecordsTab(): JSX.Element   // 不接受任何 props，自带数据加载
```

数据从 `runCommand` 拿（见 `src/features/app/appRuntime.ts`），
**必须为非 Tauri 预览环境传 fallback**，否则 `?view=panel` 预览会因 undefined 崩掉。
示例：

```ts
const items = await runCommand<Memo[]>("list_memos", undefined, []);
```

## 界面结构（04 §3）

```text
记录 Records
├─ 顶部：记录入口（「记一笔…」多行输入 + 分类 + 保存）
├─ 搜索框（跨全部内容，防抖 300ms）
├─ 分区切换： [ 我的记录 ] [ Piko 记住的 ] [ 对话历史 ]
└─ 列表 / 卡片
```

### 1. 记录入口

- 多行输入 + 分类下拉（任务 / 想法 / 学习 / 工作 / 生活 / 资料 / 其他）+ 保存。
- 保存后调用现有的 `create_memo` 命令（参考 `git show HEAD:src/features/panel/PanelWindow.tsx`
  里的 `saveMemo`（约 635-700 行）与 `memoCategoryOptions`（约 85-95 行）——
  照搬那套字段与调用方式，不要自己发明命令名）。
- 保存成功后清空输入并刷新列表。

### 2. 我的记录（memos）

- 列表按更新时间倒序；分类 chip 筛选（**移除现状的 `memo-summary-grid` 分类宫格**）。
- 支持编辑、删除（参考 HEAD 里的 `editMemo` / `cancelMemoEdit` / `deleteMemo`）。
- 每张卡片：标题 + 摘要 + 时间 + 分类 chip。

### 3. Piko 记住的

- 直接渲染 `<MemoryCenter />`（`src/features/memory/MemoryCenter.tsx`），
  它已经自带列表 / 待确认 / 反思总结三个子视图与 ErrorState/EmptyState。
- **不要**再包一层术语（反思、置信度、embedding 等词一律不出现在你写的文案里）。

### 4. 对话历史

- 修改 `PanelHistory.tsx`：删掉 `ChatHistoryFilter` 那 6 个标签及其 UI，
  改为「搜索框 + 时间筛选（今天 / 本周 / 更早 / 全部）」。
- `PanelHistory` 目前接收 `onClear`，保留该能力（清除历史），但**不要再传 `focusMinutes`** ——
  今日专注已经搬到「今天」Tab 了。请把 `focusMinutes` 相关渲染（`focus-summary` 那块）删掉。
- 调用方要改的签名请在这里写清楚，coordinator 的 shell 会照它接线。

## 统一搜索（04 §4）

- 一个搜索框同时过滤三处内容；结果按来源分组并标注来源（我的记录 / Piko 记住的 / 对话历史）。
- 空结果文案：`没有找到关于「xxx」的内容。要不要现在记一笔？`

## 必须遵守的规范

- 空状态一律用 `<EmptyState>`，错误一律用 `<ErrorState>` 或 `useToast().error()`，
  **禁止**再引入新的错误样式 class。文案见 04 §9：
  - 我的记录空态：`还没有记录。写下第一个想法吧。`
  - Piko 记住的空态：`Piko 还在慢慢认识你。`
  - 对话历史空态：`还没有聊过天。`
- 加载中给骨架或文案，不要空白。
- 所有新增样式写进 `records.css`，用 `records-` 前缀，并在文件顶部 `import "./records.css";`。
- 不要引入新的 npm 依赖。

## Observable acceptance（必须贴出真实输出）

```bash
npx tsc --noEmit          # 期望对你负责的文件无输出
npm run lint              # 期望 0 errors
npm test                  # 期望全过
npm run build             # 期望通过
grep -rn "memo-summary-grid" src        # 期望无输出
grep -rn "ChatHistoryFilter" src        # 期望无输出（过滤标签已移除）
```

不要运行 `npm run test:e2e`（coordinator 统一跑）。

## 交付格式

**把结果写入 `.sdlc/01-prd/tasks/records-tab.report.md`**：

1. 改动文件列表。
2. 上面验收命令的真实输出。
3. `PanelHistory` 改动后的 props 签名（coordinator 要按它接线）。
4. 三处搜索的匹配规则（分别匹配哪些字段）。
5. 没做/做不了的事。
