import type { RefObject } from "react";
import { ChevronDown, FolderOpen, Star, X } from "lucide-react";
import type { HtmlFavorite } from "./htmlFavorites";

type Props = {
  cwd: string;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onChoose: () => void;
  favoritesOpen: boolean;
  onToggleFavorites: () => void;
  favoritesButtonRef: RefObject<HTMLButtonElement | null>;
  favorites: HtmlFavorite[];
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
};
export function ChatContextMenu({
  cwd,
  disabled,
  open,
  onToggle,
  onChoose,
  favoritesOpen,
  onToggleFavorites,
  favoritesButtonRef,
  favorites,
  onSelect,
  onRemove,
}: Props) {
  const directory = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  return (
    <>
      <div className="bubble-context-bar">
        <button
          type="button"
          className="bubble-context-toggle"
          data-testid="chat-context-toggle"
          aria-expanded={open}
          aria-controls="bubble-context-options"
          onClick={onToggle}
        >
          <FolderOpen size={13} />
          <span>{directory || "工作空间与收藏"}</span>
          <ChevronDown size={12} />
        </button>
        <span className="bubble-input-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      <div
        id="bubble-context-options"
        className="chat-workspace"
        aria-label="对话上下文"
        hidden={!open}
      >
        <button
          type="button"
          data-testid="workspace-directory"
          className="chat-workspace__directory"
          title={cwd || "需要操作本地文件时再选择文件夹"}
          disabled={disabled}
          onClick={onChoose}
        >
          <FolderOpen size={13} /> {directory || "选择工作目录（可选）"}
        </button>
        <button
          ref={favoritesButtonRef}
          type="button"
          className="chat-workspace__directory"
          title="收藏的 HTML 卡片"
          onClick={onToggleFavorites}
          aria-expanded={favoritesOpen}
        >
          <Star size={13} /> 收藏卡片
          {favorites.length ? ` · ${favorites.length}` : ""}
        </button>
      </div>
      {open && favoritesOpen && (
        <div className="bubble-favorites" aria-label="收藏的 HTML 卡片">
          {favorites.length === 0 ? (
            <p>还没有收藏，在任意 HTML 卡片头部点 ★ 即可收藏</p>
          ) : (
            favorites.map((favorite) => (
              <div key={favorite.id} className="bubble-favorites__item">
                <button
                  type="button"
                  className="bubble-favorites__title"
                  title={favorite.html}
                  onClick={() => onSelect(favorite.id)}
                >
                  {favorite.title}
                </button>
                <span className="bubble-favorites__actions">
                  <button
                    type="button"
                    title="删除"
                    onClick={() => onRemove(favorite.id)}
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
