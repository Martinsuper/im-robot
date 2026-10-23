import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { version } from "../../../package.json";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useTranslation } from "../i18n/I18nProvider";
import { runCommand, isTauriRuntime } from "../app/appRuntime";
import type { UpdateStatus } from "../../types/appTypes";

type Progress = { downloadId: string; received: number; total?: number };
/** Update state and native subscription belong to this section, independently of other settings. */
export function VersionSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const [release, setRelease] = useState<UpdateStatus>();
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadedPath, setDownloadedPath] = useState("");
  const [progress, setProgress] = useState<Progress>();
  const active = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const subscription = isTauriRuntime
      ? listen<Progress>("update-download-progress", ({ payload }) => {
          if (mounted.current && active.current === payload.downloadId)
            setProgress(payload);
        })
      : Promise.resolve(() => {});
    void subscription.catch((error) => {
      if (mounted.current) toast.error(toUserMessage(error));
    });
    return () => {
      mounted.current = false;
      void subscription.then((dispose) => dispose()).catch(() => {});
      if (active.current)
        void runCommand("cancel_update_download", {
          downloadId: active.current,
        }).catch(() => {});
    };
  }, [toast]);
  async function check() {
    setChecking(true);
    setDownloadedPath("");
    try {
      const result = await runCommand(
        "check_for_updates_extended",
        undefined,
        {
          currentVersion: version,
          latestVersion: version,
          available: false,
          releaseUrl: "",
          releaseNotes: null,
          downloadUrl: null,
          assetName: null,
        },
      );
      if (!mounted.current) return;
      setRelease(result);
      toast.info(
        result.available
          ? `${t("update.available", "发现新版本")}：${result.latestVersion}`
          : `${t("update.latest", "已是最新版本")}：${result.currentVersion}`,
      );
    } catch (error) {
      if (mounted.current)
        toast.error(
          `${t("update.checkFailed", "检查更新失败")}：${toUserMessage(error)}`,
        );
    } finally {
      if (mounted.current) setChecking(false);
    }
  }
  async function download() {
    if (!release?.downloadUrl || !release.assetName || active.current) return;
    const id = crypto.randomUUID();
    active.current = id;
    setDownloading(true);
    setProgress(undefined);
    setDownloadedPath("");
    try {
      const result = await runCommand(
        "download_update_asset",
        {
          downloadUrl: release.downloadUrl,
          assetName: release.assetName,
          downloadId: id,
        },
      );
      if (!mounted.current) return;
      setDownloadedPath(result.filePath);
      toast.success(
        `${t("update.downloadComplete", "下载完成")}：${result.fileName}`,
      );
    } catch (error) {
      if (mounted.current)
        toast.error(
          `${t("update.downloadFailed", "下载失败")}：${toUserMessage(error)}`,
        );
    } finally {
      active.current = undefined;
      if (mounted.current) setDownloading(false);
    }
  }
  async function cancel() {
    if (!active.current) return;
    try {
      await runCommand("cancel_update_download", {
        downloadId: active.current,
      });
    } catch (error) {
      toast.error(toUserMessage(error));
    }
  }
  async function open(target: string, file = false) {
    try {
      if (file) await openPath(target);
      else await openUrl(target);
    } catch (error) {
      toast.error(toUserMessage(error));
    }
  }
  return (
    <section className="panel-card">
      <div className="section-heading">
        <h2>{t("update.versionInfo", "版本信息")}</h2>
        <div className="section-heading__actions">
          <button
            type="button"
            disabled={checking || downloading}
            onClick={() => void check()}
          >
            {checking
              ? t("update.checking", "正在检查更新…")
              : t("update.check", "检查更新")}
          </button>
          {release?.available && release.downloadUrl && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading
                ? t("update.downloading", "正在下载…")
                : t("update.download", "下载更新")}
            </button>
          )}
          {downloading && (
            <button type="button" onClick={() => void cancel()}>
              {t("update.cancel", "取消下载")}
            </button>
          )}
        </div>
      </div>
      <p className="settings-note">Piko Desktop Companion · v{version}</p>
      {downloading && (
        <div role="status" aria-live="polite">
          {t("update.downloading", "正在下载…")}{" "}
          {progress?.total
            ? `${Math.round((progress.received / progress.total) * 100)}%`
            : progress
              ? `${Math.round(progress.received / 1024)} KiB`
              : ""}
        </div>
      )}
      {release?.available && !release.downloadUrl && (
        <p>
          {t(
            "update.noAsset",
            "没有适用于当前平台的安装包，请打开发布页下载。",
          )}
        </p>
      )}
      {release?.releaseUrl && (
        <button
          className="release-link"
          type="button"
          onClick={() => void open(release.releaseUrl)}
        >
          {t("update.openRelease", "打开下载页")}
        </button>
      )}
      {downloadedPath && (
        <button
          className="release-link"
          type="button"
          onClick={() => void open(downloadedPath, true)}
        >
          {t("update.openFile", "打开已下载文件")}
        </button>
      )}
    </section>
  );
}
