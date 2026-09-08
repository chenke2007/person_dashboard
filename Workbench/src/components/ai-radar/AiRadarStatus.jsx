const RADAR_TIME_ZONES = [
  "Etc/UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function formatRadarTime(iso, timeZone = "UTC") {
  if (!iso) return "尚未安排";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function prefixedZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// The status endpoint reports scheduler failures as {code, message}. Render a
// safe, user-facing string from that shape — never the raw object.
export function formatRadarError(error) {
  if (!error) return null;
  if (typeof error === "string") return error.trim() || null;
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof error?.code === "string" && error.code.trim()) return error.code.trim();
  return null;
}

export function AiRadarStatus({ status, schedule, stale, readOnly, busy, actionErrors, actions, collectFeedback, statusError, onRetryStatus }) {
  const timeZone = (schedule?.timeZone ?? prefixedZone()) || "UTC";
  const zones = new Set(RADAR_TIME_ZONES);
  if (timeZone) zones.add(timeZone);
  const saveBusy = Boolean(busy?.save);
  const collectBusy = Boolean(busy?.collect);
  const collectError = actionErrors?.collect ?? null;
  const saveError = actionErrors?.save ?? null;
  const statusScheduleError = formatRadarError(status?.error);

  const handleSave = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await actions.onUpdateSchedule({
      enabled: form.elements.enabled.checked,
      time: form.elements.time.value,
      timeZone: form.elements.timeZone.value,
    });
  };

  return (
    <section className="radar-status" aria-label="采集状态与调度设置">
      <div className="radar-status__line">
        <span className={`radar-status__dot radar-status__dot--${status?.running ? "running" : "idle"}`} aria-hidden="true" />
        {status?.running ? <b>采集中</b> : <span>空闲</span>}
        <span className="radar-status__meta">上次成功：{status?.lastSuccessAt ? formatRadarTime(status.lastSuccessAt, timeZone) : "尚未成功采集"}</span>
        {statusScheduleError ? <span className="radar-status__error">调度错误：{statusScheduleError}</span> : null}
      </div>
      {stale ? (
        <p className="radar-status__stale" role="status">数据可能不是最新，请稍后手动采集或等待下次调度。</p>
      ) : null}
      {statusError ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>状态刷新失败：{statusError}，正在显示上次成功状态。</p>
          {onRetryStatus ? (
            <button onClick={() => onRetryStatus()} type="button">重试状态</button>
          ) : null}
        </div>
      ) : null}
      <form
        className="radar-settings"
        key={schedule ? "ready" : "pending"}
        onSubmit={handleSave}
      >
        <h2>调度设置</h2>
        <div className="radar-settings__row">
          <label className="radar-settings__toggle">
            <input defaultChecked={Boolean(schedule?.enabled)} disabled={readOnly} name="enabled" type="checkbox" />
            启用自动采集
          </label>
          <label>
            运行时间
            <input defaultValue={schedule?.time ?? "08:00"} disabled={readOnly} name="time" type="time" />
          </label>
          <label>
            时区（IANA）
            <select defaultValue={schedule?.timeZone ?? ""} disabled={readOnly} name="timeZone">
              {[...zones].sort().map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          </label>
          <span className="radar-settings__next">下次运行：{formatRadarTime(status?.nextRunAt ?? null, timeZone)}</span>
        </div>
        {saveError ? <p className="radar-card__error" role="alert">{saveError}</p> : null}
        {collectError ? <p className="radar-card__error" role="alert">{collectError}</p> : null}
        {collectFeedback ? <p className={`radar-card__note radar-card__note--${collectFeedback.level}`} role="status">{collectFeedback.message}</p> : null}
        {!readOnly ? (
          <div className="radar-settings__actions">
            <button disabled={collectBusy} onClick={() => actions.onCollect()} type="button">
              {collectBusy ? "采集中…" : "立即采集"}
            </button>
            <button disabled={saveBusy} type="submit">
              {saveBusy ? "保存中…" : "保存设置"}
            </button>
          </div>
        ) : null}
      </form>
    </section>
  );
}