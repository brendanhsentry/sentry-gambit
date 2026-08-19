"use client";

import { useEffect, useState } from "react";
import { type AuthUser } from "../auth";
import { TopBar } from "../TopBar";

export function LeaderboardView() {
  const [players, setPlayers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/leaderboard?limit=100")
      .then(async (response) => {
        if (!response.ok) throw new Error("Leaderboard unavailable");
        const data = (await response.json()) as { players: AuthUser[] };
        if (active) setPlayers(data.players);
      })
      .catch(() => {
        if (active) setError("The leaderboard is unavailable right now.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="app-shell archive-shell">
      <TopBar />

      <section className="leaderboard-page">
        <span className="panel-kicker">RATED PLAY</span>
        <h1>Leaderboard</h1>

        {loading ? (
          <div className="archive-empty">
            <span>♟</span>
            <p>Tallying the standings…</p>
          </div>
        ) : error ? (
          <div className="archive-empty">
            <span>♟</span>
            <p>{error}</p>
          </div>
        ) : players.length === 0 ? (
          <div className="archive-empty">
            <span>♟</span>
            <p>No rated games yet. Sign in and play one to claim the top spot.</p>
          </div>
        ) : (
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Rating</th>
                <th>W</th>
                <th>D</th>
                <th>L</th>
                <th>Games</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player, index) => (
                <tr key={player.username}>
                  <td className="leaderboard-rank">{index + 1}</td>
                  <td className="leaderboard-name">{player.username}</td>
                  <td className="leaderboard-rating">{player.rating}</td>
                  <td>{player.wins}</td>
                  <td>{player.draws}</td>
                  <td>{player.losses}</td>
                  <td>{player.ratedGames}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
