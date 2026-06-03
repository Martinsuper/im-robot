import type { ReactNode } from "react";
import type { ActionDraft } from "./chatTypes";

export interface ConfirmationChoice {
  index: number;
  title: string;
}

export function getConfirmationChoices(draft?: ActionDraft): ConfirmationChoice[] {
  const items = draft?.arguments.events;
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const choice = item as Record<string, unknown>;
    return {
      index,
      title: String(choice.title ?? `项目 ${index + 1}`),
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
  const choices = getConfirmationChoices(draft);
  const hasChoices = choices.length > 0;

  return (
    <section className="action-confirmation" aria-label="待确认操作">
      <p className="eyebrow">ACTION CONFIRMATION</p>
      <strong>待确认操作</strong>
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
          确认执行
        </button>
        <button className="is-secondary" type="button" onClick={onReject}>
          取消
        </button>
      </div>
    </section>
  );
}
