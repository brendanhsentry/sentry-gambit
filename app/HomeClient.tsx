"use client";

import dynamic from "next/dynamic";

const ChessRoom = dynamic(
  () => import("./ChessRoom").then((module) => module.ChessRoom),
  { ssr: false },
);

export function HomeClient() {
  return <ChessRoom />;
}
