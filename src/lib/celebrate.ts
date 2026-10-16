/** A short burst of confetti over the page (no library); removes itself when done. */
export function confetti(durationMs = 2600) {
  if (typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.remove();
  ctx.scale(dpr, dpr);
  const colors = ["#ec4899", "#8b5cf6", "#06b6d4", "#f59e0b", "#10b981", "#3b82f6", "#f43f5e"];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bits = Array.from({ length: 180 }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * 120,
    y: H * 0.55,
    vx: (Math.random() - 0.5) * 16,
    vy: -9 - Math.random() * 12,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    c: colors[i % colors.length],
  }));
  const start = performance.now();
  const frame = (t: number) => {
    const age = t - start;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.35;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / durationMs);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (age < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** A soft two-note chime (Web Audio, no file). */
export function chime() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    [660, 880].forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ac.currentTime + i * 0.18;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 1);
    });
    setTimeout(() => void ac.close(), 1600);
  } catch {
    /* no audio */
  }
}

/** Asks once for browser notifications (only from a click). */
export function askNotifications() {
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* unsupported */
  }
}

export function notify(title: string, body: string) {
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, icon: "/level-icon-180.png" });
  } catch {
    /* unsupported */
  }
}
