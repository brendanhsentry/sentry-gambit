let ctx: AudioContext | null = null;

function audioContext() {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  ac: AudioContext,
  freq: number,
  at: number,
  duration: number,
  peak: number,
  type: OscillatorType,
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(at);
  osc.stop(at + duration + 0.05);
}

export function playMove() {
  const ac = audioContext();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 520, t, 0.05, 0.09, "triangle");
  tone(ac, 190, t, 0.09, 0.18, "sine");
}

export function playCapture() {
  const ac = audioContext();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 330, t, 0.045, 0.1, "square");
  tone(ac, 120, t, 0.12, 0.26, "sine");
}

export function playCheck() {
  const ac = audioContext();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 880, t, 0.08, 0.07, "sine");
  tone(ac, 659, t + 0.09, 0.12, 0.07, "sine");
}

export function playGameEnd() {
  const ac = audioContext();
  if (!ac) return;
  const t = ac.currentTime;
  [392, 494, 587, 784].forEach((freq, i) =>
    tone(ac, freq, t + i * 0.11, 0.18, 0.08, "triangle"),
  );
}
