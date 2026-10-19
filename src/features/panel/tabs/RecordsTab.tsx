import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { MoreHorizontal, NotebookPen, Plus } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type {
  ChatHistoryEntry,
  Memo,
  MemoCategory,
} from "../../../types/appTypes";
import type { MemoryItem } from "../../memory/memoryTypes";
import { EmptyState, ErrorState } from "../../../components/feedback/States";
import { useToast } from "../../../components/feedback/toastStore";
import { toUserMessage } from "../../../lib/errors";
import { MemoryCenter } from "../../memory/MemoryCenter";
import { isTauriRuntime, runCommand } from "../../app/appRuntime";
import { nowSeconds } from "../time";
import { PanelHistory, formatChatHistoryTime } from "../PanelHistory";
import { previewChatHistory, previewMemos } from "../previewData";
import {
  RECORD_SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  chatSearchFields,
  containsKeyword,
  memorySearchFields,
  memoSearchFields,
  summarizeText,
} from "../recordsSearch";
import "./records.css";

/** 分区：我的记录 / Piko 记住的 / 对话历史。 */
type RecordsSection = "mine" | "memory" | "chat";

/** 分类下拉：保存时的期望分类（列表筛选用 chip，所以这里不含「全部」）。 */
const memoCategoryOptions: Array<{ label: string; value: MemoCategory }> = [
  { label: "任务", value: "task" },
  { label: "想法", value: "idea" },
  { label: "学习", value: "learning" },
  { label: "工作", value: "work" },
  { label: "生活", value: "life" },
  { label: "资料", value: "reference" },
  { label: "其他", value: "other" },
];

const memoCategoryDraftOptions: Array<{
  label: string;
  value: MemoCategory | "";
}> = [{ label: "自动分类", value: "" }, ...memoCategoryOptions];

const memoCategoryLabels: Record<MemoCategory, string> = {
  task: "任务",
  idea: "想法",
  learning: "学习",
  work: "工作",
  life: "生活",
  reference: "资料",
  other: "其他",
};

const sectionLabels: Record<RecordsSection, string> = {
  mine: "我的记录",
  memory: "Piko 记住的",
  chat: "对话历史",
};

/**
 * 「记录」Tab（04 模块）。
 *
 * 心智：我写下的和 Piko 记住的，都在这里，都能搜到。
 *
 * 三处内容各自加载、各自持有错误状态：一处读失败不该让另外两区跟着变成
 * 「没有内容」。顶部一个搜索框同时过滤三处，结果分组并标注来源。
 */
export function RecordsTab() {
  const [composerOpen, setComposerOpen] = useState(false);
  const toast = useToast();
  const memoFormRef = useRef<HTMLFormElement>(null);
  const [section, setSection] = useState<RecordsSection>("mine");

  // --- 我的记录 ---
  const [memos, setMemos] = useState<Memo[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<MemoCategory | "all">(
    "all",
  );
  const [editingMemoId, setEditingMemoId] = useState("");
  const [memosError, setMemosError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // --- Piko 记住的：只读一份供搜索，渲染交给 MemoryCenter（R0-6 已验收） ---
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoriesError, setMemoriesError] = useState("");

  // --- 对话历史 ---
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [chatError, setChatError] = useState("");

  // --- 记录入口 ---
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftCategory, setDraftCategory] = useState<MemoCategory | "">("");

  // --- 搜索 ---
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");

  /**
   * 预览（非 Tauri）下的第一个坑：这里如果无条件用演示数据覆盖 state，
   * 用户刚写的那条会在下一次 loadMemos 时被抹掉，看起来像「保存没生效」。
   * 所以只在列表为空时播种一次，之后以本地 state 为准。
   */
  const loadMemos = useCallback(async () => {
    try {
      const items = await runCommand<Memo[]>(
        "list_memos",
        undefined,
        undefined,
      );
      setMemos((current) => {
        if (isTauriRuntime || items?.length) return items ?? [];
        return current.length ? current : previewMemos();
      });
      setMemosError("");
    } catch (error) {
      setMemosError(toUserMessage(error, "记录加载失败，请重试。"));
    }
  }, []);

  const loadMemories = useCallback(async () => {
    try {
      const items = await runCommand<MemoryItem[]>(
        "list_memories",
        { input: { status: "active", limit: 100 } },
        [],
      );
      setMemories(items ?? []);
      setMemoriesError("");
    } catch (error) {
      setMemoriesError(
        toUserMessage(error, "Piko 记住的内容加载失败，请重试。"),
      );
    }
  }, []);

  const loadChatHistory = useCallback(async () => {
    try {
      const items = await runCommand<ChatHistoryEntry[]>(
        "list_chat_history",
        undefined,
        isTauriRuntime ? undefined : previewChatHistory(),
      );
      setChatHistory(items ?? []);
      setChatError("");
    } catch (error) {
      setChatError(toUserMessage(error, "对话历史加载失败，请重试。"));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      await Promise.all([loadMemos(), loadMemories(), loadChatHistory()]);
      if (!disposed) setIsLoading(false);
    })();
    const pending = isTauriRuntime
      ? listen("memos-updated", () => void loadMemos())
      : undefined;
    return () => {
      disposed = true;
      if (pending)
        void pending.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [loadChatHistory, loadMemories, loadMemos]);

  // 防抖 300ms：记忆侧是 FTS5 查询，逐字符敲会打出一串没人看的请求。
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedKeyword(keyword.trim()),
      RECORD_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const visibleMemos = useMemo(() => {
    const sorted = [...memos].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const byCategory =
      categoryFilter === "all"
        ? sorted
        : sorted.filter((memo) => memo.category === categoryFilter);
    if (!debouncedKeyword) return byCategory;
    return byCategory.filter((memo) =>
      containsKeyword(memoSearchFields(memo), debouncedKeyword),
    );
  }, [categoryFilter, debouncedKeyword, memos]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<MemoCategory, number>();
    for (const memo of memos)
      counts.set(memo.category, (counts.get(memo.category) ?? 0) + 1);
    return counts;
  }, [memos]);

  /** 统一搜索：三处内容各取前 N 条，分组并标注来源。 */
  const searchResults = useMemo(() => {
    if (!debouncedKeyword) return null;
    return {
      mine: memos
        .filter((memo) =>
          containsKeyword(memoSearchFields(memo), debouncedKeyword),
        )
        .slice(0, SEARCH_RESULT_LIMIT),
      memory: memories
        .filter((memory) =>
          containsKeyword(memorySearchFields(memory), debouncedKeyword),
        )
        .slice(0, SEARCH_RESULT_LIMIT),
      chat: chatHistory
        .filter((entry) =>
          containsKeyword(chatSearchFields(entry), debouncedKeyword),
        )
        .slice(0, SEARCH_RESULT_LIMIT),
    };
  }, [chatHistory, debouncedKeyword, memos, memories]);

  const hasSearchResults =
    searchResults !== null &&
    searchResults.mine.length +
      searchResults.memory.length +
      searchResults.chat.length >
      0;

  async function saveMemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 标题允许留空：取正文第一行（04 §3.2「标题可为首行」）。
    const title =
      draftTitle.trim() || draftContent.trim().split("\n")[0].trim();
    const content = draftContent.trim();
    if (!title || !content) {
      toast.error("先写点内容，标题可以留空（会取第一行）");
      return;
    }

    setIsSaving(true);
    const wasEditing = Boolean(editingMemoId);
    try {
      if (isTauriRuntime) {
        const args = {
          input: { title, content, category: draftCategory || undefined },
        };
        if (wasEditing) {
          await runCommand("update_memo", { id: editingMemoId, ...args });
        } else {
          // category 是可选显式分类：传了就按它存，没传才由后端推断（04 §5.2）。
          await runCommand("create_memo", args);
        }
      } else {
        // 预览没有后端：写进本地列表，否则「保存后列表没变化」看起来像坏了。
        const now = nowSeconds();
        const saved: Memo = {
          id: editingMemoId || `preview-memo-${now}`,
          title,
          content,
          category: draftCategory || "other",
          summary: summarizeText(content),
          tags: [memoCategoryLabels[draftCategory || "other"]],
          createdAt: now,
          updatedAt: now,
        };
        setMemos((current) => {
          const next = wasEditing
            ? current.map((item) =>
                item.id === saved.id
                  ? { ...saved, createdAt: item.createdAt }
                  : item,
              )
            : [saved, ...current];
          return next.sort((left, right) => right.updatedAt - left.updatedAt);
        });
      }
      setDraftTitle("");
      setDraftContent("");
      setEditingMemoId("");
      if (isTauriRuntime) await loadMemos();
      toast.success(wasEditing ? "已更新" : "记下来了");
    } catch (error) {
      toast.error(toUserMessage(error, "保存失败，请重试。"));
    } finally {
      setIsSaving(false);
    }
  }

  function editMemo(memo: Memo) {
    setComposerOpen(true);
    setEditingMemoId(memo.id);
    setDraftTitle(memo.title);
    setDraftContent(memo.content);
    setDraftCategory(memo.category);
    setSection("mine");
    memoFormRef.current?.scrollIntoView({ block: "nearest" });
  }

  function cancelMemoEdit() {
    setEditingMemoId("");
    setDraftTitle("");
    setDraftContent("");
  }

  async function deleteMemo(memo: Memo) {
    try {
      await runCommand("delete_memo", { id: memo.id });
      if (!isTauriRuntime) {
        setMemos((current) => current.filter((item) => item.id !== memo.id));
      }
      if (editingMemoId === memo.id) cancelMemoEdit();
      if (isTauriRuntime) await loadMemos();
      toast.success("已删除");
    } catch (error) {
      toast.error(toUserMessage(error, "删除失败，请重试。"));
    }
  }

  async function clearChatHistory() {
    try {
      await runCommand("clear_chat_history");
      await loadChatHistory();
      toast.success("对话历史已清除");
    } catch (error) {
      toast.error(toUserMessage(error, "清除失败，请重试。"));
    }
  }

  return (
    <div className="tab tab--records">
      {section !== "memory" && (
        <section className="records-search" aria-label="搜索记录">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.currentTarget.value)}
            placeholder="搜索我的记录、Piko 记住的、对话历史…"
            aria-label="搜索记录"
          />
          {keyword ? (
            <button type="button" onClick={() => setKeyword("")}>
              清空
            </button>
          ) : null}
        </section>
      )}

      {debouncedKeyword ? (
        <section className="records-results" aria-label="搜索结果">
          {hasSearchResults && searchResults ? (
            <>
              <SearchGroup
                title={sectionLabels.mine}
                count={searchResults.mine.length}
                error={memosError}
                onOpen={() => {
                  setSection("mine");
                  setCategoryFilter("all");
                }}
              >
                {searchResults.mine.map((memo) => (
                  <ResultRow
                    key={memo.id}
                    title={memo.title}
                    text={memo.summary || memo.content}
                  />
                ))}
              </SearchGroup>
              <SearchGroup
                title={sectionLabels.memory}
                count={searchResults.memory.length}
                error={memoriesError}
                onOpen={() => {
                  setKeyword("");
                  setSection("memory");
                }}
              >
                {searchResults.memory.map((memory) => (
                  <ResultRow
                    key={memory.id}
                    title={memory.title}
                    text={memory.content}
                  />
                ))}
              </SearchGroup>
              <SearchGroup
                title={sectionLabels.chat}
                count={searchResults.chat.length}
                error={chatError}
                onOpen={() => setSection("chat")}
              >
                {searchResults.chat.map((entry) => (
                  <ResultRow
                    key={entry.id}
                    title={entry.prompt}
                    text={entry.response}
                  />
                ))}
              </SearchGroup>
            </>
          ) : (
            <EmptyState
              icon={<NotebookPen size={20} />}
              title={`没有找到关于「${debouncedKeyword}」的内容。`}
              description="要不要现在记一笔？"
            />
          )}
        </section>
      ) : (
        <>
          <nav
            className="segmented-control records-sections"
            aria-label="记录分区"
          >
            <button
              type="button"
              aria-current={section === "mine" ? "page" : undefined}
              className={section === "mine" ? "is-active" : ""}
              onClick={() => setSection("mine")}
            >
              我的记录
            </button>
            <button
              type="button"
              aria-current={section === "memory" ? "page" : undefined}
              className={section === "memory" ? "is-active" : ""}
              onClick={() => setSection("memory")}
            >
              Piko 记住的
            </button>
            <button
              type="button"
              aria-current={section === "chat" ? "page" : undefined}
              className={section === "chat" ? "is-active" : ""}
              onClick={() => setSection("chat")}
            >
              对话历史
            </button>
          </nav>
          {section === "mine" && (
            <details
              className="records-entry records-composer"
              open={composerOpen || Boolean(editingMemoId)}
              onToggle={(event) => setComposerOpen(event.currentTarget.open)}
            >
              <summary>
                <Plus size={15} />
                {editingMemoId ? "编辑记录" : "记一笔"}
                <span>随手记录想法</span>
              </summary>
              <form ref={memoFormRef} onSubmit={saveMemo}>
                {editingMemoId ? (
                  <p className="records-entry__hint">
                    正在编辑一条记录，保存后生效。
                  </p>
                ) : null}
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.currentTarget.value)}
                  maxLength={120}
                  placeholder="标题（留空则取第一行）"
                  aria-label="记录标题"
                />
                <textarea
                  value={draftContent}
                  onChange={(event) =>
                    setDraftContent(event.currentTarget.value)
                  }
                  maxLength={8000}
                  rows={3}
                  placeholder="记一笔…想到什么就写下来。"
                  aria-label="记录内容"
                />
                <div className="records-entry__actions">
                  <label className="records-entry__category">
                    <span className="sr-only">分类</span>
                    <select
                      value={draftCategory}
                      onChange={(event) =>
                        setDraftCategory(
                          event.currentTarget.value as MemoCategory | "",
                        )
                      }
                      aria-label="记录分类"
                    >
                      {memoCategoryDraftOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {editingMemoId ? (
                    <button
                      type="button"
                      className="text-action"
                      onClick={cancelMemoEdit}
                    >
                      取消编辑
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    className="primary-action"
                    disabled={isSaving || !draftContent.trim()}
                  >
                    <Plus size={15} />
                    {isSaving
                      ? "保存中…"
                      : editingMemoId
                        ? "保存修改"
                        : "记一笔"}
                  </button>
                </div>
              </form>
            </details>
          )}

          {section === "mine" ? (
            <section aria-label="我的记录">
              <div className="records-chips" aria-label="按分类筛选">
                <button
                  type="button"
                  className={categoryFilter === "all" ? "is-active" : ""}
                  onClick={() => setCategoryFilter("all")}
                >
                  全部 <span>{memos.length}</span>
                </button>
                {memoCategoryOptions
                  .filter((option) => categoryCounts.has(option.value))
                  .map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={
                        categoryFilter === option.value ? "is-active" : ""
                      }
                      onClick={() => setCategoryFilter(option.value)}
                    >
                      {option.label}{" "}
                      <span>{categoryCounts.get(option.value) ?? 0}</span>
                    </button>
                  ))}
              </div>

              {memosError ? (
                <ErrorState
                  message={memosError}
                  onRetry={() => void loadMemos()}
                  onDismiss={() => setMemosError("")}
                />
              ) : isLoading ? (
                <div className="records-skeleton" aria-label="正在读取记录">
                  <span />
                  <span />
                  <span />
                </div>
              ) : visibleMemos.length === 0 ? (
                <EmptyState
                  icon={<NotebookPen size={20} />}
                  title={
                    memos.length
                      ? "这个分类下还没有记录。"
                      : "还没有记录。写下第一个想法吧。"
                  }
                />
              ) : (
                <ul className="records-list">
                  {visibleMemos.map((memo) => (
                    <li
                      key={memo.id}
                      className="records-card"
                      data-testid="record-card"
                    >
                      <div className="records-card__head">
                        <strong>{memo.title}</strong>
                        <details
                          className="records-card__menu"
                          onBlur={(event) => {
                            if (
                              !event.currentTarget.contains(
                                event.relatedTarget as Node | null,
                              )
                            )
                              event.currentTarget.open = false;
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.currentTarget.open = false;
                              event.currentTarget
                                .querySelector("summary")
                                ?.focus();
                            }
                          }}
                        >
                          <summary aria-label={`更多操作：${memo.title}`}>
                            <MoreHorizontal size={18} aria-hidden="true" />
                          </summary>
                          <div className="records-card__menu-items">
                            <button
                              type="button"
                              className="text-action"
                              onClick={(event) => {
                                event.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                editMemo(memo);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="text-action"
                              onClick={(event) => {
                                event.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                void deleteMemo(memo);
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </details>
                        <span className="records-chip records-chip--category">
                          {memoCategoryLabels[memo.category] ?? "其他"}
                        </span>
                      </div>
                      <p>{summarizeText(memo.summary || memo.content)}</p>
                      <div className="records-card__meta">
                        <time>{formatChatHistoryTime(memo.updatedAt)}</time>
                        {memo.tags
                          .filter(
                            (tag) => tag !== memoCategoryLabels[memo.category],
                          )
                          .slice(0, 2)
                          .map((tag) => (
                            <span key={tag} className="records-chip">
                              {tag}
                            </span>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {section === "memory" ? <MemoryCenter /> : null}

          {section === "chat" ? (
            chatError ? (
              <ErrorState
                message={chatError}
                onRetry={() => void loadChatHistory()}
                onDismiss={() => setChatError("")}
              />
            ) : (
              <PanelHistory
                chatHistory={chatHistory}
                onClear={clearChatHistory}
              />
            )
          ) : null}
        </>
      )}
    </div>
  );
}

/** 搜索结果的一组：来源 + 条数 + 「查看全部」跳到对应分区。 */
function SearchGroup({
  title,
  count,
  error,
  onOpen,
  children,
}: {
  title: string;
  count: number;
  /** 该来源读取失败时内联报错，而不是假装「没有结果」。 */
  error: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  if (error) return <ErrorState message={error} />;
  if (count === 0) return null;
  return (
    <div className="records-group">
      <div className="records-group__head">
        <h3>{title}</h3>
        <span>{count} 条</span>
        <button type="button" className="text-action" onClick={onOpen}>
          查看全部
        </button>
      </div>
      <ul className="records-group__list">{children}</ul>
    </div>
  );
}

function ResultRow({ title, text }: { title: string; text: string }) {
  return (
    <li className="records-result">
      <strong>{summarizeText(title, 60) || "未命名"}</strong>
      <span>{summarizeText(text)}</span>
    </li>
  );
}
