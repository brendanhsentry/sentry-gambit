export type OpeningLesson = {
  id: string;
  opening: string;
  variation: string;
  side: "w" | "b";
  summary: string;
  keyIdea: string;
  line: string[];
  notes: string[];
};

export const OPENING_LESSONS: OpeningLesson[] = [
  {
    id: "london-classical",
    opening: "London System",
    variation: "Classical setup · as White",
    side: "w",
    summary: "Build the London against Black's natural ...d5 and ...Bd6 setup.",
    keyIdea: "Meet ...Bd6 with Bxd6. Black recaptures with the queen, while you complete c3 and Nbd2.",
    line: [
      "d2d4", "d7d5", "g1f3", "g8f6", "c1f4", "e7e6", "e2e3", "f8d6",
      "f4d6", "d8d6", "c2c3", "e8g8", "b1d2",
    ],
    notes: [
      "Claim the center with d4.",
      "Black mirrors with ...d5.",
      "Nf3 supports d4 and keeps the f-pawn free.",
      "Black develops normally.",
      "Bf4 is the London bishop, developed outside the pawn chain.",
      "Black supports the center with ...e6.",
      "e3 opens your dark-squared bishop and reinforces d4.",
      "...Bd6 challenges your active bishop.",
      "Exchange bishops before Black can gain a tempo with ...Bxf4.",
      "Black's queen recaptures.",
      "c3 makes d4 harder to attack and prepares a stable center.",
      "Black castles.",
      "Nbd2 completes the core London setup.",
    ],
  },
  {
    id: "sicilian-najdorf",
    opening: "Sicilian Defense",
    variation: "Najdorf setup · as Black",
    side: "b",
    summary: "Reach the Najdorf with ...a6, then challenge White's center with ...e5.",
    keyIdea: "The moves ...a6 and ...e5 define the plan: control b5, then make White's d4-knight decide where it belongs.",
    line: [
      "e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6",
      "b1c3", "a7a6", "c1e3", "e7e5",
    ],
    notes: [
      "White claims space with e4.",
      "...c5 is the Sicilian: fight for d4 from the side.",
      "White develops toward the center.",
      "...d6 reinforces e5 and prepares development.",
      "White challenges the center immediately.",
      "...cxd4 creates the characteristic open Sicilian position.",
      "White recaptures with the knight.",
      "...Nf6 attacks e4 and develops with tempo.",
      "White supports the center with Nc3.",
      "...a6 is the Najdorf move: take b5 away and prepare queenside play.",
      "Be3 is a common attacking setup.",
      "...e5 hits the knight on d4 and claims central space.",
    ],
  },
];
