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

type ExploreResult = {
  answer: string;
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
          <h1>Ask your chess history.</h1>
          <p>
            Pawn Patrol turns your completed Stockfish reviews into structured
            Sentry logs, then searches them for patterns only you can see.
          </p>
        </div>

        <form className="explore-form" onSubmit={ask}>
          <label htmlFor="explore-question">Question</label>
          <div className="explore-input-row">
            <input
              id="explore-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={240}
              placeholder="How do I play against the Sicilian?"
            />
            <button type="submit" disabled={loading || !question.trim()}>
              {loading ? "Searching…" : "Ask Sentry"}
            </button>
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
