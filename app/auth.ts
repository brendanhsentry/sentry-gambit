"use client";

import { useCallback, useEffect, useState } from "react";

export type AuthUser = {
  username: string;
  rating: number;
  ratedGames: number;
  wins: number;
  losses: number;
  draws: number;
};

const TOKEN_KEY = "pawn-patrol-auth-token";

export function authToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

async function authRequest(path: string, username: string, password: string) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    user?: AuthUser;
    error?: string;
  };
  if (!response.ok || !data.token || !data.user) {
    throw new Error(data.error || "Sign-in is unavailable right now.");
  }
  window.localStorage.setItem(TOKEN_KEY, data.token);
  return data.user;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const token = authToken();
    if (!token) return;
    let active = true;
    void fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 401) {
          window.localStorage.removeItem(TOKEN_KEY);
          return;
        }
        if (!response.ok) return;
        const data = (await response.json()) as { user: AuthUser };
        if (active) setUser(data.user);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const authed = await authRequest("/api/auth/login", username, password);
    setUser(authed);
    return authed;
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const authed = await authRequest("/api/auth/register", username, password);
    setUser(authed);
    return authed;
  }, []);

  const signOut = useCallback(() => {
    const token = authToken();
    if (token) {
      void fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    window.localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, []);

  return { user, signIn, register, signOut };
}
