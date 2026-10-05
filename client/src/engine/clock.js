// engine/clock.js — E2: the fast clock. A fixed-step tick scheduler as a
// Cordis service ('clock'), owned by the core worker. Deterministic agents
// (asset drivers) register phases; the clock is the ONLY thing that advances
// simulation time.
//
// Phase contract — clock.addPhase({ step, frame }):
//   step(dtSim)      called once per fixed step (this.stepS sim seconds);
//                    MUST be synchronous and deterministic (seeded).
//   frame(nowMs, n)  called once per scheduler frame AFTER n steps ran
//                    (n may be 0) — for flushing deltas, periodic state
//                    snapshots and outcome checks.
//
// Speed is wire-controlled: the service itself listens for the core-family
// command 'setSpeed' on the databus ({ type:'setSpeed', speed } ->
// bus 'cmd/setSpeed'), so any authorized sender (host, later an AI agent
// worker) adjusts it through the one envelope taxonomy.
//
// Timers are ctx.setTimeout from @deepseek-ai/cordis-plugin-timer — disposal
// aware, so root-context teardown kills the loop (E0-proven). TimerService
// must be mounted BEFORE this service.

import { Service } from '@deepseek-ai/cordis';

export class ClockService extends Service {
  static STEP_S = 0.5;          // fixed sim step (s)
  static FRAME_MS = 100;        // scheduler frame period (ms, wall clock)
  static MAX_STEPS_PER_FRAME = 4000;  // runaway guard

  // Cordis 4 forks a child context per plugin/service and ONLY exposes the
  // declared services on it. The clock schedules frames with ctx.setTimeout,
  // a mixin of the timer service, so 'timer' MUST be declared here — without
  // it, this.ctx_.setTimeout throws 'cannot get property "timer" without
  // inject'. (Mounted after TimerService in the core worker.)
  static inject = ['timer'];

  constructor(ctx) {
    super(ctx, 'clock');
    this.ctx_ = ctx;
    this.speed = 4;             // sim seconds per real second
    this.stepS = ClockService.STEP_S;
    this.phases = [];
    this.running = false;
    this.timer = 0;
    this.acc = 0;
    this.last = 0;

    ctx.on('cmd/setSpeed', (m) => this.setSpeed(m?.speed));
  }

  setSpeed(speed) {
    if (Number.isFinite(speed) && speed > 0) this.speed = speed;
  }

  addPhase(phase) {
    this.phases.push(phase);
    return () => {
      const i = this.phases.indexOf(phase);
      if (i >= 0) this.phases.splice(i, 1);
    };
  }

  start(speed) {
    this.setSpeed(speed);
    if (this.running) return;
    this.running = true;
    this.acc = 0;
    this.last = performance.now();
    this.ensure_();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
  }

  ensure_() {
    if (!this.timer && this.running) {
      this.timer = this.ctx_.setTimeout(() => this.frame_(), ClockService.FRAME_MS);
    }
  }

  frame_() {
    this.timer = 0;
    if (!this.running) return;
    const now = performance.now();
    this.acc += ((now - this.last) / 1000) * this.speed;
    this.last = now;
    let n = 0;
    while (this.acc >= this.stepS && n < ClockService.MAX_STEPS_PER_FRAME) {
      for (const p of this.phases) p.step?.(this.stepS);
      this.acc -= this.stepS;
      n++;
    }
    for (const p of this.phases) p.frame?.(now, n);
    this.ensure_();
  }
}
