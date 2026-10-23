import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";
import { SettingsGroup } from "../panel/PanelChrome";
import type { SoulDiagnostics as Diagnostics } from "./types";

export function SoulDiagnostics() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(isTauriRuntime);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setStatus(await runCommand("soul_diagnostics"));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let active = true;
    void runCommand("soul_diagnostics")
      .then((result) => { if (active) setStatus(result); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <SettingsGroup id="soul" icon={<ShieldCheck size={15} />} title={t("soul.title")}>
      <section className="panel-card">
        <h2>{t("soul.diagnosticsTitle")}</h2>
        <div role="status" aria-live="polite">
          {!isTauriRuntime ? <p>{t("soul.preview")}</p> : loading ? <p>{t("soul.loading")}</p> : failed ? (
            <p>{t("soul.loadFailed")}</p>
          ) : status ? (
            <>
              <p>{t(`soul.${status.storage}`)}</p>
              <p>{t(status.profile_valid ? "soul.profileHealthy" : "soul.profileFallback")}</p>
              <p>{t(status.ledger_readable ? "soul.ledgerHealthy" : "soul.ledgerBlocked")}</p>
              <p>{t("soul.rolloutPending")}</p>
            </>
          ) : null}
        </div>
        {isTauriRuntime && (
          <button type="button" className="button-secondary" disabled={loading} onClick={() => void refresh()}>
            {t("soul.refresh")}
          </button>
        )}
      </section>
    </SettingsGroup>
  );
}
