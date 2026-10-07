// games/demo-wildfire/agents/drone/reasoning.js — PACKAGE reasoning CONTENT.
//
// A fire-fighting drone's brain, expressed as DATA the engine's generic
// stateMachine interpreter runs. The engine owns the interpreter; this file owns
// the MEANING (scan for fire -> fly to it -> suppress it). Swapping the
// suppression actuator ('dropWater' | 'sprayDryIce') is the only difference
// between a water drone and a dry-ice drone — same table, one parameter.
//
// Guards are PURE and read only the observation (from the scanFire sensor),
// agent.state, and ctx.t/ctx.dt — never Date.now(), never the wall clock, so the
// tick stays deterministic and reproducible by seed.

const ENGAGE_RADIUS_M = 350;     // close enough to suppress instead of flying
const SUPPRESS_RADIUS_M = 400;   // suppression footprint

/**
 * droneFsm(suppression) -> a stateMachine reasoning SPEC ({kind, initial, states}).
 * `suppression` names the actuator this drone uses ('dropWater' | 'sprayDryIce').
 */
export function droneFsm(suppression = 'dropWater') {
  const aim = (obs) => obs?.fire?.hotspot || null;

  const approachIntent = (agent, obs) => {
    const hs = aim(obs);
    return hs ? { type: 'moveTo', lon: hs.lon, lat: hs.lat } : null;
  };
  const suppressIntent = (agent, obs) => {
    const hs = aim(obs);
    return hs ? { type: suppression, lon: hs.lon, lat: hs.lat, radiusM: SUPPRESS_RADIUS_M } : null;
  };

  return {
    kind: 'stateMachine',
    initial: 'scan',
    states: {
      // Hold until the environment reports burning cells.
      scan: {
        on: [{ when: { fact: 'fire.burning', op: '>', value: 0 }, to: 'engage' }],
        intent: null,
      },
      // Fly toward the hotspot; switch to suppress once within engage radius.
      engage: {
        on: [
          { when: { fact: 'fire.burning', op: '==', value: 0 }, to: 'scan' },
          { when: { fact: 'fire.hotspotDistM', op: '<=', value: ENGAGE_RADIUS_M }, to: 'suppress' },
        ],
        intent: approachIntent,
      },
      // Suppress the hotspot; chase if it moves away, stand down if it is out.
      suppress: {
        on: [
          { when: { fact: 'fire.burning', op: '==', value: 0 }, to: 'scan' },
          { when: { fact: 'fire.hotspotDistM', op: '>', value: ENGAGE_RADIUS_M }, to: 'engage' },
        ],
        intent: suppressIntent,
      },
    },
  };
}

export default droneFsm;
