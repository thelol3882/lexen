/**
 * @thelol3882/lexen-live/agent — public entry point for the headless loop.
 *
 * Re-exports the overflow-detection/auto-correction loop and all its public types
 * so consumers can import from a single entry point:
 *
 *   import { runOverflowLoop } from '@thelol3882/lexen-live/agent';
 *
 * Dev-only: this entire module is excluded from the production bundle by
 * the agreed literal `process.env.NODE_ENV !== 'production'` gate in any
 * importer, and is a devDependency, so it never enters the prod dependency
 * closure.  The verify-no-markers.mjs script asserts this after `next build`.
 */

export {
  runOverflowLoop,
  type OverflowLoopOptions,
  type OverflowLoopReport,
  type EditRecord,
  type GateViolation,
  type AgentEvent,
  type AgentEventKind,
} from './loop.js';
