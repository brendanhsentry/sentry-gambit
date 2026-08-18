const MUTE_KEY = "pawn-patrol-muted";
let muted =
  typeof window !== "undefined" &&
  window.localStorage.getItem(MUTE_KEY) === "1";

export function soundsMuted() {
  return muted;
}

export function setSoundsMuted(next: boolean) {
  muted = next;
  try {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  } catch {
    // Sounds still mute for this visit even if the preference cannot persist.
  }
}

const SOUND_FILES = {
  move: "/sounds/move.mp3",
  capture: "/sounds/capture.mp3",
  check: "/sounds/check.mp3",
  end: "/sounds/game-end.mp3",
} as const;

const cache = new Map<string, HTMLAudioElement>();

function play(name: keyof typeof SOUND_FILES) {
  if (muted || typeof window === "undefined") return;
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(SOUND_FILES[name]);
    cache.set(name, audio);
  }
  audio.currentTime = 0;
  void audio.play().catch(() => {
    // Autoplay can be blocked before the first user gesture.
  });
}

export const playMove = () => play("move");
export const playCapture = () => play("capture");
export const playCheck = () => play("check");
export const playGameEnd = () => play("end");
