import { useEffect, useRef, useState } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import type { T_devices_DeviceStatus_Output as DeviceStatus } from "../../generated/ipc";
import { toUserMessage } from "../../lib/errors";

export function DeviceSettings() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const revision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime) return;
    let alive = true;
    const refresh = () => {
      const started = revision.current;
      void runCommand("get_device_status")
        .then((next) => {
          if (alive && started === revision.current) setStatus(next);
        })
        .catch((e) => {
          if (alive && started === revision.current) setError(toUserMessage(e));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  async function update(
    command:
      | "start_device_bridge"
      | "stop_device_bridge"
      | "begin_device_pairing"
      | "forget_device",
  ) {
    revision.current++;
    setBusy(true);
    setError("");
    try {
      setStatus(
        await (command === "begin_device_pairing"
          ? runCommand(command, { requestId: status?.pendingRequest ?? null })
          : runCommand(command)),
      );
      setConfirmForget(false);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel-card passport-device"
      aria-label="Piko Passport 设备"
    >
      <h2>Piko Passport</h2>
      <p className="field-help">
        让 AI Passport 显示
        Piko、同步专注倒计时，通过按键与它互动或语音对话。电脑和设备需要连接同一
        Wi-Fi。
      </p>
      <p className="field-help">
        语音页按住 OK 说话，松开发送。使用前请先下载 SenseVoice
        语音模型并配置聊天模型；回复从设备扬声器播放。提醒、日程、备忘和专注操作可在设备确认；文件、命令和目录授权在电脑端完成。
      </p>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={status?.running ?? false}
          disabled={!isTauriRuntime || busy || !status}
          onChange={(e) =>
            void update(
              e.currentTarget.checked
                ? "start_device_bridge"
                : "stop_device_bridge",
            )
          }
        />
        <span>开启局域网设备连接</span>
      </label>
      {!isTauriRuntime && (
        <p className="field-help">请在桌面应用中连接设备。</p>
      )}
      {status?.running && (
        <>
          <p role="status">
            {status.connected
              ? "已连接"
              : status.deviceId
                ? "等待设备重连"
                : "等待配对"}
            {status.deviceName ? ` · ${status.deviceName}` : ""}
            {status.connected && status.battery !== null
              ? ` · 电量 ${status.battery}%`
              : ""}
          </p>
          <p className="field-help">
            设备连上同一 Wi-Fi 后，在设备的「连接」页短按确认键即可连接，无需在电脑再次确认。
            关闭此开关会断开设备；应用重启后会恢复你选择的开关状态。
          </p>
          {!status.deviceId && (
            <>
              {status.pendingDevice && (
                <p role="status">
                  发现旧版设备：{status.pendingDevice}。新版固件可直接在设备上发起连接；旧版设备可在下方连接。
                </p>
              )}
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => void update("begin_device_pairing")}
              >
                {status.pendingDevice
                  ? "连接旧版设备"
                  : status.pairingCode
                    ? "刷新手动配对码"
                    : "生成手动配对码"}
              </button>
              {status.pairingCode && !status.pendingDevice && (
                <p role="status">
                  配对码：
                  <strong className="passport-pairing-code">
                    {status.pairingCode}
                  </strong>{" "}
                  · {Math.ceil(status.pairingSeconds / 60)} 分钟内有效
                </p>
              )}
            </>
          )}
        </>
      )}
      {status?.deviceId && (
        <div>
          {confirmForget ? (
            <>
              <p>解除后需要在设备上重新配对。</p>
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => void update("forget_device")}
              >
                确认解除配对
              </button>{" "}
              <button
                type="button"
                className="button-secondary"
                disabled={busy}
                onClick={() => setConfirmForget(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => setConfirmForget(true)}
            >
              解除配对
            </button>
          )}
        </div>
      )}
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </section>
  );
}
