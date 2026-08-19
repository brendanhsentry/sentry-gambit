"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { authToken } from "../auth";

type Breakdown = {
  opening: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  scorePercent: number;
  avgBlunders: number;
};

type ExploreLog = {
  timestamp: string | null;
  gameId: string | null;
  opening: string;
  color: string | null;
  outcome: string | null;
  score: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  expectedPointsLoss: number;
};

type ExploreResult = {
  answer: string;
  logs: ExploreLog[];
  query: string;
  period: string;
  summary: {
    total: number;
    wins: number;
    losses: number;
    draws: number;
    scorePercent: number;
    avgBlunders: number;
    avgMistakes: number;
    avgInaccuracies: number;
    avgExpectedPointsLoss: number;
    breakdown: Breakdown[];
  };
};

const EXAMPLES = [
  "What have I done historically against the Queen's Gambit?",
  "Which openings do I struggle with?",
  "How do I score as Black?",
];

function logTime(value: string | null) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function browserPlayerKey() {
  const storageKey = "pawn-patrol-player-key";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const created = window.crypto.randomUUID();
  window.localStorage.setItem(storageKey, created);
  return created;
}

export function ExploreView() {
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!cleanQuestion || loading) return;
    setLoading(true);
    setError("");
    try {
      const token = authToken();
      const response = await fetch("/api/explore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          question: cleanQuestion,
          playerKey: browserPlayerKey(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as
        | ExploreResult
        | { error?: string };
      if (!response.ok || !("answer" in data)) {
        throw new Error("error" in data ? data.error : "Explore is unavailable.");
      }
      setResult(data);
    } catch (requestError) {
      setResult(null);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Explore is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app-shell explore-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pawn Patrol home">
          <span className="brand-mark">
            <Image
              src="/pawn-patrol-sentry-correct.png"
              alt=""
              width={30}
              height={30}
              priority
              unoptimized
            />
          </span>
          <span>
            PAWN <em>PATROL</em>
          </span>
        </Link>
        <div className="topbar-note">SENTRY EXPLORE</div>
        <Link className="text-button" href="/">
          Back to tables
        </Link>
      </header>

      <section className="explore-page">
        <div className="explore-intro">
          <span className="panel-kicker">YOUR GAME TELEMETRY</span>
          <h1>Ask Sentry about your games.</h1>
          <p>
            Type a question in plain English. Pawn Patrol searches your private
            game logs, charts the matching history, and shows the events behind
            the answer.
          </p>
        </div>

        <form className="explore-form" onSubmit={ask}>
          <label htmlFor="explore-question">Question</label>
          <div className="explore-prompt-box">
            <textarea
              id="explore-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={240}
              placeholder="How do I play against the Sicilian?"
              rows={3}
            />
            <div className="explore-prompt-actions">
              <span>Natural-language query · Last 90 days</span>
              <button type="submit" disabled={loading || !question.trim()}>
                {loading ? "Searching logs…" : "Search my games"}
              </button>
            </div>
          </div>
          <div className="explore-examples" aria-label="Example questions">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuestion(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </form>

        {error && <div className="explore-error">{error}</div>}

        {result && (
          <div className="explore-results" aria-live="polite">
            <article className="explore-answer">
              <span className="panel-kicker">ANSWER · LAST 90 DAYS</span>
              <p>{result.answer}</p>
            </article>

            {result.summary.total > 0 && (
              <>
                <div className="explore-stats">
                  <div>
                    <strong>{result.summary.total}</strong>
                    <span>Games</span>
                  </div>
                  <div>
                    <strong>{result.summary.scorePercent.toFixed(0)}%</strong>
                    <span>Score</span>
                  </div>
                  <div>
                    <strong>
                      {result.summary.wins}–{result.summary.losses}–
                      {result.summary.draws}
                    </strong>
                    <span>W–L–D</span>
                  </div>
                  <div>
                    <strong>{result.summary.avgBlunders.toFixed(1)}</strong>
                    <span>Blunders / game</span>
                  </div>
                </div>

                <div className="explore-charts">
                  <article className="explore-chart-card">
                    <div className="explore-section-heading">
                      <div>
                        <span className="panel-kicker">RESULTS</span>
                        <h2>Match outcomes</h2>
                      </div>
                      <strong>{result.summary.total} games</strong>
                    </div>
                    <div
                      className="explore-result-bar"
                      aria-label={`${result.summary.wins} wins, ${result.summary.draws} draws, ${result.summary.losses} losses`}
                    >
                      <span
                        className="is-win"
                        style={{
                          width: `${(result.summary.wins / result.summary.total) * 100}%`,
                        }}
                      />
                      <span
                        className="is-draw"
                        style={{
                          width: `${(result.summary.draws / result.summary.total) * 100}%`,
                        }}
                      />
                      <span
                        className="is-loss"
                        style={{
                          width: `${(result.summary.losses / result.summary.total) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="explore-chart-legend">
                      <span className="is-win">{result.summary.wins} wins</span>
                      <span className="is-draw">{result.summary.draws} draws</span>
                      <span className="is-loss">{result.summary.losses} losses</span>
                    </div>
                  </article>

                  <article className="explore-chart-card">
                    <div className="explore-section-heading">
                      <div>
                        <span className="panel-kicker">PERFORMANCE</span>
                        <h2>Score by opening</h2>
                      </div>
                    </div>
                    <div className="explore-opening-chart">
                      {result.summary.breakdown.slice(0, 6).map((row) => (
                        <div key={row.opening}>
                          <span title={row.opening}>{row.opening}</span>
                          <div>
                            <i style={{ width: `${row.scorePercent}%` }} />
                          </div>
                          <strong>{row.scorePercent.toFixed(0)}%</strong>
                        </div>
                      ))}
                    </div>
                  </article>
                </div>

                <div className="explore-breakdown">
                  <h2>Opening breakdown</h2>
                  <div className="explore-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Opening family</th>
                          <th>Games</th>
                          <th>W–L–D</th>
                          <th>Score</th>
                          <th>Blunders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.summary.breakdown.map((row) => (
                          <tr key={row.opening}>
                            <td>{row.opening}</td>
                            <td>{row.games}</td>
                            <td>
                              {row.wins}–{row.losses}–{row.draws}
                            </td>
                            <td>{row.scorePercent.toFixed(0)}%</td>
                            <td>{row.avgBlunders.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <section className="explore-logs">
                  <div className="explore-section-heading">
                    <div>
                      <span className="panel-kicker">RELATED SENTRY LOGS</span>
                      <h2>Events behind this answer</h2>
                    </div>
                    <strong>{result.logs.length} shown</strong>
                  </div>
                  {result.logs.length ? (
                    <div className="explore-log-list">
                      {result.logs.map((log, index) => (
                        <article key={`${log.gameId ?? "game"}-${index}`}>
                          <div className="explore-log-head">
                            <code>chess.player.game.completed</code>
                            <time>{logTime(log.timestamp)}</time>
                          </div>
                          <div className="explore-log-main">
                            <div>
                              <strong>{log.opening}</strong>
                              <span>
                                {log.color ?? "unknown color"} · game {log.gameId?.slice(0, 8) ?? "unknown"}
                              </span>
                            </div>
                            <span className={`explore-outcome is-${log.outcome ?? "unknown"}`}>
                              {log.outcome ?? "unknown"}
                            </span>
                          </div>
                          <dl>
                            <div><dt>blunders</dt><dd>{log.blunders}</dd></div>
                            <div><dt>mistakes</dt><dd>{log.mistakes}</dd></div>
                            <div><dt>inaccuracies</dt><dd>{log.inaccuracies}</dd></div>
                            <div><dt>avg EP loss</dt><dd>{(log.expectedPointsLoss * 100).toFixed(1)}%</dd></div>
                          </dl>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="explore-logs-empty">
                      No individual log rows were returned for this query.
                    </p>
                  )}
                </section>
              </>
            )}

            <details className="explore-query">
              <summary>See the Sentry query</summary>
              <code>{result.query}</code>
              <p>
                The server adds your private player identifier and runs this
                against Pawn Patrol&apos;s Logs dataset. No Sentry membership is
                required.
              </p>
            </details>
          </div>
        )}
      </section>
    </main>
  );
}
