/**
 * Script executor for chainable, skippable interpolations.
 */

export type EasingFn = (t: number) => number;

// Built-in easings
export const easeLinear: EasingFn = (t) => t;
export const easeInQuad: EasingFn = (t) => t * t;
export const easeOutQuad: EasingFn = (t) => t * (2 - t);
export const easeInOutQuad: EasingFn = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
export const easeOutCubic: EasingFn = (t) => (--t) * t * t + 1;
export const easeInOutCubic: EasingFn = (t) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

// Action types
export type Action =
  | { type: "lerp"; target: string; to: number; duration: number; easing?: EasingFn }
  | { type: "set"; target: string; value: number }
  | { type: "wait"; duration: number }
  | { type: "parallel"; actions: Action[] };

export type Script = Action[];

// Active interpolation state
interface ActiveLerp {
  target: string;
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  easing: EasingFn;
}

// Active wait state
interface ActiveWait {
  duration: number;
  elapsed: number;
}

type ActiveAction =
  | { type: "lerp"; lerp: ActiveLerp }
  | { type: "wait"; wait: ActiveWait }
  | { type: "parallel"; children: ActiveAction[] };

/**
 * ScriptRunner executes a script with skippable interpolations.
 * 
 * Usage:
 *   const runner = new ScriptRunner(script, getter, setter);
 *   // Each frame:
 *   runner.tick(dt);
 *   // On skip (space):
 *   runner.skip();
 */
export class ScriptRunner {
  private script: Script;
  private current: number = 0;
  private active: ActiveAction | null = null;
  private getter: (target: string) => number;
  private setter: (target: string, value: number) => void;

  constructor(
    script: Script,
    getter: (target: string) => number,
    setter: (target: string, value: number) => void
  ) {
    this.script = script;
    this.getter = getter;
    this.setter = setter;
  }

  /** Check if script is complete */
  get done(): boolean {
    return this.current >= this.script.length && this.active === null;
  }

  /** Skip current action - instantly complete all active interpolations */
  skip(): void {
    if (this.active) {
      this.completeAction(this.active);
      this.active = null;
    }
    this.current++;
    this.startNext();
  }

  /** Update - call each frame with delta time in seconds */
  tick(dt: number): void {
    if (this.active === null) {
      this.startNext();
    }

    if (this.active) {
      const done = this.updateAction(this.active, dt);
      if (done) {
        this.active = null;
        this.current++;
        this.startNext();
      }
    }
  }

  /** Reset to beginning */
  reset(): void {
    if (this.active) {
      this.completeAction(this.active);
    }
    this.current = 0;
    this.active = null;
  }

  // Start the next action in the script
  private startNext(): void {
    if (this.current >= this.script.length) return;

    const action = this.script[this.current]!;
    this.active = this.initAction(action);

    // For instant actions (set), complete immediately and continue
    if (action.type === "set") {
      this.active = null;
      this.current++;
      this.startNext();
    }
  }

  // Initialize an action into active state
  private initAction(action: Action): ActiveAction {
    switch (action.type) {
      case "lerp":
        return {
          type: "lerp",
          lerp: {
            target: action.target,
            from: this.getter(action.target),
            to: action.to,
            duration: action.duration,
            elapsed: 0,
            easing: action.easing ?? easeLinear,
          },
        };

      case "set":
        this.setter(action.target, action.value);
        // Return a dummy that's immediately complete
        return { type: "wait", wait: { duration: 0, elapsed: 0 } };

      case "wait":
        return {
          type: "wait",
          wait: { duration: action.duration, elapsed: 0 },
        };

      case "parallel":
        return {
          type: "parallel",
          children: action.actions.map((a) => this.initAction(a)),
        };
    }
  }

  // Update an active action, returns true if complete
  private updateAction(active: ActiveAction, dt: number): boolean {
    switch (active.type) {
      case "lerp": {
        const { lerp } = active;
        lerp.elapsed += dt;
        const t = Math.min(lerp.elapsed / lerp.duration, 1);
        const eased = lerp.easing(t);
        const value = lerp.from + (lerp.to - lerp.from) * eased;
        this.setter(lerp.target, value);
        return t >= 1;
      }

      case "wait": {
        const { wait } = active;
        wait.elapsed += dt;
        return wait.elapsed >= wait.duration;
      }

      case "parallel": {
        let allDone = true;
        for (const child of active.children) {
          const done = this.updateAction(child, dt);
          if (!done) allDone = false;
        }
        return allDone;
      }
    }
  }

  // Instantly complete an action (for skip)
  private completeAction(active: ActiveAction): void {
    switch (active.type) {
      case "lerp":
        this.setter(active.lerp.target, active.lerp.to);
        break;

      case "wait":
        // Nothing to do
        break;

      case "parallel":
        for (const child of active.children) {
          this.completeAction(child);
        }
        break;
    }
  }
}
