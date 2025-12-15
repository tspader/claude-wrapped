/**
 * Action queue system for timed, skippable actions.
 * 
 * Actions are pushed to a queue and processed each tick.
 * When done, they're removed. Supports skip (instant complete).
 */

export type EasingFn = (t: number) => number;

// Built-in easings
export const easeLinear: EasingFn = (t) => t;
export const easeInQuad: EasingFn = (t) => t * t;
export const easeOutQuad: EasingFn = (t) => t * (2 - t);
export const easeInOutQuad: EasingFn = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
export const easeOutCubic: EasingFn = (t) => (--t) * t * t + 1;
export const easeInOutCubic: EasingFn = (t) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

// Action definitions (what gets pushed)
export type ActionDef =
  | { type: "lerp"; target: string; to: number; duration: number; easing?: EasingFn }
  | { type: "set"; target: string; value: number }
  | { type: "wait"; duration: number };

// Active action state (internal)
interface ActiveLerp {
  id: number;
  type: "lerp";
  target: string;
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  easing: EasingFn;
}

interface ActiveWait {
  id: number;
  type: "wait";
  duration: number;
  elapsed: number;
}

type ActiveAction = ActiveLerp | ActiveWait;

/**
 * ActionQueue processes timed actions independently.
 * 
 * Usage:
 *   const queue = new ActionQueue(getter, setter);
 *   const id = queue.push({ type: "lerp", target: "camera.x", to: 5, duration: 1 });
 *   // Each frame:
 *   queue.tick(dt);
 *   // Check if specific action is done:
 *   queue.isDone(id);
 *   // Skip specific action:
 *   queue.skip(id);
 *   // Skip all:
 *   queue.skipAll();
 */
export class ActionQueue {
  private actions: ActiveAction[] = [];
  private nextId: number = 1;
  private getter: (target: string) => number;
  private setter: (target: string, value: number) => void;

  constructor(
    getter: (target: string) => number,
    setter: (target: string, value: number) => void
  ) {
    this.getter = getter;
    this.setter = setter;
  }

  /** Push an action, returns its ID */
  push(def: ActionDef): number {
    const id = this.nextId++;

    switch (def.type) {
      case "lerp":
        this.actions.push({
          id,
          type: "lerp",
          target: def.target,
          from: this.getter(def.target),
          to: def.to,
          duration: def.duration,
          elapsed: 0,
          easing: def.easing ?? easeLinear,
        });
        break;

      case "set":
        // Instant - apply immediately, no need to track
        this.setter(def.target, def.value);
        // Return id but it's immediately "done"
        return id;

      case "wait":
        this.actions.push({
          id,
          type: "wait",
          duration: def.duration,
          elapsed: 0,
        });
        break;
    }

    return id;
  }

  /** Check if a specific action is done (or never existed) */
  isDone(id: number): boolean {
    return !this.actions.some(a => a.id === id);
  }

  /** Check if all actions are done */
  get empty(): boolean {
    return this.actions.length === 0;
  }

  /** Skip a specific action (instant complete) */
  skip(id: number): void {
    const idx = this.actions.findIndex(a => a.id === id);
    if (idx === -1) return;

    const action = this.actions[idx]!;
    this.completeAction(action);
    this.actions.splice(idx, 1);
  }

  /** Skip all actions */
  skipAll(): void {
    for (const action of this.actions) {
      this.completeAction(action);
    }
    this.actions.length = 0;
  }

  /** Update all actions, call each frame with delta time in seconds */
  tick(dt: number): void {
    // Process in reverse so we can safely remove
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i]!;
      const done = this.updateAction(action, dt);
      if (done) {
        this.actions.splice(i, 1);
      }
    }
  }

  /** Clear all actions without completing them */
  clear(): void {
    this.actions.length = 0;
  }

  private updateAction(action: ActiveAction, dt: number): boolean {
    switch (action.type) {
      case "lerp": {
        action.elapsed += dt;
        const t = Math.min(action.elapsed / action.duration, 1);
        const eased = action.easing(t);
        const value = action.from + (action.to - action.from) * eased;
        this.setter(action.target, value);
        return t >= 1;
      }

      case "wait": {
        action.elapsed += dt;
        return action.elapsed >= action.duration;
      }
    }
  }

  private completeAction(action: ActiveAction): void {
    switch (action.type) {
      case "lerp":
        this.setter(action.target, action.to);
        break;
      case "wait":
        // Nothing to do
        break;
    }
  }
}

// =============================================================================
// Script types for dialogue system
// =============================================================================

/** A script is a sequence of action definitions */
export type Script = ActionDef[];
