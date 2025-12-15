/**
 * Dialogue executor - runs nodes that combine text and camera scripts.
 */

import { ActionQueue, type ActionDef, type Script } from "./script";
import type { StyledText } from "@opentui/core";

// =============================================================================
// Node Types
// =============================================================================

interface BaseNode {
  id: string;
  next: string;
}

/** Text node - displays text, waits for advance */
export interface TextNode extends BaseNode {
  type: "text";
  text: StyledText;
  /** Script to run in parallel with typing */
  script?: Script;
}

/** Prompt node - displays text, waits for option selection */
export interface PromptNode extends BaseNode {
  type: "prompt";
  text: StyledText;
  options: { label: string; target: string }[];
  /** Script to run in parallel with typing */
  script?: Script;
}

/** Action node - runs async action, auto-advances when done */
export interface ActionNode extends BaseNode {
  type: "action";
  text: StyledText;
  onEnter: (ctx: DialogueContext) => Promise<void>;
}

/** Script-only node - runs script, auto-advances when done */
export interface ScriptNode extends BaseNode {
  type: "script";
  script: Script;
}

export type DialogueNode = TextNode | PromptNode | ActionNode | ScriptNode;

// =============================================================================
// Dialogue Context (passed to action nodes)
// =============================================================================

export interface DialogueContext {
  setData: (key: string, value: any) => void;
  getData: (key: string) => any;
  setStatus: (text: StyledText) => void;
  advance: () => void;
  abortSignal: AbortSignal;
}

// =============================================================================
// Executor State
// =============================================================================

export type Phase = "typing" | "waiting" | "scripting" | "action";

export interface DialogueState {
  nodeId: string;
  phase: Phase;
  /** For typing: current visible char count */
  typingIndex: number;
  /** For typing: time accumulator */
  typingTimer: number;
  /** IDs of script actions we're waiting for */
  pendingActions: number[];
}

// =============================================================================
// Dialogue Executor
// =============================================================================

export class DialogueExecutor {
  private nodes: Map<string, DialogueNode>;
  private state: DialogueState;
  private actionQueue: ActionQueue;
  private data: Record<string, any> = {};
  private abortController: AbortController;

  // Callbacks for UI
  public onTextUpdate?: (text: StyledText, index: number, finished: boolean) => void;
  public onShowOptions?: (options: { label: string; target: string }[]) => void;
  public onHideOptions?: () => void;

  constructor(
    nodes: DialogueNode[],
    startId: string,
    actionQueue: ActionQueue
  ) {
    this.nodes = new Map(nodes.map(n => [n.id, n]));
    this.actionQueue = actionQueue;
    this.abortController = new AbortController();

    this.state = {
      nodeId: startId,
      phase: "typing",
      typingIndex: 0,
      typingTimer: 0,
      pendingActions: [],
    };

    this.enterNode(startId);
  }

  get currentNodeId(): string {
    return this.state.nodeId;
  }

  get phase(): Phase {
    return this.state.phase;
  }

  get done(): boolean {
    const node = this.nodes.get(this.state.nodeId);
    return node?.next === node?.id; // Terminal node loops to self
  }

  /** Update - call each frame with delta time in seconds */
  tick(dt: number): void {
    const node = this.nodes.get(this.state.nodeId);
    if (!node) return;

    switch (this.state.phase) {
      case "typing":
        this.tickTyping(dt, node);
        break;
      case "scripting":
        this.tickScripting();
        break;
      case "waiting":
      case "action":
        // Just wait for input or action completion
        break;
    }
  }

  /** User pressed advance (space/enter) */
  advance(): void {
    const node = this.nodes.get(this.state.nodeId);
    if (!node) return;

    switch (this.state.phase) {
      case "typing":
        // Skip to end of text
        this.finishTyping(node);
        break;
      case "waiting":
        // Go to next node
        if (node.type === "text") {
          this.goToNode(node.next);
        }
        // Prompt nodes wait for selectOption instead
        break;
      case "scripting":
        // Skip all pending actions
        for (const id of this.state.pendingActions) {
          this.actionQueue.skip(id);
        }
        this.state.pendingActions = [];
        this.goToNode(node.next);
        break;
    }
  }

  /** User selected an option (for prompt nodes) */
  selectOption(index: number): void {
    const node = this.nodes.get(this.state.nodeId);
    if (!node || node.type !== "prompt") return;
    if (this.state.phase !== "waiting") return;

    const option = node.options[index];
    if (option) {
      this.onHideOptions?.();
      this.goToNode(option.target);
    }
  }

  /** Set data (for action nodes) */
  setData(key: string, value: any): void {
    this.data[key] = value;
  }

  /** Get data */
  getData(key: string): any {
    return this.data[key];
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private enterNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    this.state.nodeId = id;
    this.state.pendingActions = [];
    this.onHideOptions?.();

    switch (node.type) {
      case "text":
      case "prompt":
        this.state.phase = "typing";
        this.state.typingIndex = 0;
        this.state.typingTimer = 0;
        this.onTextUpdate?.(node.text, 0, false);
        // Start script in parallel if present
        if (node.script) {
          for (const action of node.script) {
            const actionId = this.actionQueue.push(action);
            this.state.pendingActions.push(actionId);
          }
        }
        break;

      case "action":
        this.state.phase = "action";
        this.state.typingIndex = 0;
        this.onTextUpdate?.(node.text, node.text.chunks.map(c => c.text).join("").length, true);
        // Run async action
        const ctx: DialogueContext = {
          setData: (k, v) => this.setData(k, v),
          getData: (k) => this.getData(k),
          setStatus: (text) => this.onTextUpdate?.(text, text.chunks.map(c => c.text).join("").length, true),
          advance: () => this.goToNode(node.next),
          abortSignal: this.abortController.signal,
        };
        node.onEnter(ctx);
        break;

      case "script":
        this.state.phase = "scripting";
        for (const action of node.script) {
          const actionId = this.actionQueue.push(action);
          this.state.pendingActions.push(actionId);
        }
        break;
    }
  }

  private goToNode(id: string): void {
    this.enterNode(id);
  }

  private tickTyping(dt: number, node: DialogueNode): void {
    if (node.type !== "text" && node.type !== "prompt") return;

    const plainText = node.text.chunks.map(c => c.text).join("");
    if (this.state.typingIndex >= plainText.length) {
      this.finishTyping(node);
      return;
    }

    this.state.typingTimer += dt * 1000; // convert to ms
    const baseDelay = 35;

    if (this.state.typingTimer >= baseDelay) {
      this.state.typingTimer = 0;
      this.state.typingIndex++;

      // Add pauses for punctuation
      if (this.state.typingIndex < plainText.length) {
        const char = plainText[this.state.typingIndex - 1];
        if (char === "." || char === "?" || char === "!") {
          this.state.typingTimer = -250;
        } else if (char === ",") {
          this.state.typingTimer = -80;
        } else if (char === "\n") {
          this.state.typingTimer = -150;
        }
      }

      this.onTextUpdate?.(node.text, this.state.typingIndex, false);
    }
  }

  private finishTyping(node: DialogueNode): void {
    if (node.type !== "text" && node.type !== "prompt") return;

    const plainText = node.text.chunks.map(c => c.text).join("");
    this.state.typingIndex = plainText.length;
    this.onTextUpdate?.(node.text, this.state.typingIndex, true);

    if (node.type === "prompt") {
      this.state.phase = "waiting";
      this.onShowOptions?.(node.options);
    } else {
      this.state.phase = "waiting";
    }
  }

  private tickScripting(): void {
    // Check if all pending actions are done
    this.state.pendingActions = this.state.pendingActions.filter(
      id => !this.actionQueue.isDone(id)
    );

    if (this.state.pendingActions.length === 0) {
      const node = this.nodes.get(this.state.nodeId);
      if (node) {
        this.goToNode(node.next);
      }
    }
  }

  destroy(): void {
    this.abortController.abort();
  }
}
