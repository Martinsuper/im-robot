// S10：记忆中心的开放话题审核（批准/拒绝/修改）与已确认话题手动管理
// （关闭/取消/时间编辑）。相似来源只提示合并候选，不自动合并。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n/I18nProvider";
import "./soul.css";
import {
  type CandidateStatus,
  type OpenLoop,
  type OpenLoopReviewCandidate,
  type OpenLoopState,
  type OpenLoopTime,
  type OpenLoopReviewQueue,
} from "./types";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";

function formatWindow(time: OpenLoopTime): string {
  if (time.starts_at == null || time.ends_at == null) {
    return "未排期";
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: time.timezone,
  });
  return `${formatter.format(new Date(time.starts_at * 1000))} – ${formatter.format(new Date(time.ends_at * 1000))}`;
}

export function OpenLoopReview() {
  const { t } = useTranslation();
  const toast = useToast();
  const [responses, setResponses] = useState<{id:string;topic_id:string;proposed_state:string;proposed_time:OpenLoopTime|null}[]>([]);
  const [queue, setQueue] = useState<OpenLoopReviewQueue>();
  const [topics, setTopics] = useState<OpenLoop[]>();

  const load = useCallback(() => {
    if (!isTauriRuntime) return;
    void runCommand("soul_list_topic_responses").then((value) => setResponses(value as Array<{ id: string; topic_id: string; proposed_state: string; proposed_time: OpenLoopTime | null }>)).catch(() => undefined);
    void runCommand("soul_list_open_loop_candidates")
      .then(setQueue)
      .catch((error) => toast.error(toUserMessage(error, t("soul.review.loadFailed"))));
    void runCommand("soul_list_open_loops", { input: { state: null } })
      .then(setTopics)
      .catch(() => undefined);
  }, [t, toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(
    candidateId: string,
    decision: CandidateStatus,
    content: string,
  ) {
    try {
      await runCommand("soul_review_candidate", {
        input: { candidate_id: candidateId, decision, content: content || null, time: null },
      });
      toast.success(t("soul.review.done"));
      load();
    } catch (error) {
      toast.error(toUserMessage(error, t("soul.review.conflict")));
    }
  }

  async function updateTopic(input: {
    id: string;
    expected_revision: number;
    state?: OpenLoopState;
  }) {
    try {
      await runCommand("soul_update_open_loop", { input });
      load();
    } catch (error) {
      toast.error(toUserMessage(error, t("soul.review.conflict")));
    }
  }

  function editTime(topic: OpenLoop) {
    const answer = window.prompt(t("soul.review.editDate"), "");
    if (!answer) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(answer)) {
      toast.error(t("soul.review.invalidDate"));
      return;
    }
    // 手动时间编辑固定 manual-1 解析版本；延期后话题回到 tracking。
    void runCommand("soul_update_open_loop", {
      input: {
        id: topic.id,
        expected_revision: topic.revision,
        time: {
          expression: answer,
          baseline: topic.time.baseline,
          timezone: topic.time.timezone,
          starts_at: null,
          ends_at: null,
          parser_version: "ignored",
        },
      },
    })
      .then(load)
      .catch((error) => toast.error(toUserMessage(error, t("soul.review.conflict"))));
  }

  return (
    <section data-name="soul-open-loop-review">
      <h3>{t("soul.review.title")}</h3>
      {responses.map((response) => <div key={response.id} className="soul-review__candidate">
        <p>{t("soul.review.responseProposal")}: {topics?.find((topic)=>topic.id===response.topic_id)?.content ?? response.topic_id}</p>
        <p>{t(`soul.review.proposal.${response.proposed_state}`)} {response.proposed_time ? formatWindow(response.proposed_time) : ""}</p>
        {[true,false].map((approve)=><button type="button" key={String(approve)} onClick={()=>void runCommand("soul_review_topic_response",{id:response.id,approve}).then(load).catch((error)=>toast.error(toUserMessage(error,t("soul.review.conflict"))))}>{t(approve?"soul.review.approve":"soul.review.reject")}</button>)}
      </div>)}

      {(queue?.candidates.length ?? 0) > 0 && (
        <ul className="soul-review__list">
          {queue?.candidates.map((item) => (
            <SoulCandidateRow key={item.candidate.id} item={item} onDecide={decide} />
          ))}
          <p className="soul-review__capacity">
            {t("soul.review.capacity").replace("{count}", String(queue?.active_count ?? 0)).replace("{limit}", String(queue?.active_limit ?? 0))}
          </p>
        </ul>
      )}
      <ul className="soul-review__topics">
        {topics?.map((topic) => (
          <li key={topic.id}>
            <span>{topic.content}</span>
            <span className="soul-review__window">{formatWindow(topic.time)}</span>
            {topic.state === "tracking" && (
              <span>
                <button type="button" onClick={() => void updateTopic({ id: topic.id, expected_revision: topic.revision, state: "closed" })}>
                  {t("soul.review.close")}
                </button>
                <button type="button" onClick={() => void updateTopic({ id: topic.id, expected_revision: topic.revision, state: "cancelled" })}>
                  {t("soul.review.cancel")}
                </button>
                <button type="button" onClick={() => editTime(topic)}>{t("soul.review.editDateButton")}</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SoulCandidateRow(props: {
  item: OpenLoopReviewCandidate;
  onDecide: (id: string, status: CandidateStatus, content: string) => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState(props.item.candidate.content);
  return (
    <li>
      <input
        value={content}
        onChange={(event) => setContent(event.currentTarget.value)}
        aria-label={t("soul.review.candidateContent")}
      />
      <span className="soul-review__window">{props.item.candidate.time.expression ?? "未排期"}</span>
      {(props.item.similar_candidate_ids.length > 0 || props.item.similar_loop_ids.length > 0) && (
        <p className="soul-review__similar">{t("soul.review.similar")}</p>
      )}
      <button type="button" onClick={() => props.onDecide(props.item.candidate.id, "approved", content)}>
        {t("soul.review.approve")}
      </button>
      <button type="button" onClick={() => props.onDecide(props.item.candidate.id, "rejected", "")}>
        {t("soul.review.reject")}
      </button>
    </li>
  );
}
