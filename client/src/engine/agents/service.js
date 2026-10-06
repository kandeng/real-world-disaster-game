// engine/agents/service.js — E6.1: the AgentRuntime Cordis Service.
//
// The thin Cordis glue around the pure createAgentRuntime core. It provides the
// 'agents' service on the core worker's root context, mounts the deterministic
// tick as a clock phase (step -> runtime.step, frame -> runtime.flush), and
// bridges the agents-family command (agents.order) from the databus into the
// runtime. Outbound, the runtime's emit(type, payload) is re-emitted on the bus
// (type '.' -> '/'), where the family bridge turns it into a wire envelope — the
// SAME path the fire driver uses (ctx.emit('fire/delta', ...)), so the one rule
// holds and package code never touches a browser API.
//
// Mounted by the core worker for EVERY package, but inert AND silent when the
// roster is empty (see runtime.flush), so a package that doesn't use agents —
// the legacy fire demo — is byte-for-byte unaffected on the wire.
//
// Cordis 4 forks a child context per service and ONLY exposes the declared
// services on it, so 'clock' (the tick scheduler) and 'timer' (disposal-aware
// ctx.setTimeout the clock relies on) MUST be declared here. Both are mounted
// before this service in the core worker's boot().

import { Service } from '@deepseek-ai/cordis';
import { createAgentRuntime } from './runtime.js';
import { loadAgentPackage } from './loadPackage.js';

// E6.8: the worker discovers a package's agent entry points (its package.json)
// and hands them to the runtime THROUGH this module-scoped slot. Cordis 4 forks a
// child context per service and the worker cannot reliably reach the forked
// instance to call a method on it, so the manifest is parked here BEFORE
// root.plugin(AgentRuntime) and consumed exactly once by the constructor. A
// package with no agents never sets it, so the runtime stays inert and silent —
// the legacy fire path is byte-for-byte unaffected. This file names no domain:
// it forwards whatever manifest the worker resolved.
let pendingManifest = null;
export function setAgentPackageManifest(manifest) { pendingManifest = manifest || null; }

export class AgentRuntime extends Service {
  static inject = ['clock', 'timer'];

  constructor(ctx) {
    super(ctx, 'agents');
    this.ctx_ = ctx;

    // The pure core. Its emit(type, payload) hops onto the databus; the family
    // bridge (mounted in the worker) re-emits it as a wire envelope.
    this.runtime = createAgentRuntime({
      emit: (type, payload) => ctx.emit(type.replaceAll('.', '/'), payload),
      stepS: ctx.clock?.stepS,
    });

    // The deterministic tick rides the fast clock: many steps per frame, then
    // one batched flush. Empty roster => the phase is a cheap no-op.
    ctx.clock.addPhase({
      step: (dt) => this.runtime.step(dt),
      frame: () => this.runtime.flush(),
    });

    // External intents (a human commander's order, a VLM suggestion) arrive as
    // the agents-family command and are routed into the target agent's proxy.
    ctx.on('cmd/agents.order', (m) => this.runtime.order(m?.agentId, m?.intent));

    // E6.8: load the package's agents (environment + capabilities + roster) via
    // the GENERIC loader. Fire-and-forget: the loader is async (it dynamically
    // imports package modules) but the clock phase is already mounted, so the
    // runtime simply stays empty — a cheap no-op tick — until the import
    // resolves. Degrade never break: loadAgentPackage records any per-module
    // failure as a registry note; a thrown error is surfaced on the bus as a core
    // 'error' event (the same forked-ctx.emit path the fire driver uses), never
    // fatal to the session.
    const manifest = pendingManifest;
    pendingManifest = null;
    if (manifest) {
      loadAgentPackage(this.runtime, manifest).catch((err) => {
        ctx.emit('error', { message: `agents: package load failed: ${String((err && err.message) || err)}` });
      });
    }
  }
}
