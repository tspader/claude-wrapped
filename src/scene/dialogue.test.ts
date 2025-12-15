/**
 * Tests for dialogue executor and action queue.
 */

import { describe, test, expect } from "bun:test";
import { ActionQueue } from "./script";
import { DialogueExecutor, type DialogueNode } from "./dialogue";
import { t } from "@opentui/core";

// =============================================================================
// Test Harness
// =============================================================================

interface TestRecorder {
  textUpdates: { nodeId: string; index: number; finished: boolean }[];
  optionsShown: string[][];
  optionsHidden: number;
}

function createTestHarness(nodes: DialogueNode[], startId: string) {
  const state: Record<string, number> = { "camera.x": 0, "camera.y": 0, "camera.z": 0 };
  const queue = new ActionQueue(
    (k) => state[k] ?? 0,
    (k, v) => { state[k] = v; }
  );
  const recorder: TestRecorder = { textUpdates: [], optionsShown: [], optionsHidden: 0 };
  const executor = new DialogueExecutor(nodes, startId, queue);

  executor.onTextUpdate = (_text, index, finished) => {
    recorder.textUpdates.push({ nodeId: executor.currentNodeId, index, finished });
  };
  executor.onShowOptions = (opts) => {
    recorder.optionsShown.push(opts.map(o => o.label));
  };
  executor.onHideOptions = () => {
    recorder.optionsHidden++;
  };

  return { executor, queue, state, recorder };
}

/** Tick both queue and executor n times with given dt */
function tickN(executor: DialogueExecutor, queue: ActionQueue, dt: number, n: number) {
  for (let i = 0; i < n; i++) {
    queue.tick(dt);
    executor.tick(dt);
  }
}

/** Tick until executor reaches a specific node or max iterations */
function tickUntilNode(executor: DialogueExecutor, queue: ActionQueue, nodeId: string, maxTicks = 100) {
  for (let i = 0; i < maxTicks && executor.currentNodeId !== nodeId; i++) {
    queue.tick(0.1);
    executor.tick(0.1);
  }
}

// =============================================================================
// Tests: Script Nodes
// =============================================================================

describe("script nodes", () => {
  test("auto-advances when actions complete", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "script", script: [{ type: "wait", duration: 0.5 }], next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");
    expect(executor.currentNodeId).toBe("start");

    // Tick past the wait duration
    tickN(executor, queue, 0.1, 10);

    expect(executor.currentNodeId).toBe("end");
  });

  test("lerp action updates state", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "script", script: [{ type: "lerp", target: "camera.x", to: 5, duration: 1 }], next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, state } = createTestHarness(nodes, "start");
    expect(state["camera.x"]).toBe(0);

    tickN(executor, queue, 0.5, 1);
    expect(state["camera.x"]).toBeGreaterThan(0);
    expect(state["camera.x"]).toBeLessThan(5);

    tickN(executor, queue, 1, 2);
    expect(state["camera.x"]).toBe(5);
    expect(executor.currentNodeId).toBe("end");
  });

  test("skip completes actions instantly and advances", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "script", script: [{ type: "lerp", target: "camera.x", to: 10, duration: 5 }], next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, state } = createTestHarness(nodes, "start");
    
    // Tick a little bit
    tickN(executor, queue, 0.1, 2);
    expect(state["camera.x"]).toBeLessThan(10);
    expect(executor.currentNodeId).toBe("start");

    // Skip
    executor.advance();

    expect(state["camera.x"]).toBe(10);
    expect(executor.currentNodeId).toBe("end");
  });

  test("multiple actions run concurrently", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "script", 
        script: [
          { type: "lerp", target: "camera.x", to: 5, duration: 1 },
          { type: "lerp", target: "camera.y", to: 10, duration: 1 },
        ], 
        next: "end" 
      },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, state } = createTestHarness(nodes, "start");

    tickN(executor, queue, 0.5, 1);
    
    // Both should be progressing
    expect(state["camera.x"]).toBeGreaterThan(0);
    expect(state["camera.y"]).toBeGreaterThan(0);

    tickN(executor, queue, 1, 2);
    
    expect(state["camera.x"]).toBe(5);
    expect(state["camera.y"]).toBe(10);
  });
});

// =============================================================================
// Tests: Text Nodes
// =============================================================================

describe("text nodes", () => {
  test("waits for input after typing finishes", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "text", text: t`Hello`, next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, recorder } = createTestHarness(nodes, "start");

    // Tick enough for typing to finish
    tickN(executor, queue, 0.1, 50);

    // Should have finished typing but still on start
    const finishedUpdates = recorder.textUpdates.filter(u => u.finished && u.nodeId === "start");
    expect(finishedUpdates.length).toBeGreaterThan(0);
    expect(executor.currentNodeId).toBe("start");
    expect(executor.phase).toBe("waiting");
  });

  test("advances on input after typing", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "text", text: t`Hi`, next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");

    // Tick to finish typing
    tickN(executor, queue, 0.1, 50);
    expect(executor.phase).toBe("waiting");

    // Advance
    executor.advance();
    expect(executor.currentNodeId).toBe("end");
  });

  test("skip during typing completes text instantly", () => {
    const nodes: DialogueNode[] = [
      { id: "start", type: "text", text: t`This is a longer text`, next: "end" },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, recorder } = createTestHarness(nodes, "start");

    // Tick just a bit
    tickN(executor, queue, 0.05, 2);
    
    // Should be mid-typing
    expect(executor.phase).toBe("typing");

    // Skip
    executor.advance();

    // Should now be waiting (typing finished)
    expect(executor.phase).toBe("waiting");
    expect(executor.currentNodeId).toBe("start"); // Still on same node, just finished typing
    
    // Last update should be finished
    const lastUpdate = recorder.textUpdates[recorder.textUpdates.length - 1];
    expect(lastUpdate?.finished).toBe(true);
  });

  test("parallel script runs during typing", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "text", 
        text: t`Hello world`, 
        script: [{ type: "lerp", target: "camera.x", to: 5, duration: 0.5 }],
        next: "end" 
      },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue, state } = createTestHarness(nodes, "start");

    // Tick a bit - script should be running alongside typing
    tickN(executor, queue, 0.3, 1);

    expect(state["camera.x"]).toBeGreaterThan(0);
    expect(executor.currentNodeId).toBe("start");
  });
});

// =============================================================================
// Tests: Prompt Nodes
// =============================================================================

describe("prompt nodes", () => {
  test("shows options after typing finishes", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "prompt", 
        text: t`Choose`, 
        options: [
          { label: "A", target: "a" },
          { label: "B", target: "b" },
        ],
        next: "a" 
      },
      { id: "a", type: "text", text: t`Chose A`, next: "a" },
      { id: "b", type: "text", text: t`Chose B`, next: "b" },
    ];

    const { executor, queue, recorder } = createTestHarness(nodes, "start");

    // Tick to finish typing
    tickN(executor, queue, 0.1, 50);

    expect(recorder.optionsShown.length).toBe(1);
    expect(recorder.optionsShown[0]).toEqual(["A", "B"]);
    expect(executor.phase).toBe("waiting");
  });

  test("advance does not progress prompt (must select)", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "prompt", 
        text: t`Choose`, 
        options: [{ label: "A", target: "a" }],
        next: "a" 
      },
      { id: "a", type: "text", text: t`Done`, next: "a" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");

    tickN(executor, queue, 0.1, 50);
    expect(executor.phase).toBe("waiting");

    executor.advance();
    
    // Should still be on prompt
    expect(executor.currentNodeId).toBe("start");
  });

  test("selectOption navigates to target", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "prompt", 
        text: t`Choose`, 
        options: [
          { label: "A", target: "a" },
          { label: "B", target: "b" },
        ],
        next: "a" 
      },
      { id: "a", type: "text", text: t`Chose A`, next: "a" },
      { id: "b", type: "text", text: t`Chose B`, next: "b" },
    ];

    const { executor, queue, recorder } = createTestHarness(nodes, "start");

    tickN(executor, queue, 0.1, 50);

    executor.selectOption(1); // Select B

    expect(executor.currentNodeId).toBe("b");
    // Called once on selectOption, once on entering new node
    expect(recorder.optionsHidden).toBeGreaterThanOrEqual(1);
  });

  test("selectOption ignored during typing", () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "prompt", 
        text: t`This is a longer prompt text`, 
        options: [{ label: "A", target: "a" }],
        next: "a" 
      },
      { id: "a", type: "text", text: t`Done`, next: "a" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");

    // Just a tiny tick - should still be typing
    tickN(executor, queue, 0.01, 1);
    expect(executor.phase).toBe("typing");

    executor.selectOption(0);

    // Should still be on start
    expect(executor.currentNodeId).toBe("start");
  });
});

// =============================================================================
// Tests: Action Nodes
// =============================================================================

describe("action nodes", () => {
  test("runs onEnter and waits for ctx.advance()", async () => {
    let advanceFn: (() => void) | null = null;

    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "action", 
        text: t`Loading...`,
        onEnter: async (ctx) => {
          advanceFn = ctx.advance;
        },
        next: "end" 
      },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");

    // Tick - should be in action phase
    tickN(executor, queue, 0.1, 5);
    expect(executor.phase).toBe("action");
    expect(executor.currentNodeId).toBe("start");

    // Action hasn't called advance yet
    expect(advanceFn).not.toBeNull();

    // Simulate action completing
    advanceFn!();

    expect(executor.currentNodeId).toBe("end");
  });

  test("ctx.setData and ctx.getData work", async () => {
    const nodes: DialogueNode[] = [
      { 
        id: "start", 
        type: "action", 
        text: t`Loading...`,
        onEnter: async (ctx) => {
          ctx.setData("foo", 42);
          ctx.advance();
        },
        next: "end" 
      },
      { id: "end", type: "text", text: t`Done`, next: "end" },
    ];

    const { executor, queue } = createTestHarness(nodes, "start");

    tickN(executor, queue, 0.1, 1);

    expect(executor.getData("foo")).toBe(42);
  });
});

// =============================================================================
// Tests: Node Chaining
// =============================================================================

describe("node chaining", () => {
  test("script -> text -> script -> text flow", () => {
    const nodes: DialogueNode[] = [
      { id: "s1", type: "script", script: [{ type: "wait", duration: 0.1 }], next: "t1" },
      { id: "t1", type: "text", text: t`First`, next: "s2" },
      { id: "s2", type: "script", script: [{ type: "wait", duration: 0.1 }], next: "t2" },
      { id: "t2", type: "text", text: t`Second`, next: "t2" },
    ];

    const { executor, queue } = createTestHarness(nodes, "s1");

    // Script 1 completes
    tickUntilNode(executor, queue, "t1");
    expect(executor.currentNodeId).toBe("t1");

    // Finish typing, advance
    tickN(executor, queue, 0.1, 50);
    executor.advance();

    // Script 2 completes
    tickUntilNode(executor, queue, "t2");
    expect(executor.currentNodeId).toBe("t2");
  });

  test("terminal node stays put", () => {
    const nodes: DialogueNode[] = [
      { id: "end", type: "text", text: t`The End`, next: "end" },
    ];

    const { executor, queue } = createTestHarness(nodes, "end");

    tickN(executor, queue, 0.1, 50);
    executor.advance();
    executor.advance();
    executor.advance();

    expect(executor.currentNodeId).toBe("end");
    expect(executor.done).toBe(true);
  });
});
