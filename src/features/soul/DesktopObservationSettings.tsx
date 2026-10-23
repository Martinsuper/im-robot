import { useEffect, useState } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";

type DesktopSettings = { revision: number; frequency: string; excluded_apps: string[]; model: string };
type DesktopStatus = { enabled: boolean; capture_permission: boolean; model: string; checks_remaining: number; last_error: string | null; diagnostics?: { stage: string; last_decision: string | null; model_requests: number } };
const MODEL_ERRORS = ["desktop_model_unavailable", "desktop_model_rejected", "desktop_model_invalid", "desktop_model_empty", "desktop_test_vision_failed", "desktop_test_busy", "desktop_decision_invalid"];
export function DesktopObservationSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<DesktopSettings>();
  const [status, setStatus] = useState<DesktopStatus>();
  const [excluded, setExcluded] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    void runCommand("soul_get_desktop_settings").then(value => {
      if (!disposed) { setSettings({ ...value, model: value.model ?? "" }); setExcluded(value.excluded_apps.join("\n")); }
    }).catch(() => { if (!disposed) setFailed(true); });
    const refresh = () => {
      void runCommand("soul_desktop_status").then(value => {
        if (!disposed && value && typeof value.enabled === "boolean") { setStatus(value); setStatusFailed(false); }
      }).catch(() => { if (!disposed) setStatusFailed(true); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  function modelError(error: unknown) {
    const code = MODEL_ERRORS.find(code => String(error).includes(code));
    return code ? t(`soul.desktop.errors.${code}`) : toUserMessage(error);
  }
  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await runCommand("soul_update_desktop_settings", { input: { ...settings, model: settings.model.trim(), excluded_apps: excluded.split("\n").map(s => s.trim()).filter(Boolean) } });
      setSettings(next);
      setExcluded(next.excluded_apps.join("\n"));
      toast.success(t("soul.desktop.saved"));
    } catch (error) { toast.error(toUserMessage(error)); }
    finally { setSaving(false); }
  }
  async function testModel() {
    if (!settings) return;
    setTesting(true);
    try {
      await runCommand("soul_test_desktop_model", { model: settings.model.trim() });
      toast.success(t("soul.desktop.testPassed"));
    } catch (error) { toast.error(modelError(error)); }
    finally { setTesting(false); }
  }
  async function testSpeech() {
    try {
      await runCommand("soul_test_desktop_speech");
      toast.success(t("soul.desktop.speechArmed"));
    } catch (error) { toast.error(toUserMessage(error)); }
  }
  return <div className="soul-settings__role" data-name="desktop-observation-settings">
    <h4>{t("soul.desktop.title")}</h4>
    <p>{t("soul.desktop.hint")}</p>
    <p>{t("soul.desktop.budget")}</p>
    {status && <div role="status" className="soul-desktop-status">
      <p>{t("soul.desktop.status")}: {t(`soul.desktop.${!status.enabled ? "disabled" : !status.capture_permission ? "permissionRequired" : "waiting"}`)}</p>
      <p>{t("soul.desktop.permission")}: {t(`soul.desktop.${status.capture_permission ? "granted" : "notGranted"}`)} · {t("soul.desktop.remaining")}: {status.checks_remaining}</p>
      <p>{t("soul.desktop.currentModel")}: {status.model}</p>
      {status.diagnostics && <p>{t("soul.desktop.progress")}: {t(`soul.desktop.stages.${status.diagnostics.stage || "waiting"}`)} · {t("soul.desktop.requests")}: {status.diagnostics.model_requests}{status.diagnostics.last_decision && <> · {t("soul.desktop.decision")}: {t(`soul.desktop.decisions.${status.diagnostics.last_decision}`)}</>}</p>}
      {status.last_error && <p>{t("soul.desktop.lastError")}: {modelError(status.last_error)}</p>}
    </div>}
    <button disabled={!status?.enabled} type="button" onClick={() => void testSpeech()}>{t("soul.desktop.testSpeech")}</button>
    <p>{t("soul.desktop.speechHint")}</p>
    {statusFailed && <p role="alert">{t("soul.desktop.statusUnavailable")}</p>}
    {failed && <p role="alert">{t("soul.desktop.loadFailed")}</p>}
    {settings && <>
      <label>{t("soul.desktop.model")}
        <input disabled={saving || testing} value={settings.model} maxLength={128} placeholder={t("soul.desktop.modelPlaceholder")} onChange={event => setSettings({ ...settings, model: event.currentTarget.value })} />
      </label>
      <p>{t("soul.desktop.testHint")}</p>
      <button disabled={saving || testing} type="button" onClick={() => void testModel()}>{t(`soul.desktop.${testing ? "testing" : "testModel"}`)}</button>
      <label>{t("soul.desktop.frequency")}
        <select disabled={saving} value={settings.frequency} onChange={event => setSettings({ ...settings, frequency: event.currentTarget.value })}>
          {["quiet", "natural", "active"].map(value => <option key={value} value={value}>{t(`soul.desktop.${value}`)}</option>)}
        </select>
      </label>
      <label>{t("soul.desktop.excluded")}
        <textarea disabled={saving} rows={3} value={excluded} placeholder={t("soul.desktop.placeholder")} onChange={event => setExcluded(event.currentTarget.value)} />
      </label>
      <button disabled={saving} type="button" onClick={() => void save()}>{t("soul.desktop.save")}</button>
    </>}
  </div>;
}
