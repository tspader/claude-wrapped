# renderer.c Cleanup Candidates

## 1. Debug Code / Commented-Out Code
**None found.** The code is clean of commented-out code blocks and debug statements.

---

## 2. Highly Duplicated Code Patterns

### a) AABB slab test (lines 141-184)
The X/Y/Z slab tests are nearly identical. Could be refactored into a loop or helper function:
```c
// Lines 145-156 (X slab)
// Lines 159-170 (Y slab)
// Lines 172-183 (Z slab)
```

### b) Scalar vs SIMD function pairs
Several functions have both scalar and SIMD versions with similar structure:
- `eval_shape_scalar` (220-235) / `eval_shape_simd` (338-353)
- `scene_sdf_scalar` (237-279) / `scene_sdf_simd` (355-400)
- `sdf_smooth_union` (210-213) / `sdf_smooth_union_simd` (316-331)

The hierarchical group evaluation logic is duplicated between the scalar and SIMD versions.

### c) Shape type dispatch (sphere vs box)
This pattern appears 5 times:
- Lines 226-234 (`eval_shape_scalar`)
- Lines 344-352 (`eval_shape_simd`)
- Lines 420-428 (`get_hit_color`)
- Lines 488-496 (`set_scene` - AABB computation)

---

## 3. Dead Code / Unused Functions/Variables

### a) `ray_intersects_aabb` function (lines 141-185)
Function exists but is never called. Line 754 explicitly notes: `// AABB check disabled for this scene`

### b) Unused performance metric `PERF_AABB_SKIPPED`
Defined (line 101) and set to 0 (line 754), but AABB checking is disabled.

### c) Unused output buffers
`out_r`, `out_g`, `out_b` (lines 39-41) are intermediate buffers. They work but could potentially be eliminated if compositing happened inline.

---

## 4. Unwieldy / Overly Complex Code

### a) `march_rays` function (lines 602-755)
At 153 lines, this is the longest function and does multiple things:
- Ray marching loop
- Normal computation
- Lighting calculation
- Hit color lookup
- Metric tracking

Could be split into smaller functions.

### b) Metric tracking inline
Performance metric updates are scattered throughout `march_rays`:
- Lines 655, 660, 688 (incrementing counters inline)

---

## 5. Inconsistent Naming / Style

### a) Mix of `_ptr` suffix and direct access
- Getter functions use `_ptr` suffix: `get_ray_ox_ptr`, `get_out_char_ptr`
- Some use different patterns: `get_bg_ptr` vs `get_perf_metrics_ptr`

### b) Variable naming inconsistency
- `shape_count` vs `group_count` (good)
- `ray_count` (good)
- But `batch_count` (local) vs `active_batches` (local, different pattern)

### c) Parameter naming
- `px, py, pz` for point coordinates
- `cx, cy, cz` for center coordinates
- `bx, by, bz` for box half-extents
- `ex, ey, ez` for extent in one place, camera eye in another (lines 488 vs 526)

---

## 6. Magic Numbers

| Location | Value | Description |
|----------|-------|-------------|
| Line 106 | `16` | Size of perf_metrics array (could be `#define`) |
| Line 116 | `5` | Newton-Raphson iterations for sqrt |
| Line 123-124 | `3.14159...` | PI/TWO_PI (not reused elsewhere) |
| Line 146, 159, 172 | `1e-8f` | Small epsilon for ray direction check |
| Line 480-481 | `1e10f` | Initial AABB bounds |
| Line 587-592 | `0.02f, 0.03f, 0.5f, 0.3f, 0.7f` | Background color animation params |
| Line 701-703 | `0.577f` | Light direction (1,1,-1 normalized) |
| Line 714-715 | `0.1f, 0.9f` | Ambient and diffuse light weights |
| Line 786 | `0.333333f` | 1/3 for RGB average |
| Line 797 | `0.04f` | Background threshold |
| Line 798 | `9.0f` | ASCII ramp length - 1 |
| Line 809-812 | `0.03f, 0.05f, 0.04f` | Background fill color |

---

## 7. TODO/FIXME Comments
**None found.** The code has no TODO or FIXME markers.

---

## Summary

### High Priority
- Dead code: `ray_intersects_aabb` and `PERF_AABB_SKIPPED` (unused)
- Magic numbers: Many hardcoded values that should be constants

### Medium Priority
- Duplicated shape dispatch logic (5 occurrences)
- Duplicated scalar/SIMD group evaluation logic
- Large `march_rays` function could be decomposed

### Low Priority
- AABB slab test repetition (performance-sensitive code, duplication may be intentional)
- Minor naming inconsistencies
