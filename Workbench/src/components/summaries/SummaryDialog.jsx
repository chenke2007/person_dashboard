import "./summary.css";

export const SUMMARY_SECTION_LABELS = Object.freeze({
  problemSolved: "解决什么问题",
  coreCapabilities: "核心能力",
  techStack: "技术栈",
  keyModules: "关键目录或模块",
  suitableUseCases: "适合的使用场景",
  unsuitableUseCases: "不适合的使用场景",
  learningGoalCandidates: "适合的学习目标候选",
  risksAndBoundaries: "风险和边界",
});

function shortSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : null;
}

// Read-only summary panel driven by page state. Shows a fixed commit and the
// model/provider that produced it; a failed fetch keeps the previous valid
// summary visible with a retry action; an unconfigured model shows "尚未配置摘
// 要模型" and never fabricates content. Joining learning stays an explicit,
// separate user action — this dialog never writes to learning or Obsidian.
export function SummaryDialog({
  repository,
  summary,
  capabilities = null,
  loading = false,
  error = null,
  notice = null,
  onClose,
  onGenerate,
}) {
  const canGenerate = Boolean(capabilities?.generate);
  const summaryId = summary?.summaryId ?? null;
  const repoName = repository?.fullName ?? "";
  const repoUrl = repository?.htmlUrl ?? null;
  const summaryCategories = Object.keys(SUMMARY_SECTION_LABELS);

  return (
    <div className="summary-dialog-wrapper" role="dialog" aria-modal="true" aria-label={`仓库摘要 ${repoName}`}>
      <div className="summary-dialog">
        <header className="summary-dialog__head">
          <h2>仓库摘要</h2>
          <button aria-label="关闭摘要" className="summary-dialog__close" onClick={onClose} type="button">×</button>
        </header>

        <div className="summary-dialog__repo">
          <p className="summary-dialog__repolink">
            {repoUrl
              ? <a href={repoUrl} rel="noopener noreferrer" target="_blank">{repoName}</a>
              : <span>{repoName}</span>}
          </p>
          {summary ? (
            <ul className="summary-dialog__meta">
              <li>固定提交 <code title={summary.sourceCommitSha}>{shortSha(summary.sourceCommitSha) ?? summary.sourceCommitSha}</code></li>
              <li>生成于 {summary.generatedAt ? String(summary.generatedAt).slice(0, 19).replace("T", " ") : "—"}</li>
              <li>模型 {summary.model?.providerId ?? "—"} / {summary.model?.modelId ?? "—"}</li>
            </ul>
          ) : null}
        </div>

        {loading ? (
          <p className="summary-dialog__loading">正在生成摘要…</p>
        ) : null}

        {!loading && error ? (
          <p className="summary-dialog__error" role="alert">{error}</p>
        ) : null}

        {!loading && !error && !summary && notice ? (
          <p className="summary-dialog__notice" role="status">{notice}</p>
        ) : null}

        {!loading && !summary && !error && !notice ? (
          <p className="summary-dialog__empty">该仓库暂无摘要。{canGenerate ? "点击下方按钮生成。" : "尚未配置摘要模型。"}</p>
        ) : null}

        {summary ? (
          <dl className="summary-dialog__content">
            {summaryCategories.map((key) => {
              const value = summary.sections?.[key];
              return (
                <div className="summary-dialog__section" key={key}>
                  <dt>{SUMMARY_SECTION_LABELS[key]}</dt>
                  <dd>{typeof value === "string" && value.trim() ? value : "—"}</dd>
                </div>
              );
            })}
          </dl>
        ) : null}

        {!loading && error && summary ? (
          <p className="summary-dialog__stale" role="status">保留了上一次有效摘要。</p>
        ) : null}

        <footer className="summary-dialog__footer">
          {canGenerate && !loading && (!summary || error) ? (
            <button onClick={onGenerate} type="button">{summary ? "重新生成" : "生成摘要"}</button>
          ) : null}
          {summaryId ? (
            <span className="summary-dialog__hint">“加入学习”是独立操作，本摘要不会自动标记学习。</span>
          ) : null}
          <button onClick={onClose} type="button">关闭</button>
        </footer>
      </div>
    </div>
  );
}