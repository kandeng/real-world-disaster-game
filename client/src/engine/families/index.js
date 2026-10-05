// engine/families/index.js — importing this module registers every engine
// protocol family on the global registry (one realm = one registry). Both the
// core worker and the main-thread host import this, so both edges validate
// against the same normative definitions.

export { coreFamily } from './core.js';
export { fireFamily } from './fire.js';
export { agentFamily } from './agent.js';
