"use client";

import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type {
  Color,
  Dests,
  Key,
  SquareClasses,
} from "@lichess-org/chessground/types";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { useLayoutEffect, useRef } from "react";

type ChessgroundBoardProps = {
  fen: string;
  orientation: Color;
  turnColor: Color;
  check: Color | false;
  lastMove?: Key[];
  movableColor?: Color;
  dests?: Dests;
  premoveEnabled?: boolean;
  customSquareClasses?: SquareClasses;
  autoShapes?: DrawShape[];
  onMove?: (from: Key, to: Key) => void;
  resetKey?: string;
  layoutKey?: string;
  viewOnly?: boolean;
  ariaLabel: string;
};

export function ChessgroundBoard({
  fen,
  orientation,
  turnColor,
  check,
  lastMove,
  movableColor,
  dests,
  premoveEnabled = false,
  customSquareClasses,
  autoShapes,
  onMove,
  resetKey,
  layoutKey,
  viewOnly = false,
  ariaLabel,
}: ChessgroundBoardProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const onMoveRef = useRef(onMove);
  const layoutKeyRef = useRef(layoutKey);

  useLayoutEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useLayoutEffect(() => {
    if (!elementRef.current) return;
    apiRef.current = Chessground(elementRef.current, {
      coordinates: true,
      coordinatesOnSquares: true,
      disableContextMenu: true,
      drawable: {
        enabled: false,
        visible: true,
        brushes: {
          green: { key: "g", color: "#15781b", opacity: 1, lineWidth: 10 },
          red: { key: "r", color: "#882020", opacity: 1, lineWidth: 10 },
          blue: { key: "b", color: "#003088", opacity: 1, lineWidth: 10 },
          yellow: { key: "y", color: "#968ba0", opacity: 1, lineWidth: 10 },
        },
      },
      draggable: { showGhost: true },
      premovable: { enabled: false, showDests: true },
      animation: { enabled: true, duration: 180 },
      movable: {
        free: false,
        showDests: true,
        events: {
          after: (from, to) => onMoveRef.current?.(from, to),
        },
      },
    });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.set({
      fen,
      orientation,
      turnColor,
      check,
      lastMove,
      highlight: { custom: customSquareClasses },
      movable: { color: movableColor, dests },
      premovable: { enabled: premoveEnabled },
      draggable: { enabled: !viewOnly },
      selectable: { enabled: !viewOnly },
    });
    api.setAutoShapes(autoShapes ?? []);
    if (!premoveEnabled) api.cancelPremove();
    else if (movableColor === turnColor) api.playPremove();
  }, [
    autoShapes,
    check,
    customSquareClasses,
    dests,
    fen,
    lastMove,
    movableColor,
    orientation,
    premoveEnabled,
    resetKey,
    turnColor,
    viewOnly,
  ]);

  useLayoutEffect(() => {
    if (layoutKeyRef.current === layoutKey) return;
    layoutKeyRef.current = layoutKey;
    apiRef.current?.redrawAll();
  }, [layoutKey]);

  return (
    <div
      className="chessboard"
      role="img"
      aria-label={ariaLabel}
    >
      <div ref={elementRef} className="chessground-surface cg-wrap" />
    </div>
  );
}
