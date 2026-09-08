export const RADAR_DECISION_LABELS = Object.freeze({
  unread: "未处理",
  saved: "收藏",
  summarized: "已摘要",
  queued: "学习队列",
  learning: "学习中",
  completed: "已完成",
  ignored: "已忽略",
});

export function AiRadarCard({ card, readOnly, busy, actionErrors, onDecide, onLessLike }) {
  const repositoryId = card.repositoryId;
  const decisionBusy = busy?.decision instanceof Set && busy.decision.has(repositoryId);
  const lessLikeBusy = busy?.lessLike instanceof Set && busy.lessLike.has(repositoryId);
  const canLessLike = (Array.isArray(card.topics) && card.topics.length > 0) || Boolean(card.language);
  const decisionError = actionErrors?.decision?.[repositoryId] ?? null;
  const lessLikeError = actionErrors?.lessLike?.[repositoryId] ?? null;
  const delta = typeof card.observedStarDelta === "number" ? card.observedStarDelta : null;
  const coverage = card.coverage;
  const coverageCopy =
    coverage && typeof coverage.expectedDays === "number"
      ? coverage.complete
        ? `覆盖 ${coverage.observedDays}/${coverage.expectedDays} 天`
        : `覆盖 ${coverage.observedDays}/${coverage.expectedDays} 天，缺少 ${coverage.missingDays} 天`
      : null;

  return (
    <article className="radar-card">
      <header className="radar-card__head">
        <h3 className="radar-card__name">
          <a href={card.htmlUrl} rel="noopener noreferrer" target="_blank">{card.fullName}</a>
        </h3>
        <span className="radar-card__decision">{RADAR_DECISION_LABELS[card.decisionStatus] ?? card.decisionStatus}</span>
      </header>
      {card.description ? <p className="radar-card__description">{card.description}</p> : null}
      <dl className="radar-card__metrics">
        <div>
          <dt>Star</dt>
          <dd><strong>{card.stars}</strong></dd>
        </div>
        <div>
          <dt>本地观测</dt>
          <dd>{delta === null ? "数据积累中" : `+${delta}`}</dd>
        </div>
        {coverageCopy ? (
          <div>
            <dt>覆盖</dt>
            <dd>{coverageCopy}</dd>
          </div>
        ) : null}
        {card.language ? (
          <div>
            <dt>语言</dt>
            <dd>{card.language}</dd>
          </div>
        ) : null}
        {card.license ? (
          <div>
            <dt>License</dt>
            <dd>{card.license}</dd>
          </div>
        ) : null}
        {card.archived ? (
          <div>
            <dt>状态</dt>
            <dd>已归档</dd>
          </div>
        ) : null}
      </dl>
      {Array.isArray(card.reasons) && card.reasons.length ? (
        <ul className="radar-card__reasons">
          {card.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
        </ul>
      ) : null}
      {!readOnly ? (
        <div className="radar-card__actions">
          {card.decisionStatus === "saved" ? (
            <button
              aria-label={`取消收藏 ${card.fullName}`}
              disabled={decisionBusy}
              onClick={() => onDecide(repositoryId, "unread")}
              type="button"
            >
              {decisionBusy ? "保存中…" : "取消收藏"}
            </button>
          ) : card.decisionStatus === "ignored" ? (
            <button
              aria-label={`恢复 ${card.fullName}`}
              disabled={decisionBusy}
              onClick={() => onDecide(repositoryId, "unread")}
              type="button"
            >
              {decisionBusy ? "保存中…" : "恢复"}
            </button>
          ) : (
            <>
              <button
                aria-label={`收藏 ${card.fullName}`}
                disabled={decisionBusy}
                onClick={() => onDecide(repositoryId, "saved")}
                type="button"
              >
                {decisionBusy ? "保存中…" : "收藏"}
              </button>
              <button
                aria-label={`忽略 ${card.fullName}`}
                disabled={decisionBusy}
                onClick={() => onDecide(repositoryId, "ignored")}
                type="button"
              >
                {decisionBusy ? "保存中…" : "忽略"}
              </button>
            </>
          )}
          <button
            aria-label={`减少类似推荐 ${card.fullName}`}
            disabled={lessLikeBusy || !canLessLike}
            onClick={() => onLessLike(repositoryId)}
            type="button"
          >
            {lessLikeBusy ? "提交中…" : "减少类似推荐"}
          </button>
          {decisionError ? <p className="radar-card__error" role="alert">{decisionError}</p> : null}
          {lessLikeError ? <p className="radar-card__error" role="alert">{lessLikeError}</p> : null}
        </div>
      ) : null}
    </article>
  );
}