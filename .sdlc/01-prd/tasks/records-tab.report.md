# R1-3 · 新建「记录」Tab — 交付报告

> 执行者：worker（records-tab） · 任务卡：`.sdlc/01-prd/tasks/records-tab.md`
> 模块文档：`04-模块-记录与记忆.md`
> 完成时间：2026-09-23

## 1. 改动文件列表

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/features/panel/tabs/RecordsTab.tsx` | **新建（重写）** | 记录入口 + 统一搜索 + 三分区切换 |
| `src/features/panel/tabs/records.css` | **新建（重写）** | 全部新增样式，`records-` 前缀，含 `PanelHistory` 需要的部分 |
| `src/features/panel/PanelHistory.tsx` | **修改** | 删掉 6 个过滤标签与 `focusMinutes`，改搜索 + 时间筛选 |
| `src/features/panel/recordsSearch.ts` | **新建** | 纯函数：三处搜索的匹配字段、时间分桶、摘要截断 |
| `src/features/panel/recordsSearch.test.ts` | **新建** | 15 条断言，锁住「各自匹配哪些字段」 |
| `src/features/panel/previewData.ts` | **修改（追加）** | 新增 `previewMemos()` / `previewChatHistory()`，仅预览用 |
| `tests/e2e/records-smoke.spec.ts` | **新建** | 4 条冒烟，见 §6 |

**未触碰**（按任务卡要求）：`PanelWindow.tsx`、`tabs/SettingsTab.tsx`、
`tabs/TodayTab.tsx`、`App.css`、`appShared.tsx`。

`MemoryCenter.tsx` 只读复用，未改动一行。

### 一处需要 coordinator 决策的遗留

`src/App.css` 里仍残留 7 处 `.memo-summary-grid` 样式规则（2043-2081、2300）。
**所有 .tsx/.ts 里的引用已经清零**（`grep -rn "memo-summary-grid" src --include=*.tsx --include=*.ts` 无输出），
这些 CSS 现在是死代码。因为 `App.css` 在「不要碰」清单里，**我没有删**——
建议 coordinator 在自己那批改动里顺手清掉：

```css
/* App.css:2043-2081 整块 .memo-summary-grid 规则 */
/* App.css:2300 响应式块里的 .memo-summary-grid { grid-template-columns: 1fr; } */
```

## 2. 验收命令真实输出

```
$ npx tsc --noEmit
[exit=0]                     ← 零输出，全仓库（含 coordinator 的文件）都干净

$ npm run lint
✖ 72 problems (0 errors, 72 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.

$ npm test
 RUN  v4.1.7 /Volumes/W_W/claude-workspace/im-robot
 Test Files  15 passed (15)
      Tests  147 passed (147)
   Duration  281ms (transform 476ms, setup 0ms, import 690ms, tests 48ms, environment 1ms)

$ npm run build
dist/assets/vendor-react-C2n9gw-S.js   202.17 kB │ gzip:  64.67 kB
dist/assets/vendor-markdown-DcMYl8NQ.js 390.28 kB │ gzip: 114.84 kB
✓ built in 151ms

$ grep -rn "memo-summary-grid" src
src/App.css:2043  ← 仅剩 CSS 死代码，见 §1
...               ← 详见 §1，.tsx/.ts 引用为 0

$ grep -rn "ChatHistoryFilter" src
[exit=1]          ← 无输出 ✅
```

`npm run test:e2e` 按要求未跑（coordinator 统一跑）。但我另写了
`tests/e2e/records-smoke.spec.ts` 并单独跑通，见 §6。

## 3. `PanelHistory` 改动后的 props 签名

```tsx
export interface PanelHistoryProps {
  chatHistory: ChatHistoryEntry[];
  onClear: () => Promise<void>;
}

export function PanelHistory({ chatHistory, onClear }: PanelHistoryProps): JSX.Element
```

**coordinator 接线要点：**

- **`focusMinutes` 已从 props 中删除**，旧的
  `<PanelHistory chatHistory={…} focusMinutes={focusState.todayMinutes} onClear={clearChatHistory} />`
  〔PanelWindow.tsx:1629 @ HEAD〕必须改成只传两个 prop。
- `onClear` 的**签名没变**，仍是 `() => Promise<void>`，语义仍是「清除历史」。
- `PanelHistory` 现在**自己不调用 `clear_chat_history`**，只触发回调 ——
  命令与刷新都由调用方持有。在 `RecordsTab` 里接线如下：

  ```tsx
  async function clearChatHistory() {
    try {
      await runCommand("clear_chat_history");
      await loadChatHistory();
      toast.success("对话历史已清除");
    } catch (error) {
      toast.error(toUserMessage(error, "清除失败，请重试。"));
    }
  }
  <PanelHistory chatHistory={chatHistory} onClear={clearChatHistory} />
  ```

- 仍导出 `formatChatHistoryTime`（`SettingsTab.tsx` 有引用）。
- 若 SettingsTab 不再需要 `PanelHistory`，那里 line 1 的 import 可以去掉。

## 4. 三处搜索的匹配规则

顶部**一个**搜索框，防抖 300ms，同时过滤三处；结果分组、各组标注来源、
每组最多 8 条（`SEARCH_RESULT_LIMIT`）。匹配一律为**大小写不敏感的包含匹配**。

| 来源 | 参与匹配的字段 | 明确不参与 |
| --- | --- | --- |
| **我的记录**（memos） | `title` + `summary` + `content` + `tags[]` | — |
| **Piko 记住的**（memories） | `title` + `content` + `tags[]` | `memoryType`、`confidence`、`source` 枚举、`embeddingId`、`privacyLevel` |
| **对话历史**（chat history） | `prompt` + `response` | — |

实现在 `src/features/panel/recordsSearch.ts`：

```ts
memoSearchFields(memo)   = [title, summary, content, tags.join(" ")].join("\n")
memorySearchFields(mem)  = [title, content, tags.join(" ")].join("\n")
chatSearchFields(entry)  = [prompt, response].join("\n")
containsKeyword(haystack, keyword)  // 空关键词返回 false，不退化成「全部命中」
```

两个刻意的设计：

1. **技术字段不参与检索**。`memorySearchFields` 不含 `memoryType` / `source` /
   `confidence`，所以搜「profile」「conversation」「0.9」都不会命中——
   04 §2/§10 要求这些词不出现在用户面前，检索入口一并堵住。有单测锁住。
2. **`containsKeyword` 对空关键词返回 `false`**。调用方只在真的有关键词时才
   调它，这样「忘记判空」不会静默退化成「全部命中」。

空结果文案：`没有找到关于「xxx」的内容。` + `要不要现在记一笔？`（04 §4）。

## 5. 没做 / 做不了的事

按任务卡范围，以下**未做**，留给后续任务卡：

| 项 | 04 章节 | 原因 |
| --- | --- | --- |
| 「Piko 可以记住的事」开关 | §7 | 需要后端策略接口，任务卡未列 |
| 清空 Piko 记住的 / 导出全部记录（文件） | §7、§11 | `MemoryCenter` 是只读复用，不能改 |
| `MemoryCenter` 三子 Tab 合并、术语去技术化 | §3.3、§11 | 任务卡明确要求**不要改** MemoryCenter |
| 对话历史按**会话**（ChatSession）分组、可「继续对话」 | §3.4 | 后端目前是 `ChatHistoryEntry`（单条问答对），没有 session 模型；仍是「一轮 = 一条」 |
| 置顶（pinned） | §3.2、§3.3 | `Memo` 类型无 `pinned` 字段，需后端先行 |
| 每日自动回顾 | §3.3、§5.1 | 依赖后端定时生成 |
| `export_memories` 改为导出文件 | §11 | 在 MemoryCenter 里，不可改 |
| 语义搜索 | §4 | 明确写了「未来可加」 |

### 需要说明的两处取舍

1. **分类下拉目前是「期望分类」**。`create_memo` 的后端 `MemoInput` 只有
   `title` / `content`，分类仍由 `infer_memo_category` 推断。我把 `category`
   一并传了（后端忽略），**界面上的分类选择暂不生效**——要真正生效需要改
   `MemoInput` 认领该字段，属于后端改动，不在这个任务卡里。
2. **预览（非 Tauri）下写入是本地 state**。`runCommand` 的 fallback 不会落盘，
   为避免「保存后列表没变化」看起来像坏了，预览下写进本地列表且只播种一次
   演示数据（见 `loadMemos` 里的注释）。真实运行时走正常 `create_memo` + reload。

## 6. 附加：我跑了冒烟测试

任务卡说 e2e 由 coordinator 统一跑，但「预览环境下 undefined 崩掉」这类问题
tsc 查不出来（`?view=panel` 预览没有 Rust 后端，全靠 fallback）。所以我写了
`tests/e2e/records-smoke.spec.ts` 单独验证，**4 条全绿**：

```
✓ records tab › renders the entry form, the three sections and preview records
✓ records tab › switches to Piko 记住的 and 对话历史 without crashing
✓ records tab › one search box finds content across all three sources
✓ records tab › can write a new record from the entry form
```

覆盖：记录入口三个控件、三个分区（不是两个）、演示数据渲染出卡片、
`<MemoryCenter />` 内嵌不崩、对话历史搜索框 + 四个时间桶、旧的「长回复 /
截图」标签确认消失、跨三区搜索分组（实测「搬家」同时命中我的记录 + 对话历史，
分组标题为 `['我的记录', '对话历史']`）、空结果引导文案、保存后列表刷新且
输入框清空。同时断言了零 pageerror / 零 4xx。

这条 spec 用的是仓库现有的 `playwright.config.ts`（baseURL 4173 + `npm run preview`），
**可以直接并入 `npm run test:e2e`**。注意它会往 `dist` 上跑，所以要在 `npm run build`
之后执行。
