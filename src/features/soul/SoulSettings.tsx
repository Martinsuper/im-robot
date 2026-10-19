// S10：设置页的「人格与主动消息」设置。选项+自由补充的角色编辑、
// 全局/类别开关与清理入口；未交付的 P1/P2 能力禁用并注明，不显示为已生效。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n/I18nProvider";
import "./soul.css";
import { DesktopObservationSettings } from "./DesktopObservationSettings";
import { ContinuitySettings } from "./ContinuitySettings";
import {
  type RoleOverrides,
  type RoleSnapshot,
  type SoulSettings,
} from "./types";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";

const TEXT_FIELDS = [
  ["background", "soul.settings.background"],
  ["tone", "soul.settings.tone"],
  ["care", "soul.settings.care"],
  ["stance", "soul.settings.stance"],
] as const;

const LIST_FIELDS = [
  ["values", "soul.settings.values"],
  ["catchphrases", "soul.settings.catchphrases"],
  ["forbidden_phrases", "soul.settings.forbidden"],
] as const;

export function SoulSettings() {
  const { t, locale } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<SoulSettings>();
  const [role, setRole] = useState<RoleSnapshot>();
  const [draft, setDraft] = useState<RoleOverrides>({});
  const [clearing, setClearing] = useState(false);
  const [clearHistory,setClearHistory]=useState(false);

  const load = useCallback(() => {
    if (!isTauriRuntime) return;
    runCommand<SoulSettings>("soul_get_settings", undefined)
      .then(setSettings)
      .catch((error) => toast.error(t("soul.settings.loadFailed") + toUserMessage(error)));
  }, [t, toast]);

  const loadRole = useCallback((locale: string) => {
    if (!isTauriRuntime) return;
    void runCommand<RoleSnapshot>("soul_get_profile", { locale })
      .then((snapshot) => {
        setRole(snapshot);
        setDraft({ ...snapshot.user_overrides });
      })
      .catch((error) => toast.error(toUserMessage(error, t("soul.settings.loadFailed"))));
  }, [toast, t]);

  useEffect(() => {
    load();
    loadRole(locale);
  }, [load, loadRole, locale]);

  const writable = role?.writable ?? false;

  function setTextField(field: keyof RoleOverrides, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  function setListField(field: keyof RoleOverrides, value: string) {
    const items = value.split("、").map((item) => item.trim()).filter(Boolean);
    setDraft((previous) => ({ ...previous, [field]: items }));
  }

  async function saveRole() {
    try {
      const updated = await runCommand<RoleSnapshot>("soul_update_profile", {
        input: { expected_revision: role?.revision ?? 0, locale, user_overrides: draft },
      });
      setRole(updated);
      setDraft({ ...updated.user_overrides });
      toast.success(t("soul.settings.saved"));
    } catch (error) {
      toast.error(toUserMessage(error, t("soul.settings.conflict")));
    }
  }

  async function toggleSwitch(patch: {
    enabled?: boolean;
    paused?: boolean;
    mood_enabled?: boolean;
    evolution_enabled?: boolean;
    category?: { name: string; enabled: boolean };
  }) {
    if (!settings) return;
    const categories = patch.category
      ? settings.categories.filter((category) => category.category === patch.category?.name)
          .map((category) => ({ ...category, enabled: patch.category!.enabled }))
      : null;
    try {
      const updated = await runCommand<SoulSettings>("soul_update_settings", {
        input: {
          expected_revision: settings.revision, enabled: patch.enabled ?? null,
          paused: patch.paused ?? null, categories, mood_enabled: patch.mood_enabled ?? null, evolution_enabled: patch.evolution_enabled ?? null,
        },
      });
      setSettings(updated);
    } catch (error) {
      toast.error(toUserMessage(error, t("soul.settings.conflict")));
    } finally {
      load();
    }
  }

  async function clearAll() {
    if (!window.confirm(t("soul.settings.clearConfirm"))) return;
    setClearing(true);
    try {
      await runCommand("soul_clear", { input: { scopes: ["all"] } });
      toast.success(t("soul.settings.cleared"));
      load();
      loadRole(locale);
    } catch (error) {
      toast.error(toUserMessage(error, t("soul.settings.clearFailed")));
    } finally {
      setClearing(false);
    }
  }

  const categoryRows = useMemo(() => settings?.categories ?? [], [settings]);

  return (
    <section data-name="soul-settings">
      <h3>{t("soul.settings.title")}</h3>
      <p>{t("soul.settings.rolloutNotice")}</p>
      {settings && (
        <div className="soul-settings__switches">
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void toggleSwitch({ enabled: event.currentTarget.checked })}
            />
            {t("soul.settings.globalSwitch")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.paused}
              onChange={(event) => void toggleSwitch({ paused: event.currentTarget.checked })}
            />
            {t("soul.settings.pause")}
          </label>
          <label>
            <input type="checkbox" checked={settings.mood_enabled}
              onChange={(event) => void toggleSwitch({ mood_enabled: event.currentTarget.checked })} />
            {t("soul.settings.mood")}
          </label>
          <p>{t("soul.settings.moodHint")}</p>
          <label><input type="checkbox" checked={settings.evolution_enabled} onChange={event=>void toggleSwitch({evolution_enabled:event.currentTarget.checked})}/>{t("soul.continuity.evolution")}</label>
          <p>{t("soul.continuity.evolutionHint")}</p>
          <button type="button" onClick={()=>void runCommand<boolean>("soul_request_notification_permission").then(granted=>{
            if(granted)toast.success(t("soul.settings.notificationGranted"));else toast.error(t("soul.settings.notificationDenied"));
          }).catch(error=>toast.error(toUserMessage(error)))}>{t("soul.settings.notificationPermission")}</button>
          {categoryRows.map((category) => (
            <div key={category.category}><label>
              <input
                type="checkbox"
                disabled={!category.available}
                checked={category.available ? category.enabled : false}
                onChange={(event) => void toggleSwitch({
                  category: { name: category.category, enabled: event.currentTarget.checked },
                })}
              />
              {t(`soul.category.${category.category}`)}
              {!category.available && (
                <span className="soul-settings__pending">（{t("soul.settings.notShipped")}）</span>
              )}
            </label><button type="button" aria-label={`${t("soul.settings.clearCategory")} ${t(`soul.category.${category.category}`)}`} onClick={()=>{
              if(window.confirm(t("soul.settings.clearCategoryConfirm")))void runCommand<SoulSettings>("soul_clear_category",{category:category.category,expectedRevision:settings.revision}).then(setSettings).catch(error=>toast.error(toUserMessage(error,t("soul.settings.conflict"))));
            }}>{t("soul.settings.clearCategory")}</button></div>
          ))}
          <button type="button" disabled={clearing} onClick={() => void clearAll()}>
            {t("soul.settings.clear")}
          </button>
        </div>
      )}
      <DesktopObservationSettings />
      {role && (
        <div className="soul-settings__role">
          {!writable && <p role="alert">{t("soul.settings.readOnlyRole")}</p>}
          <label>{t("soul.settings.tonePreset")}
            <select value="" disabled={!writable} onChange={(event)=>{
              if(event.currentTarget.value) setTextField("tone",t(`soul.settings.toneStyle.${event.currentTarget.value}`));
            }}>
              <option value="">{t("soul.settings.choosePreset")}</option>
              {["concise","warm","direct"].map((name)=><option key={name} value={name}>{t(`soul.settings.toneLabel.${name}`)}</option>)}
            </select>
          </label>
          {TEXT_FIELDS.map(([field, label]) => (
            <label key={field}>
              {t(label)}
              <textarea
                value={String(draft[field] ?? "")}
                placeholder={String(role.effective[field] ?? "")}
                rows={2}
                disabled={!writable}
                onChange={(event) => setTextField(field, event.currentTarget.value)}
              />
            </label>
          ))}
          {LIST_FIELDS.map(([field, label]) => (
            <label key={field}>
              {t(label)}
              <input
                value={((draft[field] as string[] | undefined) ?? []).join("、")}
                placeholder={role.effective[field].join("、")}
                disabled={!writable}
                onChange={(event) => setListField(field, event.currentTarget.value)}
              />
            </label>
          ))}
          <label>{t("soul.settings.extra")}
            <textarea value={draft.extra ?? ""} disabled={!writable}
              onChange={(event) => setTextField("extra", event.currentTarget.value)} />
          </label>
          <label><input type="checkbox" checked={clearHistory} onChange={(event)=>setClearHistory(event.currentTarget.checked)} />{t("soul.settings.clearRoleHistory")}</label>
          <div className="soul-settings__actions">
            <button type="button" disabled={!writable} onClick={() => void saveRole()}>
              {t("soul.settings.save")}
            </button>
            <button
              type="button"
              disabled={role.revision < 1}
              onClick={() => {
                if (!window.confirm(t("soul.settings.resetConfirm"))) return;
                void runCommand<RoleSnapshot>("soul_reset_profile", {
                  input: { expected_revision: role.revision, locale, clear_evolution_history: clearHistory },
                })
                  .then((updated) => {
                    setRole(updated);
                    setDraft({ ...updated.user_overrides });
                    toast.success(t("soul.settings.resetDone"));
                  })
                  .catch((error) => toast.error(toUserMessage(error, t("soul.settings.conflict"))));
              }}
            >
              {t("soul.settings.reset")}
            </button>
          </div>
        </div>
      )}
      {role && <ContinuitySettings roleRevision={role.revision} onChanged={()=>loadRole(locale)}/>}
    </section>
  );
}
