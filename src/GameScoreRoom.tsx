import { useEffect, useMemo, useState } from "react";
import type { PaginationStatus } from "./postgresReact";
import type { ChatMessage } from "./api";
import {
  buildLeaderboard,
  parseGameScores,
  scorePeriodStart,
  type FoodGuessrScore,
  type GameId,
  type GameScore,
  type RngdleScore,
  type ScorePeriod,
} from "./gameScores";

const games: Array<{ id: GameId; name: string; shortName: string }> = [
  { id: "rngdle", name: "RNGdle", shortName: "RNG" },
  { id: "foodguessr", name: "FoodGuessr", shortName: "Food" },
];
const periods: Array<{ id: ScorePeriod; name: string }> = [
  { id: "day", name: "Today" },
  { id: "week", name: "This week" },
  { id: "month", name: "This month" },
  { id: "all", name: "All time" },
];

export default function GameScoreRoom({
  messages,
  error,
  historyEnabled,
  isAdmin,
  loadMore,
  onDeleteMessage,
  onRetry,
  paused,
  status,
}: {
  messages: ChatMessage[];
  error?: string;
  historyEnabled: boolean;
  isAdmin: boolean;
  loadMore: (numItems: number) => void;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onRetry: () => void;
  paused: boolean;
  status: PaginationStatus;
}) {
  const [game, setGame] = useState<GameId>("rngdle");
  const [period, setPeriod] = useState<ScorePeriod>("all");
  const [deletingId, setDeletingId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const scores = useMemo(() => parseGameScores(messages), [messages]);
  const periodStart = scorePeriodStart(period, now);
  const visibleScores = useMemo(
    () => scores.filter((score) =>
      score.game === game && score.playedAt >= periodStart && score.playedAt <= now
    ),
    [game, now, periodStart, scores],
  );
  const leaderboard = useMemo(
    () => buildLeaderboard(scores, game, period, now),
    [game, now, period, scores],
  );
  const gameCounts = useMemo(() => {
    const counts = new Map<GameId, number>([["rngdle", 0], ["foodguessr", 0]]);
    for (const score of scores) counts.set(score.game, (counts.get(score.game) ?? 0) + 1);
    return counts;
  }, [scores]);

  useEffect(() => {
    if (!paused && historyEnabled && status === "CanLoadMore") loadMore(250);
  }, [historyEnabled, loadMore, paused, status]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const deleteMessage = async (score: GameScore) => {
    setDeletingId(score._id);
    try {
      await onDeleteMessage(score.message._id);
    } finally {
      setDeletingId(undefined);
    }
  };

  if (status === "LoadingFirstPage") {
    return <div className="score-room score-room-state">Reading the score tape…</div>;
  }
  if (status === "Error") {
    return (
      <div className="score-room score-room-state" role="alert">
        <strong>Could not open the score room</strong>
        <span>{error ?? "The message service is unavailable."}</span>
        <button className="button" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  return (
    <div className="score-room">
      <header className="score-room-header">
        <div className="score-room-title">
          <span className="score-kicker">Unofficial chat league</span>
          <h2>Score room</h2>
          <p>Shared runs, parsed straight from chat. Bragging rights only.</p>
        </div>
        <div className="score-room-controls">
          <div aria-label="Choose a game" className="score-game-switch" role="group">
            {games.map((candidate) => (
              <button
                aria-pressed={game === candidate.id}
                className={game === candidate.id ? "selected" : ""}
                key={candidate.id}
                onClick={() => setGame(candidate.id)}
              >
                <span>{candidate.shortName}</span>
                <strong>{candidate.name}</strong>
                <small>{gameCounts.get(candidate.id) ?? 0}</small>
              </button>
            ))}
          </div>
          <div aria-label="Leaderboard period" className="score-period-switch" role="group">
            {periods.map((candidate) => (
              <button
                aria-pressed={period === candidate.id}
                className={period === candidate.id ? "selected" : ""}
                key={candidate.id}
                onClick={() => setPeriod(candidate.id)}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        </div>
      </header>

      {status !== "Exhausted" && historyEnabled && (
        <div className="score-archive-status">
          <span aria-hidden="true" />
          {paused ? "Archive scan paused" : "Building rankings from saved chat…"}
        </div>
      )}

      {scores.length === 0 && status === "Exhausted" ? (
        <div className="score-empty">
          <span aria-hidden="true">000</span>
          <strong>No recognized scores yet</strong>
          <p>Share an RNGdle result or a FoodGuessr Daily score in chat and it will land here.</p>
        </div>
      ) : (
        <div className="score-room-grid">
          <aside className="leaderboard">
            <div className="leaderboard-heading">
              <div>
                <span>{games.find((candidate) => candidate.id === game)?.name}</span>
                <h3>{periods.find((candidate) => candidate.id === period)?.name}</h3>
              </div>
              <strong>{leaderboard.length} ranked</strong>
            </div>
            {leaderboard.length === 0 ? (
              <div className="leaderboard-empty">
                No scores in this period. The board is wide open.
              </div>
            ) : (
              <ol className="leaderboard-list">
                {leaderboard.map((entry) => (
                  <li className={entry.rank <= 3 ? `podium rank-${entry.rank}` : ""} key={entry.username}>
                    <span className="leaderboard-rank">{String(entry.rank).padStart(2, "0")}</span>
                    <span className="leaderboard-player">
                      <strong>{entry.player}</strong>
                      <small>{entry.submissions} {entry.submissions === 1 ? "run" : "runs"}</small>
                    </span>
                    <strong className="leaderboard-score">{formatScore(entry.score)}</strong>
                  </li>
                ))}
              </ol>
            )}
          </aside>

          <section aria-label={`${game} score submissions`} className="score-submissions">
            <div className="score-submissions-heading">
              <div>
                <span>Score tape</span>
                <strong>{visibleScores.length} {visibleScores.length === 1 ? "entry" : "entries"}</strong>
              </div>
              <span>Newest first</span>
            </div>
            {visibleScores.length === 0 ? (
              <div className="score-period-empty">
                No {games.find((candidate) => candidate.id === game)?.name} cards for this period.
              </div>
            ) : (
              <div className="score-card-grid">
                {visibleScores.map((score) => score.game === "rngdle" ? (
                  <RngdleCard
                    deleting={deletingId === score._id}
                    isAdmin={isAdmin}
                    key={score._id}
                    onDelete={() => void deleteMessage(score)}
                    score={score}
                  />
                ) : (
                  <FoodGuessrCard
                    deleting={deletingId === score._id}
                    isAdmin={isAdmin}
                    key={score._id}
                    onDelete={() => void deleteMessage(score)}
                    score={score}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function RngdleCard({
  score,
  deleting,
  isAdmin,
  onDelete,
}: {
  score: RngdleScore;
  deleting: boolean;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  return (
    <article className={`score-card rngdle-card rarity-${score.rarity}`}>
      <div className="rngdle-ticket-top">
        <span>RNGdle</span>
        <strong>{score.rarity}</strong>
      </div>
      <div
        aria-label={`Roll ${score.roll}`}
        className="rngdle-roll"
        style={{ gridTemplateColumns: `repeat(${score.roll.length}, minmax(0, 1fr))` }}
      >
        {score.roll.split("").map((digit, index) => <span key={`${digit}-${index}`}>{digit}</span>)}
      </div>
      <div className="rngdle-prize">
        <span>Energy points</span>
        <strong>{formatScore(score.score)} <small>EP</small></strong>
      </div>
      <div className="rngdle-details">
        <span>{score.percentile
          ? `${score.percentile.direction === "top" ? "Top" : "Bottom"} ${score.percentile.value}%`
          : "Unranked roll"}</span>
        <span>{score.traitCount ? `${score.traitCount}+ traits` : "Traits hidden"}</span>
      </div>
      <ScoreCardFooter deleting={deleting} isAdmin={isAdmin} onDelete={onDelete} score={score} />
    </article>
  );
}

function FoodGuessrCard({
  score,
  deleting,
  isAdmin,
  onDelete,
}: {
  score: FoodGuessrScore;
  deleting: boolean;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  const percentage = Math.min(100, Math.round((score.score / score.maxScore) * 100));
  return (
    <article className="score-card foodguessr-card">
      <div className="food-card-heading">
        <div>
          <span>FoodGuessr</span>
          <strong>Daily tasting</strong>
        </div>
        <span>{formatShortDate(score.playedAt)}</span>
      </div>
      <div className="food-total">
        <strong>{formatScore(score.score)}</strong>
        <span>/ {formatScore(score.maxScore)}</span>
      </div>
      <div aria-label={`${percentage}% of the maximum score`} className="food-score-meter">
        <span style={{ transform: `scaleX(${percentage / 100})` }} />
      </div>
      <ol className="food-rounds">
        {score.rounds.map((round, index) => (
          <li key={index}>
            <span>0{index + 1}</span>
            <strong>{formatScore(round)}</strong>
          </li>
        ))}
      </ol>
      <div className={`food-average ${score.averageDelta !== undefined && score.averageDelta < 0 ? "below" : ""}`}>
        {score.averageDelta === undefined
          ? "Daily average unavailable"
          : `${score.averageDelta >= 0 ? "+" : "−"}${formatScore(Math.abs(score.averageDelta))} vs daily average`}
      </div>
      <ScoreCardFooter deleting={deleting} isAdmin={isAdmin} onDelete={onDelete} score={score} />
    </article>
  );
}

function ScoreCardFooter({
  score,
  deleting,
  isAdmin,
  onDelete,
}: {
  score: GameScore;
  deleting: boolean;
  isAdmin: boolean;
  onDelete: () => void;
}) {
  return (
    <footer className="score-card-footer" title={score.message.messageText}>
      <span>
        <strong>{score.message.senderDisplayName}</strong>
        <time dateTime={new Date(score.message.timestamp).toISOString()}>
          {formatMessageTime(score.message.timestamp)}
        </time>
      </span>
      {isAdmin && (
        <button
          aria-label={`Delete score from ${score.message.senderDisplayName}`}
          disabled={deleting}
          onClick={() => {
            if (window.confirm("Permanently delete the chat message behind this score?")) onDelete();
          }}
        >
          {deleting ? "…" : "Delete"}
        </button>
      )}
    </footer>
  );
}

function formatScore(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatShortDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(timestamp);
}

function formatMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
