let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function playTone(frequency: number, duration: number, type: OscillatorType = "sine", volume = 0.08) {
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(c.currentTime);
  osc.stop(c.currentTime + duration);
}

export function playGreet() {
  playTone(523, 0.12, "sine", 0.06);
  setTimeout(() => playTone(659, 0.18, "sine", 0.05), 100);
}

export function playNotice() {
  playTone(440, 0.08, "sine", 0.05);
  setTimeout(() => playTone(554, 0.1, "sine", 0.04), 60);
}

export function playCelebrate() {
  playTone(523, 0.1, "sine", 0.06);
  setTimeout(() => playTone(659, 0.1, "sine", 0.05), 80);
  setTimeout(() => playTone(784, 0.2, "sine", 0.04), 160);
}

export function playCurious() {
  playTone(330, 0.15, "triangle", 0.04);
  setTimeout(() => playTone(392, 0.1, "triangle", 0.03), 120);
}

export function playSurprised() {
  playTone(698, 0.06, "square", 0.03);
  setTimeout(() => playTone(554, 0.12, "square", 0.02), 50);
}

export function playSuccess() {
  playTone(523, 0.1, "sine", 0.05);
  setTimeout(() => playTone(659, 0.1, "sine", 0.04), 100);
  setTimeout(() => playTone(784, 0.25, "sine", 0.03), 200);
}

export function playError() {
  playTone(330, 0.2, "sawtooth", 0.03);
  setTimeout(() => playTone(262, 0.3, "sawtooth", 0.02), 150);
}

export function playWake() {
  playTone(440, 0.08, "sine", 0.04);
  setTimeout(() => playTone(554, 0.1, "sine", 0.03), 80);
  setTimeout(() => playTone(659, 0.15, "sine", 0.02), 160);
}

export function click() {
  playTone(880, 0.04, "sine", 0.03);
}

export function playDrop() {
  playTone(260, 0.15, "triangle", 0.04);
  setTimeout(() => playTone(440, 0.2, "sine", 0.03), 120);
}
