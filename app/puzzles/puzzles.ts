export type Puzzle = {
  id: string;
  title: string;
  theme: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  fen: string;
  line: string[];
  prompt: string;
  hint: string;
  explanation: string;
};

export const PUZZLES: Puzzle[] = [
  {
    id: "back-rank-bell",
    title: "Back-rank bell",
    theme: "Mate in one",
    difficulty: "Beginner",
    fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
    line: ["e1e8"],
    prompt: "White to move. Ring the back rank.",
    hint: "The pawns around the king leave it no flight square.",
    explanation: "Re8# seals every escape along the boxed-in back rank.",
  },
  {
    id: "night-watch",
    title: "Night watch",
    theme: "Smothered mate",
    difficulty: "Beginner",
    fen: "6rk/6pp/8/4N3/8/8/8/6K1 w - - 0 1",
    line: ["e5f7"],
    prompt: "White to move. The king's own guard is in the way.",
    hint: "A knight can check without opening a path to the king.",
    explanation: "Nf7# attacks h8 while the rook and pawns smother their king.",
  },
  {
    id: "four-move-fire",
    title: "Four-move fire",
    theme: "Opening mate",
    difficulty: "Beginner",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
    line: ["d8h4"],
    prompt: "Black to move. Punish the weakened diagonal.",
    hint: "White has exposed the route from h4 to e1.",
    explanation: "Qh4# uses the open diagonal to deliver the fastest possible mate.",
  },
  {
    id: "royal-fork",
    title: "Royal fork",
    theme: "Win the queen",
    difficulty: "Intermediate",
    fen: "2q1k3/8/8/5N2/8/8/8/6K1 w - - 0 1",
    line: ["f5d6", "e8d8", "d6c8"],
    prompt: "White to move. Check first, collect second.",
    hint: "Find a knight check that also attacks c8.",
    explanation: "Nd6+ forces the king aside, then Nxc8 wins the queen.",
  },
  {
    id: "new-queen",
    title: "New queen",
    theme: "Promotion",
    difficulty: "Intermediate",
    fen: "6k1/4P3/8/8/8/8/8/6K1 w - - 0 1",
    line: ["e7e8q"],
    prompt: "White to move. Promote with tempo.",
    hint: "Choose the promotion that immediately checks the king.",
    explanation: "e8=Q+ creates the strongest piece and gains a move with check.",
  },
  {
    id: "legal-legacy",
    title: "Légal's legacy",
    theme: "Queen sacrifice",
    difficulty: "Advanced",
    fen: "r2qkbnr/ppp2ppp/2np4/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5",
    line: ["f3e5", "g4d1", "c4f7", "e8e7", "c3d5"],
    prompt: "White to move. Ignore the queen and hunt the king.",
    hint: "The pinned knight can move because the attack ends in mate.",
    explanation: "Nxe5 invites Bxd1, but Bxf7+ and Nd5# reveal the queen as bait.",
  },
];
