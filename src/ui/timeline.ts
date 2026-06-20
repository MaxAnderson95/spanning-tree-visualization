import { MAX_SPEED, MIN_SPEED, type App } from "../app.ts";
import { el, formatTime } from "./format.ts";

const formatSpeed = (s: number): string => `${parseFloat(s.toFixed(3))}×`;

/**
 * A scrubber whose track is painted with history — failures as red ticks,
 * restores as green, topology-change floods as amber notches — over a
 * logarithmic, bidirectional speed slider (slow to study a handshake, fast to
 * skip STP's long countdowns).
 */
export class Timeline {
  private readonly playBtn: HTMLButtonElement;
  private readonly speedSlider: HTMLInputElement;
  private readonly speedReadout: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly tape: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly wrap: HTMLElement;
  private readonly liveBtn: HTMLButtonElement;

  private readonly app: App;
  private dragging = false;
  private wasPaused = false;
  private lastPaintAt = 0;
  private lastDuration = -1;
  private lastFrames = -1;

  constructor(container: HTMLElement, app: App) {
    this.app = app;
    container.classList.add("panel");

    const transport = el("div", "transport");
    this.playBtn = el("button", "play-btn", "❚❚");
    this.playBtn.title = "Play/pause (space)";
    this.playBtn.addEventListener("click", () => app.togglePause());

    const speedCtl = el("div", "speed-ctl");
    this.speedSlider = el("input") as HTMLInputElement;
    this.speedSlider.type = "range";
    this.speedSlider.min = String(Math.log10(MIN_SPEED));
    this.speedSlider.max = String(Math.log10(MAX_SPEED));
    this.speedSlider.step = "any";
    this.speedSlider.value = String(Math.log10(app.speed));
    this.speedSlider.setAttribute("aria-label", "playback speed");
    this.speedSlider.addEventListener("input", () =>
      app.setSpeed(10 ** Number(this.speedSlider.value)),
    );
    this.speedReadout = el("span", "speed-readout", formatSpeed(app.speed));
    speedCtl.append(this.speedSlider, this.speedReadout);
    transport.append(this.playBtn, speedCtl);

    this.readout = el("div", "time-readout", "00:00.000");

    this.wrap = el("div", "tape-wrap");
    this.tape = el("canvas") as HTMLCanvasElement;
    this.overlay = el("canvas") as HTMLCanvasElement;
    this.wrap.append(this.tape, this.overlay);
    this.bindScrub();

    this.liveBtn = el("button", "live-btn");
    this.liveBtn.append(el("span", "pulse"), el("span", "", "LIVE"));
    this.liveBtn.title = "Jump to now (L)";
    this.liveBtn.addEventListener("click", () => app.goLive());

    container.append(transport, this.readout, this.wrap, this.liveBtn);
    new ResizeObserver(() => {
      this.lastDuration = -1;
      this.resizeCanvas(this.tape);
      this.resizeCanvas(this.overlay);
    }).observe(this.wrap);
    this.resizeCanvas(this.tape);
    this.resizeCanvas(this.overlay);
  }

  update(): void {
    const app = this.app;
    this.playBtn.textContent = app.paused ? "▶" : "❚❚";
    this.readout.textContent = formatTime(app.playhead);
    this.liveBtn.classList.toggle("is-live", app.live && !app.paused);

    const sliderLog = Number(this.speedSlider.value);
    if (Math.abs(sliderLog - Math.log10(app.speed)) > 1e-6) {
      this.speedSlider.value = String(Math.log10(app.speed));
    }
    this.speedReadout.textContent = formatSpeed(app.speed);

    const now = performance.now();
    const frames = app.sim.frames.length;
    if (
      this.lastDuration < 0 ||
      (now - this.lastPaintAt > 250 &&
        (app.sim.duration !== this.lastDuration || frames !== this.lastFrames))
    ) {
      this.paintTape();
      this.lastPaintAt = now;
      this.lastDuration = app.sim.duration;
      this.lastFrames = frames;
    }
    this.paintOverlay();
  }

  // -------------------------------------------------------------------------

  private timeToX(t: number, width: number): number {
    const { horizon, duration } = this.app.sim;
    const span = Math.max(duration - horizon, 0.001);
    return ((t - horizon) / span) * width;
  }

  private xToTime(x: number, width: number): number {
    const { horizon, duration } = this.app.sim;
    const span = Math.max(duration - horizon, 0.001);
    return horizon + (Math.min(Math.max(x, 0), width) / width) * span;
  }

  private paintTape(): void {
    const ctx = this.tape.getContext("2d");
    if (!ctx) return;
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(0, 0, w, h);

    for (const frame of this.app.sim.frames) {
      const x = this.timeToX(frame.time, w);
      const cause = frame.cause.kind;
      if (
        cause === "linkCut" ||
        cause === "powerOff" ||
        cause === "portShut" ||
        cause === "split" ||
        cause === "removeDevice"
      ) {
        ctx.fillStyle = "#ff5a52";
        ctx.fillRect(x - 0.5, 0, 1.5, h);
      } else if (
        cause === "linkRestore" ||
        cause === "powerOn" ||
        cause === "heal" ||
        cause === "restart"
      ) {
        ctx.fillStyle = "#35d07f";
        ctx.fillRect(x - 0.5, 0, 1.5, h);
      } else if (cause === "setMode") {
        ctx.fillStyle = "#5cc8ff";
        ctx.fillRect(x - 0.5, 0, 1.5, h);
      }
      if (frame.events.some((e) => e.event.type === "topologyChange")) {
        ctx.fillStyle = "rgba(244,183,61,0.7)";
        ctx.fillRect(x, h - 6, 1, 6);
      }
    }
  }

  private paintOverlay(): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const x = this.timeToX(this.app.playhead, w);
    ctx.fillStyle = "rgba(220,230,247,0.95)";
    ctx.fillRect(x - 0.75, 0, 1.5, h);
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }

  private bindScrub(): void {
    const onMove = (e: PointerEvent): void => {
      const rect = this.wrap.getBoundingClientRect();
      this.app.scrub(this.xToTime(e.clientX - rect.left, rect.width));
    };
    this.wrap.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.wasPaused = this.app.paused;
      this.app.paused = true;
      this.wrap.setPointerCapture(e.pointerId);
      onMove(e);
    });
    this.wrap.addEventListener("pointermove", (e) => {
      if (this.dragging) onMove(e);
    });
    this.wrap.addEventListener("pointerup", () => {
      this.dragging = false;
      this.app.paused = this.wasPaused;
    });
  }

  private resizeCanvas(canvas: HTMLCanvasElement): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, this.wrap.clientWidth * dpr);
    canvas.height = Math.max(1, this.wrap.clientHeight * dpr);
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
