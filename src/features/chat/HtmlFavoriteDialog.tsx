import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { HtmlPreviewFrame } from "./HtmlPreviewFrame";
import type { HtmlFavorite } from "./htmlFavorites";

export function HtmlFavoriteDialog({ favorite, onClose, onToggleFavorite, returnFocusRef }: {
  favorite: HtmlFavorite;
  onClose: () => void;
  onToggleFavorite: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocusTo = returnFocusRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      returnFocusTo?.focus();
    };
  }, [returnFocusRef]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="html-favorite-dialog"
      aria-label="收藏卡片预览"
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onPointerDown={(event) => { backdropPointer.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        if (backdropPointer.current && event.target === event.currentTarget) onClose();
        backdropPointer.current = false;
      }}
    >
      <div className="html-favorite-dialog__content">
        <header className="html-favorite-dialog__header">
          <h2>{favorite.title}</h2>
          <button type="button" autoFocus aria-label="关闭收藏预览" onClick={onClose}><X size={18} /></button>
        </header>
        <HtmlPreviewFrame key={favorite.id} source={favorite.html} isFavorited onToggleFavorite={onToggleFavorite} onEscape={onClose} />
      </div>
    </dialog>,
    document.body,
  );
}
