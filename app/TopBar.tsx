"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { AuthDialog } from "./AuthDialog";

const NAV = [
  { href: "/", label: "Play" },
  { href: "/puzzles", label: "Puzzles" },
  { href: "/games", label: "Past games" },
  { href: "/explore", label: "Explore" },
  { href: "/leaderboard", label: "Leaderboard" },
];

export function TopBar({
  auth,
  action,
  onBrandClick,
}: {
  auth?: ReturnType<typeof useAuth>;
  action?: ReactNode;
  onBrandClick?: (event: React.MouseEvent) => void;
}) {
  const fallbackAuth = useAuth();
  const { user, signIn, register, signOut } = auth ?? fallbackAuth;
  const pathname = usePathname();
  const [authOpen, setAuthOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="topbar">
      <Link
        className="brand"
        href="/"
        aria-label="Pawn Patrol home"
        onClick={onBrandClick}
      >
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
      <nav className="topbar-nav" aria-label="Main">
        {NAV.map((item) => {
          const current =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={current ? "is-current" : undefined}
              aria-current={current ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="topbar-actions">
        {action}
        {user ? (
          <div className="user-menu" ref={menuRef}>
            <button
              className="user-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {user.username} · {user.rating}
              <svg
                width="9"
                height="9"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m2 3.5 3 3 3-3" />
              </svg>
            </button>
            {menuOpen && (
              <div className="user-menu-sheet" role="menu">
                <div className="user-menu-record">
                  {user.wins}W · {user.losses}L · {user.draws}D
                </div>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    signOut();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="text-button" onClick={() => setAuthOpen(true)}>
            Sign in
          </button>
        )}
      </div>
      {authOpen && (
        <AuthDialog
          onClose={() => setAuthOpen(false)}
          signIn={signIn}
          register={register}
        />
      )}
    </header>
  );
}
