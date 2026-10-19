import { useTranslation } from "../../features/i18n/I18nProvider";
import { useSyncExternalStore } from "react";
import {
  persistenceHealth,
  retryPersistentState,
} from "../../lib/persistentState";
export function PersistenceStatus() {
  const { t } = useTranslation();
  const error = useSyncExternalStore(
    persistenceHealth.subscribe,
    persistenceHealth.getSnapshot,
    () => undefined,
  );
  if (!error) return null;
  return (
    <aside className="persistence-error" role="alert">
      {t("data.pet.unavailable", "宠物数据保存暂不可用")}：{error}。
      <button type="button" onClick={() => void retryPersistentState()}>
        {t("data.pet.retry", "重新加载数据")}
      </button>
    </aside>
  );
}
