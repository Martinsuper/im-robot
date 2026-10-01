import type { ReactNode } from "react";
import type { ActionDraft } from "./chatTypes";
import { useTranslation } from "../i18n/I18nProvider";

export interface ConfirmationChoice {
  index: number;
  title: string;
}

export function getConfirmationChoices(
  draft?: ActionDraft,
  translateFallbackTitle?: (index: number) => string,
): ConfirmationChoice[] {
  const items = draft?.arguments.events;
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const choice = item as Record<string, unknown>;
    return {
      index,
      title: String(choice.title ?? (translateFallbackTitle ? translateFallbackTitle(index) : `项目 ${index + 1}`)),
    };
  });
}

interface ActionConfirmationCardProps {
  draft: ActionDraft;
  selectedChoiceIndexes: number[];
  onChoiceToggle: (choiceIndex: number) => void;
  onConfirm: () => void;
  onReject: () => void;
}

function ChoiceList({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="action-confirmation__choices">{children}</div>;
}

export function ActionConfirmationCard({
  draft,
  selectedChoiceIndexes,
  onChoiceToggle,
  onConfirm,
  onReject,
}: ActionConfirmationCardProps) {
  const { t } = useTranslation();
  const choices = getConfirmationChoices(
    draft,
    (index) => t("chat.confirm.item", "项目 {index}").replace("{index}", String(index + 1)),
  );
  const hasChoices = choices.length > 0;

  return (
    <section className="action-confirmation" aria-label={t("chat.confirm.ariaLabel", "待确认操作")}>
      <p className="eyebrow">ACTION CONFIRMATION</p>
      <strong>{t("chat.confirm.title", "待确认操作")}</strong>
      <p>{draft.summary}</p>
      {hasChoices && (
        <ChoiceList>
          {choices.map((choice) => (
            <label key={choice.index}>
              <input
                type="checkbox"
                checked={selectedChoiceIndexes.includes(choice.index)}
                onChange={() => onChoiceToggle(choice.index)}
              />
              <span>{choice.title}</span>
            </label>
          ))}
        </ChoiceList>
      )}
      <div>
        <button type="button" disabled={hasChoices && !selectedChoiceIndexes.length} onClick={onConfirm}>
          {t("chat.confirm.execute", "确认执行")}
        </button>
        <button className="is-secondary" type="button" onClick={onReject}>
          {t("chat.cancel", "取消")}
        </button>
      </div>
    </section>
  );
}
