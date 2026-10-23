import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";

export interface HtmlFavorite {
  id: string;
  title: string;
  html: string;
  sourceChatId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export function normalizeFavoriteHtml(html: string) {
  return html.trim();
}

export function findFavoriteId(favorites: HtmlFavorite[], html: string) {
  const normalized = normalizeFavoriteHtml(html);
  return favorites.find((item) => normalizeFavoriteHtml(item.html) === normalized)?.id;
}

export function useHtmlFavorites() {
  const [favorites, setFavorites] = useState<HtmlFavorite[]>([]);

  const refresh = useCallback(async () => {
    const items = await runCommand("list_html_favorites", undefined, []);
    setFavorites(items ?? []);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const toggle = useCallback(async (html: string, sourceChatId?: string) => {
    const normalized = normalizeFavoriteHtml(html);
    if (!normalized) return;
    if (!isTauriRuntime) return;
    const existing = findFavoriteId(favorites, normalized);
    if (existing) {
      await runCommand("delete_html_favorite", { id: existing });
    } else {
      await runCommand("create_html_favorite", { input: { html: normalized, sourceChatId: sourceChatId ?? null } });
    }
    await refresh();
  }, [favorites, refresh]);

  const remove = useCallback(async (id: string) => {
    await runCommand("delete_html_favorite", { id });
    await refresh();
  }, [refresh]);

  return { favorites, refresh, toggle, remove };
}
