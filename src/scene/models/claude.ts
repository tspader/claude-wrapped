/**
 * Claude logo model - 7 boxes (body, 2 arms, 4 legs).
 */

import { ShapeType, type Vec3, type ObjectDef } from "../types";

export const CLAUDE_COLOR: Vec3 = [0.85, 0.45, 0.35];

/**
 * Returns Claude logo as 7 box ObjectDefs (body, 2 arms, 4 legs).
 * Position is the center of the model.
 */
export function getClaudeBoxes(
  position: Vec3,
  scale: number = 1,
  group: number = 0
): ObjectDef[] {
  const [px, py, pz] = position;

  // Body: wide and squat (roughly 2:1 width:height)
  const bodyW = 0.7 * scale;
  const bodyH = 0.28 * scale;
  const bodyD = 0.25 * scale;

  // Arms: short stubby protrusions
  const armW = 0.2 * scale;
  const armH = 0.15 * scale;
  const armD = 0.18 * scale;
  const armY = 0.0; // centered vertically on body
  const armX = bodyW / 2 + armW / 2 - 0.03 * scale;

  // Legs: positioned at outer edges of body
  const legW = 0.07 * scale;
  const legH = 0.22 * scale;
  const legD = 0.12 * scale;
  const legY = -bodyH / 2 - legH / 2 + 0.04 * scale;
  const legSpacing = 0.14 * scale; // gap between legs in a pair
  const legX = bodyW / 2 - 0.12 * scale; // align with body edges

  return [
    // Body
    {
      shape: { type: ShapeType.BOX, params: [bodyW, bodyH, bodyD], color: CLAUDE_COLOR },
      position: [px, py, pz],
      group,
    },
    // Left arm
    {
      shape: { type: ShapeType.BOX, params: [armW, armH, armD], color: CLAUDE_COLOR },
      position: [px - armX, py + armY, pz],
      group,
    },
    // Right arm
    {
      shape: { type: ShapeType.BOX, params: [armW, armH, armD], color: CLAUDE_COLOR },
      position: [px + armX, py + armY, pz],
      group,
    },
    // Left-left leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px - legX - legSpacing / 2, py + legY, pz],
      group,
    },
    // Left-right leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px - legX + legSpacing / 2, py + legY, pz],
      group,
    },
    // Right-left leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px + legX - legSpacing / 2, py + legY, pz],
      group,
    },
    // Right-right leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px + legX + legSpacing / 2, py + legY, pz],
      group,
    },
  ];
}
