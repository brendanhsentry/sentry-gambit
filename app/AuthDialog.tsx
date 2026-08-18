"use client";

import { useState } from "react";

export function AuthDialog({
  onClose,
  signIn,
  register,
}: {
  onClose: () => void;
  signIn: (username: string, password: string) => Promise<unknown>;
  register: (username: string, password: string) => Promise<unknown>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(action: typeof signIn) {
    setBusy(true);
    setError("");
    try {
      await action(username.trim(), password);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-label="Sign in">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(signIn);
        }}
      >
        <span className="lobby-kicker">OPTIONAL SIGN IN</span>
        <h2>Join the leaderboard.</h2>
        <p>
          Signed-in games against other members or the Patrol bots count toward
          your rating. Guests can keep playing without an account.
        </p>
        <label>
          <span>Name</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. magnus"
            maxLength={20}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 6 characters"
            maxLength={100}
          />
        </label>
        {error && <p className="auth-error">{error}</p>}
        <div className="auth-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !username || !password}
          >
            Sign in <span>→</span>
          </button>
          <button
            type="button"
            disabled={busy || !username || !password}
            onClick={() => void submit(register)}
          >
            Create account
          </button>
        </div>
        <button type="button" className="auth-cancel" onClick={onClose}>
          Maybe later
        </button>
      </form>
    </div>
  );
}
