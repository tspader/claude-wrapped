// WASM Raymarcher with SIMD and Dynamic Scenes
// Compile: clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export-all -o renderer.wasm renderer.c

#include <wasm_simd128.h>

typedef unsigned int u32;
typedef unsigned char u8;
typedef int i32;
typedef float f32;

// =============================================================================
// Constants
// =============================================================================

#define MAX_RAYS 16384      // 128x128 max resolution
#define MAX_SHAPES 64       // max shapes in scene
#define MAX_STEPS 64
#define MAX_DIST 100.0f
#define HIT_THRESHOLD 0.001f
#define NORMAL_EPS 0.001f

// Shape types
#define SHAPE_SPHERE 0
#define SHAPE_BOX 1
#define SHAPE_CYLINDER 2

// Performance metrics
#define PERF_METRICS_SIZE 16

// Lighting
#define LIGHT_DIR_COMPONENT 0.577f  // 1/sqrt(3), normalized (1,1,-1)
#define AMBIENT_WEIGHT 0.1f
#define DIFFUSE_WEIGHT 0.9f

// Compositing
#define RGB_AVG_DIVISOR 0.333333f
#define BG_THRESHOLD 0.04f
#define ASCII_RAMP_MAX_IDX 9.0f
#define BG_FILL_R 0.03f
#define BG_FILL_G 0.05f
#define BG_FILL_B 0.04f

// Math
#define SQRT_ITERATIONS 5

// =============================================================================
// Buffers (static allocation - no malloc in WASM without libc)
// =============================================================================

// Ray data (SoA layout)
static f32 ray_ox[MAX_RAYS];
static f32 ray_oy[MAX_RAYS];
static f32 ray_oz[MAX_RAYS];
static f32 ray_dx[MAX_RAYS];
static f32 ray_dy[MAX_RAYS];
static f32 ray_dz[MAX_RAYS];

// Output color buffer (SoA layout)
static f32 out_r[MAX_RAYS];
static f32 out_g[MAX_RAYS];
static f32 out_b[MAX_RAYS];

// OpenTUI-compatible output buffers (SoA layout)
// char: u32 per cell (unicode codepoint)
// fg: 4 x f32 per cell (RGBA normalized floats)
// bg: 4 x f32 per cell (RGBA normalized floats) - used by block compositor
static u32 out_char[MAX_RAYS];
static f32 out_fg[MAX_RAYS * 4];  // r, g, b, a per cell
static f32 out_bg[MAX_RAYS * 4];  // r, g, b, a per cell (for block mode)

// Upscaled output buffers (for rendering at lower res then upscaling)
// Same max size as native output since terminal size is the limiting factor
static u32 upscaled_char[MAX_RAYS];
static f32 upscaled_fg[MAX_RAYS * 4];  // r, g, b, a per cell

// Background color
static f32 bg_color[3];

// Scene data
static u8 shape_types[MAX_SHAPES];           // SHAPE_SPHERE, SHAPE_BOX
static f32 shape_params[MAX_SHAPES * 4];     // [radius] or [w,h,d,_] per shape
static f32 shape_positions[MAX_SHAPES * 3];  // x,y,z per shape
static f32 shape_colors[MAX_SHAPES * 3];     // r,g,b per shape
static u8 shape_groups[MAX_SHAPES];          // group ID per shape
static u32 shape_count = 0;
static f32 smooth_k = 0.5f;

// Scene bounding box (computed from shapes)
static f32 scene_aabb_min[3];
static f32 scene_aabb_max[3];

// Group data
#define MAX_GROUPS 8
static u8 group_blend_mode[MAX_GROUPS];      // 0 = hard union (min), 1 = smooth union
static u32 group_count = 0;

// Precomputed SIMD shape data (splatted for each shape)
// Avoids repeated wasm_f32x4_splat calls in the hot SDF loop
static v128_t shape_cx[MAX_SHAPES];  // center x splatted
static v128_t shape_cy[MAX_SHAPES];  // center y splatted
static v128_t shape_cz[MAX_SHAPES];  // center z splatted
static v128_t shape_p0[MAX_SHAPES];  // param 0 (radius or box x)
static v128_t shape_p1[MAX_SHAPES];  // param 1 (box y)
static v128_t shape_p2[MAX_SHAPES];  // param 2 (box z)
static v128_t shape_r[MAX_SHAPES];   // color r splatted
static v128_t shape_g[MAX_SHAPES];   // color g splatted
static v128_t shape_b[MAX_SHAPES];   // color b splatted

// Precomputed k splat for smooth union
static v128_t smooth_k_simd;

// Current ray count
static u32 ray_count = 0;

// Camera parameters for ray generation
static f32 cam_eye[3];
static f32 cam_forward[3];
static f32 cam_right[3];
static f32 cam_up[3];
static f32 cam_half_width;
static f32 cam_half_height;

// =============================================================================
// Performance Metrics
// =============================================================================

static f32 perf_metrics[PERF_METRICS_SIZE];

// Metric indices
#define PERF_TOTAL_STEPS 0      // Total march steps across all rays
#define PERF_TOTAL_SDF_CALLS 1  // Total SDF evaluations (in march loop)
#define PERF_NORMAL_SDF_CALLS 2 // SDF calls for normal estimation
#define PERF_COLOR_LOOKUPS 3    // Color lookup iterations
#define PERF_EARLY_HITS 4       // Rays that hit before MAX_STEPS
#define PERF_MISSES 5           // Rays that missed (exceeded MAX_DIST)
#define PERF_AVG_STEPS 6        // Average steps per ray (computed at end)
#define PERF_HIT_RATE 7         // Hit rate percentage

f32* get_perf_metrics_ptr(void) { return perf_metrics; }

void reset_perf_metrics(void) {
    for (int i = 0; i < PERF_METRICS_SIZE; i++) perf_metrics[i] = 0.0f;
}

// =============================================================================
// Math helpers
// =============================================================================

static f32 sqrtf_approx(f32 x) {
    if (x <= 0.0f) return 0.0f;
    // Use WASM SIMD sqrt which maps to hardware instruction
    return wasm_f32x4_extract_lane(wasm_f32x4_sqrt(wasm_f32x4_splat(x)), 0);
}

static f32 sinf_approx(f32 x) {
    const f32 PI = 3.14159265358979f;
    const f32 TWO_PI = 6.28318530717958f;
    while (x > PI) x -= TWO_PI;
    while (x < -PI) x += TWO_PI;
    f32 x2 = x * x;
    f32 x3 = x2 * x;
    f32 x5 = x3 * x2;
    f32 x7 = x5 * x2;
    return x - x3 / 6.0f + x5 / 120.0f - x7 / 5040.0f;
}

static f32 maxf(f32 a, f32 b) { return a > b ? a : b; }
static f32 minf(f32 a, f32 b) { return a < b ? a : b; }
static f32 clampf(f32 x, f32 lo, f32 hi) { return minf(maxf(x, lo), hi); }
static f32 absf(f32 x) { return x < 0 ? -x : x; }

// Slab test for one axis. Returns 0 if ray misses, 1 otherwise.
// Updates tmin/tmax in place.
static i32 slab_test(f32 origin, f32 dir, f32 box_min, f32 box_max, f32* tmin, f32* tmax) {
    if (absf(dir) > 1e-8f) {
        f32 inv_d = 1.0f / dir;
        f32 t1 = (box_min - origin) * inv_d;
        f32 t2 = (box_max - origin) * inv_d;
        if (t1 > t2) { f32 tmp = t1; t1 = t2; t2 = tmp; }
        *tmin = maxf(*tmin, t1);
        *tmax = minf(*tmax, t2);
        if (*tmin > *tmax) return 0;
    } else {
        if (origin < box_min || origin > box_max) return 0;
    }
    return 1;
}

// =============================================================================
// SDF Primitives (scalar)
// =============================================================================

static f32 sdf_sphere_scalar(f32 px, f32 py, f32 pz, f32 cx, f32 cy, f32 cz, f32 r) {
    f32 dx = px - cx;
    f32 dy = py - cy;
    f32 dz = pz - cz;
    return sqrtf_approx(dx*dx + dy*dy + dz*dz) - r;
}

static f32 sdf_box_scalar(f32 px, f32 py, f32 pz, f32 cx, f32 cy, f32 cz, f32 bx, f32 by, f32 bz) {
    f32 dx = absf(px - cx) - bx;
    f32 dy = absf(py - cy) - by;
    f32 dz = absf(pz - cz) - bz;
    f32 dx_pos = maxf(dx, 0.0f);
    f32 dy_pos = maxf(dy, 0.0f);
    f32 dz_pos = maxf(dz, 0.0f);
    f32 outside = sqrtf_approx(dx_pos*dx_pos + dy_pos*dy_pos + dz_pos*dz_pos);
    f32 inside = minf(maxf(dx, maxf(dy, dz)), 0.0f);
    return outside + inside;
}

// Cylinder aligned along X-axis: params[0] = radius, params[1] = half-height
static f32 sdf_cylinder_scalar(f32 px, f32 py, f32 pz, f32 cx, f32 cy, f32 cz, f32 r, f32 h) {
    f32 dy = py - cy;
    f32 dz = pz - cz;
    f32 d_radial = sqrtf_approx(dy*dy + dz*dz) - r;
    f32 d_axial = absf(px - cx) - h;
    f32 d_radial_pos = maxf(d_radial, 0.0f);
    f32 d_axial_pos = maxf(d_axial, 0.0f);
    f32 outside = sqrtf_approx(d_radial_pos*d_radial_pos + d_axial_pos*d_axial_pos);
    f32 inside = minf(maxf(d_radial, d_axial), 0.0f);
    return outside + inside;
}

static f32 sdf_smooth_union(f32 d1, f32 d2, f32 k) {
    f32 h = clampf(0.5f + 0.5f * (d2 - d1) / k, 0.0f, 1.0f);
    return d2 + (d1 - d2) * h - k * h * (1.0f - h);
}

// =============================================================================
// SIMD SDF Primitives
// =============================================================================

static v128_t sdf_sphere_simd(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r) {
    v128_t dx = wasm_f32x4_sub(px, cx);
    v128_t dy = wasm_f32x4_sub(py, cy);
    v128_t dz = wasm_f32x4_sub(pz, cz);
    v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(dx, dx),
        wasm_f32x4_mul(dy, dy)),
        wasm_f32x4_mul(dz, dz));
    return wasm_f32x4_sub(wasm_f32x4_sqrt(len_sq), r);
}

static v128_t sdf_box_simd(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t bx, v128_t by, v128_t bz) {
    v128_t dx = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(px, cx)), bx);
    v128_t dy = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(py, cy)), by);
    v128_t dz = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(pz, cz)), bz);

    v128_t zero = wasm_f32x4_splat(0.0f);
    v128_t dx_pos = wasm_f32x4_max(dx, zero);
    v128_t dy_pos = wasm_f32x4_max(dy, zero);
    v128_t dz_pos = wasm_f32x4_max(dz, zero);

    v128_t outside = wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(dx_pos, dx_pos),
        wasm_f32x4_mul(dy_pos, dy_pos)),
        wasm_f32x4_mul(dz_pos, dz_pos)));

    v128_t inside = wasm_f32x4_min(wasm_f32x4_max(dx, wasm_f32x4_max(dy, dz)), zero);

    return wasm_f32x4_add(outside, inside);
}

// Cylinder aligned along X-axis: r = radius, h = half-height
static v128_t sdf_cylinder_simd(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h) {
    v128_t dy = wasm_f32x4_sub(py, cy);
    v128_t dz = wasm_f32x4_sub(pz, cz);
    v128_t radial_sq = wasm_f32x4_add(wasm_f32x4_mul(dy, dy), wasm_f32x4_mul(dz, dz));
    v128_t d_radial = wasm_f32x4_sub(wasm_f32x4_sqrt(radial_sq), r);
    v128_t d_axial = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(px, cx)), h);

    v128_t zero = wasm_f32x4_splat(0.0f);
    v128_t d_radial_pos = wasm_f32x4_max(d_radial, zero);
    v128_t d_axial_pos = wasm_f32x4_max(d_axial, zero);

    v128_t outside = wasm_f32x4_sqrt(wasm_f32x4_add(
        wasm_f32x4_mul(d_radial_pos, d_radial_pos),
        wasm_f32x4_mul(d_axial_pos, d_axial_pos)));
    v128_t inside = wasm_f32x4_min(wasm_f32x4_max(d_radial, d_axial), zero);

    return wasm_f32x4_add(outside, inside);
}

static v128_t sdf_smooth_union_simd(v128_t d1, v128_t d2, v128_t k) {
    v128_t half = wasm_f32x4_splat(0.5f);
    v128_t one = wasm_f32x4_splat(1.0f);
    v128_t zero = wasm_f32x4_splat(0.0f);

    v128_t diff = wasm_f32x4_sub(d2, d1);
    v128_t h = wasm_f32x4_add(half, wasm_f32x4_mul(half, wasm_f32x4_div(diff, k)));
    h = wasm_f32x4_max(zero, wasm_f32x4_min(one, h));

    return wasm_f32x4_add(d2,
        wasm_f32x4_sub(
            wasm_f32x4_mul(wasm_f32x4_sub(d1, d2), h),
            wasm_f32x4_mul(k, wasm_f32x4_mul(h, wasm_f32x4_sub(one, h)))
        )
    );
}

// =============================================================================
// Dynamic Scene SDF (SIMD - 4 points at once)
// =============================================================================

// Evaluate single shape SDF (SIMD) - uses precomputed splatted data
static v128_t eval_shape_simd(u32 i, v128_t px, v128_t py, v128_t pz) {
    v128_t cx = shape_cx[i];
    v128_t cy = shape_cy[i];
    v128_t cz = shape_cz[i];

    if (shape_types[i] == SHAPE_SPHERE) {
        return sdf_sphere_simd(px, py, pz, cx, cy, cz, shape_p0[i]);
    } else if (shape_types[i] == SHAPE_CYLINDER) {
        return sdf_cylinder_simd(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i]);
    } else {
        return sdf_box_simd(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i], shape_p2[i]);
    }
}

// Static SIMD constants - initialized via wasm_f32x4_const
#define MAKE_F32X4(v) wasm_f32x4_const(v, v, v, v)

// Used in scene_sdf_simd
static v128_t max_dist_simd;
// Used in lighting calculation
static v128_t light_x;
static v128_t light_y;
static v128_t light_z;
static v128_t zero_simd;
static v128_t ambient_simd;
static v128_t diffuse_simd;

// Initialize SIMD constants - call once at startup
void init_simd_constants(void) {
    max_dist_simd = wasm_f32x4_splat(MAX_DIST);
    light_x = wasm_f32x4_splat(LIGHT_DIR_COMPONENT);
    light_y = wasm_f32x4_splat(LIGHT_DIR_COMPONENT);
    light_z = wasm_f32x4_splat(-LIGHT_DIR_COMPONENT);
    zero_simd = wasm_f32x4_splat(0.0f);
    ambient_simd = wasm_f32x4_splat(AMBIENT_WEIGHT);
    diffuse_simd = wasm_f32x4_splat(DIFFUSE_WEIGHT);
}

static v128_t scene_sdf_simd(v128_t px, v128_t py, v128_t pz) {
    if (shape_count == 0) return max_dist_simd;

    // Hierarchical evaluation: first evaluate each group, then combine groups
    v128_t group_dists[MAX_GROUPS];
    u8 group_initialized[MAX_GROUPS] = {0};

    // Pass 1: Evaluate shapes within each group using group's blend mode
    for (u32 i = 0; i < shape_count; i++) {
        u8 g = shape_groups[i];
        if (g >= group_count) g = 0;  // fallback to group 0

        v128_t d = eval_shape_simd(i, px, py, pz);

        if (!group_initialized[g]) {
            group_dists[g] = d;
            group_initialized[g] = 1;
        } else {
            // group_blend_mode: 0 = hard union (min), 1 = smooth union
            if (group_blend_mode[g] == 0) {
                group_dists[g] = wasm_f32x4_min(group_dists[g], d);
            } else {
                group_dists[g] = sdf_smooth_union_simd(group_dists[g], d, smooth_k_simd);
            }
        }
    }

    // Pass 2: Combine all groups with smooth union
    v128_t result = max_dist_simd;
    u8 first = 1;
    for (u32 g = 0; g < group_count; g++) {
        if (group_initialized[g]) {
            if (first) {
                result = group_dists[g];
                first = 0;
            } else {
                result = sdf_smooth_union_simd(result, group_dists[g], smooth_k_simd);
            }
        }
    }

    return result;
}

// =============================================================================
// Color blending (find closest shape for color)
// =============================================================================

// SIMD batch color lookup - finds closest shape for 4 points, returns colors
// hit_mask: which of the 4 lanes are valid hits (from hit_arr)
static void get_hit_colors_simd(
    v128_t px, v128_t py, v128_t pz,
    i32* hit_mask,
    f32* out_cr, f32* out_cg, f32* out_cb
) {
    v128_t min_dist = wasm_f32x4_splat(MAX_DIST);
    v128_t closest_r = wasm_f32x4_splat(0.0f);
    v128_t closest_g = wasm_f32x4_splat(0.0f);
    v128_t closest_b = wasm_f32x4_splat(0.0f);
    v128_t hit_thresh = wasm_f32x4_splat(HIT_THRESHOLD);

    // Track which lanes have found their closest shape (early out)
    v128_t done = wasm_i32x4_splat(0);
    // Only process lanes that are hits
    v128_t valid = wasm_i32x4_make(hit_mask[0], hit_mask[1], hit_mask[2], hit_mask[3]);

    for (u32 i = 0; i < shape_count; i++) {
        perf_metrics[PERF_COLOR_LOOKUPS] += 1.0f;

        v128_t d = eval_shape_simd(i, px, py, pz);

        // Check which lanes have new minimum
        v128_t is_closer = wasm_f32x4_lt(d, min_dist);
        // Only update lanes that are valid hits and not done
        v128_t should_update = wasm_v128_and(is_closer, wasm_v128_andnot(valid, done));

        // Update min_dist for lanes that are closer
        min_dist = wasm_v128_bitselect(d, min_dist, should_update);

        // Update colors for lanes that are closer (use precomputed splatted colors)
        closest_r = wasm_v128_bitselect(shape_r[i], closest_r, should_update);
        closest_g = wasm_v128_bitselect(shape_g[i], closest_g, should_update);
        closest_b = wasm_v128_bitselect(shape_b[i], closest_b, should_update);

        // Mark lanes as done if they found a very close shape
        v128_t very_close = wasm_f32x4_lt(d, hit_thresh);
        done = wasm_v128_or(done, wasm_v128_and(should_update, very_close));

        // Early out if all valid lanes are done
        v128_t all_done = wasm_v128_or(done, wasm_v128_not(valid));
        if (wasm_i32x4_all_true(all_done)) break;
    }

    wasm_v128_store(out_cr, closest_r);
    wasm_v128_store(out_cg, closest_g);
    wasm_v128_store(out_cb, closest_b);
}

// =============================================================================
// API Functions
// =============================================================================

f32* get_bg_ptr(void) { return bg_color; }
f32* get_ray_ox_ptr(void) { return ray_ox; }
f32* get_ray_oy_ptr(void) { return ray_oy; }
f32* get_ray_oz_ptr(void) { return ray_oz; }
f32* get_ray_dx_ptr(void) { return ray_dx; }
f32* get_ray_dy_ptr(void) { return ray_dy; }
f32* get_ray_dz_ptr(void) { return ray_dz; }
f32* get_out_r_ptr(void) { return out_r; }
f32* get_out_g_ptr(void) { return out_g; }
f32* get_out_b_ptr(void) { return out_b; }

// Scene data pointers
u8* get_shape_types_ptr(void) { return shape_types; }
f32* get_shape_params_ptr(void) { return shape_params; }
f32* get_shape_positions_ptr(void) { return shape_positions; }
f32* get_shape_colors_ptr(void) { return shape_colors; }
u8* get_shape_groups_ptr(void) { return shape_groups; }
u8* get_group_blend_modes_ptr(void) { return group_blend_mode; }

void set_ray_count(u32 count) {
    ray_count = count < MAX_RAYS ? count : MAX_RAYS;
}

// Flag to ensure SIMD constants are initialized once
static u8 simd_constants_initialized = 0;

void set_scene(u32 count, f32 k) {
    // Initialize SIMD constants on first call
    if (!simd_constants_initialized) {
        init_simd_constants();
        simd_constants_initialized = 1;
    }

    shape_count = count < MAX_SHAPES ? count : MAX_SHAPES;
    smooth_k = k;
    smooth_k_simd = wasm_f32x4_splat(k);  // Precompute splatted k

    // Compute scene AABB from all shapes
    if (shape_count == 0) {
        scene_aabb_min[0] = scene_aabb_min[1] = scene_aabb_min[2] = -MAX_DIST;
        scene_aabb_max[0] = scene_aabb_max[1] = scene_aabb_max[2] = MAX_DIST;
        return;
    }

    // Start with first shape bounds
    scene_aabb_min[0] = scene_aabb_min[1] = scene_aabb_min[2] = 1e10f;
    scene_aabb_max[0] = scene_aabb_max[1] = scene_aabb_max[2] = -1e10f;

    for (u32 i = 0; i < shape_count; i++) {
        f32 cx = shape_positions[i * 3];
        f32 cy = shape_positions[i * 3 + 1];
        f32 cz = shape_positions[i * 3 + 2];

        // Precompute splatted SIMD data for the hot SDF loop
        shape_cx[i] = wasm_f32x4_splat(cx);
        shape_cy[i] = wasm_f32x4_splat(cy);
        shape_cz[i] = wasm_f32x4_splat(cz);
        shape_p0[i] = wasm_f32x4_splat(shape_params[i * 4]);
        shape_p1[i] = wasm_f32x4_splat(shape_params[i * 4 + 1]);
        shape_p2[i] = wasm_f32x4_splat(shape_params[i * 4 + 2]);
        shape_r[i] = wasm_f32x4_splat(shape_colors[i * 3]);
        shape_g[i] = wasm_f32x4_splat(shape_colors[i * 3 + 1]);
        shape_b[i] = wasm_f32x4_splat(shape_colors[i * 3 + 2]);

        f32 ex, ey, ez;  // extent from center
        if (shape_types[i] == SHAPE_SPHERE) {
            f32 r = shape_params[i * 4];
            ex = ey = ez = r;
        } else if (shape_types[i] == SHAPE_CYLINDER) {
            // Cylinder along X: params[0]=radius, params[1]=half-height
            f32 r = shape_params[i * 4];
            f32 h = shape_params[i * 4 + 1];
            ex = h;
            ey = ez = r;
        } else {
            ex = shape_params[i * 4];
            ey = shape_params[i * 4 + 1];
            ez = shape_params[i * 4 + 2];
        }

        // Expand AABB
        if (cx - ex < scene_aabb_min[0]) scene_aabb_min[0] = cx - ex;
        if (cy - ey < scene_aabb_min[1]) scene_aabb_min[1] = cy - ey;
        if (cz - ez < scene_aabb_min[2]) scene_aabb_min[2] = cz - ez;
        if (cx + ex > scene_aabb_max[0]) scene_aabb_max[0] = cx + ex;
        if (cy + ey > scene_aabb_max[1]) scene_aabb_max[1] = cy + ey;
        if (cz + ez > scene_aabb_max[2]) scene_aabb_max[2] = cz + ez;
    }

    // Add padding for smooth union blending
    f32 padding = smooth_k * 2.0f;
    scene_aabb_min[0] -= padding;
    scene_aabb_min[1] -= padding;
    scene_aabb_min[2] -= padding;
    scene_aabb_max[0] += padding;
    scene_aabb_max[1] += padding;
    scene_aabb_max[2] += padding;
}

void set_groups(u32 count) {
    group_count = count < MAX_GROUPS ? count : MAX_GROUPS;
}

u32 get_max_shapes(void) { return MAX_SHAPES; }
u32 get_max_groups(void) { return MAX_GROUPS; }

// Set camera parameters (pre-computed from eye, at, up, fov, aspect in JS)
void set_camera(
    f32 ex, f32 ey, f32 ez,      // eye position
    f32 fx, f32 fy, f32 fz,      // forward vector (normalized)
    f32 rx, f32 ry, f32 rz,      // right vector (normalized)
    f32 ux, f32 uy, f32 uz,      // up vector (normalized)
    f32 halfW, f32 halfH         // half FOV extents
) {
    cam_eye[0] = ex; cam_eye[1] = ey; cam_eye[2] = ez;
    cam_forward[0] = fx; cam_forward[1] = fy; cam_forward[2] = fz;
    cam_right[0] = rx; cam_right[1] = ry; cam_right[2] = rz;
    cam_up[0] = ux; cam_up[1] = uy; cam_up[2] = uz;
    cam_half_width = halfW;
    cam_half_height = halfH;
}

// Generate rays directly into ray buffers
// Called after set_camera() and set_ray_count()
void generate_rays(u32 width, u32 height) {
    u32 count = width * height;
    if (count > MAX_RAYS) count = MAX_RAYS;

    f32 inv_w = 1.0f / (f32)(width - 1);
    f32 inv_h = 1.0f / (f32)(height - 1);

    for (u32 row = 0; row < height; row++) {
        f32 v = 1.0f - 2.0f * (f32)row * inv_h;  // +1 top, -1 bottom

        for (u32 col = 0; col < width; col++) {
            u32 idx = row * width + col;
            if (idx >= MAX_RAYS) break;

            f32 u = 2.0f * (f32)col * inv_w - 1.0f;  // -1 left, +1 right

            // Origin = camera eye
            ray_ox[idx] = cam_eye[0];
            ray_oy[idx] = cam_eye[1];
            ray_oz[idx] = cam_eye[2];

            // Direction = forward + u*halfW*right + v*halfH*up (then normalize)
            f32 dx = cam_forward[0] + u * cam_half_width * cam_right[0] + v * cam_half_height * cam_up[0];
            f32 dy = cam_forward[1] + u * cam_half_width * cam_right[1] + v * cam_half_height * cam_up[1];
            f32 dz = cam_forward[2] + u * cam_half_width * cam_right[2] + v * cam_half_height * cam_up[2];

            // Normalize
            f32 len = sqrtf_approx(dx*dx + dy*dy + dz*dz);
            if (len > 0.0f) {
                f32 inv_len = 1.0f / len;
                dx *= inv_len;
                dy *= inv_len;
                dz *= inv_len;
            }

            ray_dx[idx] = dx;
            ray_dy[idx] = dy;
            ray_dz[idx] = dz;
        }
    }

    ray_count = count;
}

void compute_background(f32 time) {
    f32 base_r = 0.02f;
    f32 base_g = 0.02f;
    f32 base_b = 0.03f;
    f32 osc1 = sinf_approx(time * 0.5f) * 0.01f;
    f32 osc2 = sinf_approx(time * 0.3f + 1.0f) * 0.01f;
    f32 osc3 = sinf_approx(time * 0.7f + 2.0f) * 0.015f;
    bg_color[0] = clampf(base_r + osc1, 0.0f, 1.0f);
    bg_color[1] = clampf(base_g + osc2, 0.0f, 1.0f);
    bg_color[2] = clampf(base_b + osc3, 0.0f, 1.0f);
}

// =============================================================================
// Ray Marching (SIMD - 4 rays at a time)
// =============================================================================

void march_rays(void) {
    u32 batch_count = (ray_count + 3) / 4;

    // Track steps per batch for metrics
    u32 total_steps_all = 0;
    u32 total_hits = 0;
    u32 total_misses = 0;

    for (u32 batch = 0; batch < batch_count; batch++) {
        u32 base = batch * 4;

        // Load ray origins and directions
        v128_t ox = wasm_v128_load(&ray_ox[base]);
        v128_t oy = wasm_v128_load(&ray_oy[base]);
        v128_t oz = wasm_v128_load(&ray_oz[base]);
        v128_t dx = wasm_v128_load(&ray_dx[base]);
        v128_t dy = wasm_v128_load(&ray_dy[base]);
        v128_t dz = wasm_v128_load(&ray_dz[base]);

        // Current positions
        v128_t px = ox;
        v128_t py = oy;
        v128_t pz = oz;

        // Total distance traveled
        v128_t total_dist = wasm_f32x4_splat(0.0f);

        // Active mask
        v128_t active = wasm_i32x4_splat(-1);

        v128_t max_dist = wasm_f32x4_splat(MAX_DIST);
        v128_t hit_thresh = wasm_f32x4_splat(HIT_THRESHOLD);

        // Track accumulated hits across all steps
        v128_t accumulated_hit = wasm_i32x4_splat(0);

        u32 steps_this_batch = 0;
        for (int step = 0; step < MAX_STEPS; step++) {
            v128_t dist = scene_sdf_simd(px, py, pz);
            steps_this_batch++;

            v128_t hit = wasm_f32x4_lt(dist, hit_thresh);
            v128_t miss = wasm_f32x4_gt(total_dist, max_dist);

            // Accumulate hits as they happen
            accumulated_hit = wasm_v128_or(accumulated_hit, hit);

            active = wasm_v128_andnot(active, wasm_v128_or(hit, miss));

            if (!wasm_v128_any_true(active)) break;

            v128_t step_dist = wasm_v128_and(dist, active);
            px = wasm_f32x4_add(px, wasm_f32x4_mul(dx, step_dist));
            py = wasm_f32x4_add(py, wasm_f32x4_mul(dy, step_dist));
            pz = wasm_f32x4_add(pz, wasm_f32x4_mul(dz, step_dist));
            total_dist = wasm_f32x4_add(total_dist, step_dist);
        }

        total_steps_all += steps_this_batch;
        perf_metrics[PERF_TOTAL_SDF_CALLS] += (f32)steps_this_batch;

        // Use accumulated hit state - no need for final SDF call
        v128_t hit = accumulated_hit;

        // Extract hit mask to check if ANY ray hit
        i32 hit_arr[4];
        wasm_v128_store(hit_arr, hit);

        // Check if any ray in this batch hit
        i32 any_hit = hit_arr[0] | hit_arr[1] | hit_arr[2] | hit_arr[3];

        // Only compute normals if at least one ray hit
        f32 bright_arr[4] = {0.0f, 0.0f, 0.0f, 0.0f};

        if (any_hit) {
            // Compute normals using tetrahedron technique - 4 SDF calls instead of 6
            // Based on https://iquilezles.org/articles/normalsSDF/
            v128_t eps = wasm_f32x4_splat(NORMAL_EPS);
            v128_t neg_eps = wasm_f32x4_splat(-NORMAL_EPS);

            // Tetrahedron vertices: (+,+,-), (+,-,+), (-,+,+), (-,-,-)
            v128_t d0 = scene_sdf_simd(
                wasm_f32x4_add(px, eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, neg_eps));
            v128_t d1 = scene_sdf_simd(
                wasm_f32x4_add(px, eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, eps));
            v128_t d2 = scene_sdf_simd(
                wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, eps));
            v128_t d3 = scene_sdf_simd(
                wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, neg_eps));

            // Combine: nx = d0 + d1 - d2 - d3, ny = d0 - d1 + d2 - d3, nz = -d0 + d1 + d2 - d3
            v128_t nx = wasm_f32x4_sub(wasm_f32x4_add(d0, d1), wasm_f32x4_add(d2, d3));
            v128_t ny = wasm_f32x4_sub(wasm_f32x4_add(d0, d2), wasm_f32x4_add(d1, d3));
            v128_t nz = wasm_f32x4_sub(wasm_f32x4_add(d1, d2), wasm_f32x4_add(d0, d3));

            perf_metrics[PERF_NORMAL_SDF_CALLS] += 4.0f;  // 4 SDF calls for normals

            // Normalize using fast reciprocal sqrt approximation
            v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
                wasm_f32x4_mul(nx, nx),
                wasm_f32x4_mul(ny, ny)),
                wasm_f32x4_mul(nz, nz));
            v128_t inv_len = wasm_f32x4_div(wasm_f32x4_splat(1.0f), wasm_f32x4_sqrt(len_sq));
            nx = wasm_f32x4_mul(nx, inv_len);
            ny = wasm_f32x4_mul(ny, inv_len);
            nz = wasm_f32x4_mul(nz, inv_len);

            // N dot L (using precomputed light direction constants)
            v128_t ndotl = wasm_f32x4_add(wasm_f32x4_add(
                wasm_f32x4_mul(nx, light_x),
                wasm_f32x4_mul(ny, light_y)),
                wasm_f32x4_mul(nz, light_z));
            ndotl = wasm_f32x4_max(ndotl, zero_simd);

            // Ambient + diffuse (using precomputed constants)
            v128_t brightness = wasm_f32x4_add(
                ambient_simd,
                wasm_f32x4_mul(ndotl, diffuse_simd)
            );

            wasm_v128_store(bright_arr, brightness);
        }

        // Get colors for all 4 rays in batch using SIMD
        f32 cr_arr[4], cg_arr[4], cb_arr[4];
        if (any_hit) {
            get_hit_colors_simd(px, py, pz, hit_arr, cr_arr, cg_arr, cb_arr);
        }

        for (int i = 0; i < 4; i++) {
            u32 idx = base + i;
            if (idx >= ray_count) break;

            if (hit_arr[i]) {
                total_hits++;
                out_r[idx] = bright_arr[i] * cr_arr[i];
                out_g[idx] = bright_arr[i] * cg_arr[i];
                out_b[idx] = bright_arr[i] * cb_arr[i];
            } else {
                total_misses++;
                out_r[idx] = bg_color[0];
                out_g[idx] = bg_color[1];
                out_b[idx] = bg_color[2];
            }
        }
    }

    // Finalize metrics
    perf_metrics[PERF_TOTAL_STEPS] = (f32)total_steps_all;
    perf_metrics[PERF_EARLY_HITS] = (f32)total_hits;
    perf_metrics[PERF_MISSES] = (f32)total_misses;
    u32 active_batches = batch_count > 0 ? batch_count : 1;
    perf_metrics[PERF_AVG_STEPS] = (f32)total_steps_all / (f32)active_batches;
    perf_metrics[PERF_HIT_RATE] = (ray_count > 0) ? (100.0f * (f32)total_hits / (f32)ray_count) : 0.0f;
}

u32 get_max_rays(void) { return MAX_RAYS; }

// =============================================================================
// Compositing (RGB floats -> ASCII char + RGBA floats for OpenTUI)
// =============================================================================

u32* get_out_char_ptr(void) { return out_char; }
f32* get_out_fg_ptr(void) { return out_fg; }
f32* get_out_bg_ptr(void) { return out_bg; }

// ASCII ramp: " .:-=+*#%@" (10 chars)
static const char ascii_ramp[10] = {' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'};

// Bayer 2x2 dither matrix
static const f32 bayer2x2[4] = {-0.075f, 0.0f, 0.0375f, -0.0375f};

// Composite RGB to ASCII + RGBA (directly compatible with OpenTUI bulk copy)
void composite(u32 width, u32 height) {
    u32 count = width * height;
    if (count > MAX_RAYS) count = MAX_RAYS;

    u32 i = 0;
    for (u32 row = 0; row < height; row++) {
        u32 row_bit = (row & 1) * 2;  // Precompute row contribution to dither

        for (u32 col = 0; col < width; col++, i++) {
            if (i >= MAX_RAYS) break;

            f32 r = out_r[i];
            f32 g = out_g[i];
            f32 b = out_b[i];

            // Brightness with dither
            f32 brightness = (r + g + b) * RGB_AVG_DIVISOR;
            u32 dither_idx = row_bit + (col & 1);
            brightness += bayer2x2[dither_idx];

            // Clamp and map to ASCII
            if (brightness < 0.0f) brightness = 0.0f;
            if (brightness > 1.0f) brightness = 1.0f;

            u32 fg_base = i * 4;

            // Check if pixel has color (not background)
            if (r > BG_THRESHOLD || g > BG_THRESHOLD || b > BG_THRESHOLD) {
                i32 char_idx = (i32)(brightness * ASCII_RAMP_MAX_IDX);
                if (char_idx < 0) char_idx = 0;
                if (char_idx > 9) char_idx = 9;

                out_char[i] = (u32)ascii_ramp[char_idx];
                out_fg[fg_base]     = r;
                out_fg[fg_base + 1] = g;
                out_fg[fg_base + 2] = b;
                out_fg[fg_base + 3] = 1.0f;
            } else {
                // Dark background: '@' with dark color
                out_char[i] = '@';
                out_fg[fg_base]     = BG_FILL_R;
                out_fg[fg_base + 1] = BG_FILL_G;
                out_fg[fg_base + 2] = BG_FILL_B;
                out_fg[fg_base + 3] = 1.0f;
            }
        }
    }
}

// =============================================================================
// Block Compositor (RGB floats -> Unicode blocks + RGBA fg/bg for OpenTUI)
// Uses half-block characters for 2x vertical resolution per cell
// =============================================================================

// Unicode block characters
#define BLOCK_FULL  0x2588  // █ - full block
#define BLOCK_UPPER 0x2580  // ▀ - upper half block
#define BLOCK_LOWER 0x2584  // ▄ - lower half block

// Composite using Unicode half-blocks - each cell represents 2 vertical pixels
// Top pixel -> fg color, Bottom pixel -> bg color, character selects which half is fg
void composite_blocks(u32 width, u32 height) {
    // Output has half the height (each output cell = 2 input rows)
    u32 out_height = height / 2;
    u32 out_count = width * out_height;
    if (out_count > MAX_RAYS) out_count = MAX_RAYS;

    for (u32 out_row = 0; out_row < out_height; out_row++) {
        u32 top_row = out_row * 2;
        u32 bot_row = top_row + 1;
        if (bot_row >= height) bot_row = top_row;  // Handle odd height

        for (u32 col = 0; col < width; col++) {
            u32 out_idx = out_row * width + col;
            if (out_idx >= MAX_RAYS) break;

            u32 top_idx = top_row * width + col;
            u32 bot_idx = bot_row * width + col;

            // Get colors for top and bottom pixels
            f32 top_r = out_r[top_idx];
            f32 top_g = out_g[top_idx];
            f32 top_b = out_b[top_idx];
            f32 bot_r = out_r[bot_idx];
            f32 bot_g = out_g[bot_idx];
            f32 bot_b = out_b[bot_idx];

            // Check if pixels are "bright" (not background)
            f32 top_bright = (top_r + top_g + top_b) * RGB_AVG_DIVISOR;
            f32 bot_bright = (bot_r + bot_g + bot_b) * RGB_AVG_DIVISOR;
            i32 top_on = top_bright > BG_THRESHOLD;
            i32 bot_on = bot_bright > BG_THRESHOLD;

            u32 fg_base = out_idx * 4;
            u32 bg_base = out_idx * 4;

            if (top_on && bot_on) {
                // Both lit: use full block with averaged color, bg doesn't matter much
                out_char[out_idx] = BLOCK_FULL;
                out_fg[fg_base]     = (top_r + bot_r) * 0.5f;
                out_fg[fg_base + 1] = (top_g + bot_g) * 0.5f;
                out_fg[fg_base + 2] = (top_b + bot_b) * 0.5f;
                out_fg[fg_base + 3] = 1.0f;
                out_bg[bg_base]     = (top_r + bot_r) * 0.5f;
                out_bg[bg_base + 1] = (top_g + bot_g) * 0.5f;
                out_bg[bg_base + 2] = (top_b + bot_b) * 0.5f;
                out_bg[bg_base + 3] = 1.0f;
            } else if (top_on && !bot_on) {
                // Top lit, bottom dark: upper half block, fg=top, bg=bottom
                out_char[out_idx] = BLOCK_UPPER;
                out_fg[fg_base]     = top_r;
                out_fg[fg_base + 1] = top_g;
                out_fg[fg_base + 2] = top_b;
                out_fg[fg_base + 3] = 1.0f;
                out_bg[bg_base]     = bot_r;
                out_bg[bg_base + 1] = bot_g;
                out_bg[bg_base + 2] = bot_b;
                out_bg[bg_base + 3] = 1.0f;
            } else if (!top_on && bot_on) {
                // Top dark, bottom lit: lower half block, fg=bottom, bg=top
                out_char[out_idx] = BLOCK_LOWER;
                out_fg[fg_base]     = bot_r;
                out_fg[fg_base + 1] = bot_g;
                out_fg[fg_base + 2] = bot_b;
                out_fg[fg_base + 3] = 1.0f;
                out_bg[bg_base]     = top_r;
                out_bg[bg_base + 1] = top_g;
                out_bg[bg_base + 2] = top_b;
                out_bg[bg_base + 3] = 1.0f;
            } else {
                // Both dark: space with background color
                out_char[out_idx] = ' ';
                out_fg[fg_base]     = bg_color[0];
                out_fg[fg_base + 1] = bg_color[1];
                out_fg[fg_base + 2] = bg_color[2];
                out_fg[fg_base + 3] = 1.0f;
                out_bg[bg_base]     = bg_color[0];
                out_bg[bg_base + 1] = bg_color[1];
                out_bg[bg_base + 2] = bg_color[2];
                out_bg[bg_base + 3] = 1.0f;
            }
        }
    }
}

// =============================================================================
// Upscaling (nearest neighbor from native to output resolution)
// =============================================================================

u32* get_upscaled_char_ptr(void) { return upscaled_char; }
f32* get_upscaled_fg_ptr(void) { return upscaled_fg; }
u32 get_max_upscaled(void) { return MAX_RAYS; }

// Nearest-neighbor upscale from out_char/out_fg to upscaled_char/upscaled_fg
// native_width/height: dimensions of the composited output (out_char/out_fg)
// output_width/height: dimensions of the upscaled output (terminal size)
// scale: integer scale factor (output = native * scale, roughly)
void upscale(u32 native_width, u32 native_height, u32 output_width, u32 output_height, u32 scale) {
    u32 out_count = output_width * output_height;
    if (out_count > MAX_RAYS) out_count = MAX_RAYS;

    u32 out_idx = 0;
    for (u32 out_row = 0; out_row < output_height; out_row++) {
        // Hoist native_row computation - constant for entire row
        u32 native_row = out_row / scale;
        if (native_row >= native_height) native_row = native_height - 1;
        u32 native_row_offset = native_row * native_width;

        for (u32 out_col = 0; out_col < output_width; out_col++, out_idx++) {
            if (out_idx >= MAX_RAYS) break;

            // Map output col to native col (nearest neighbor)
            u32 native_col = out_col / scale;
            if (native_col >= native_width) native_col = native_width - 1;

            u32 native_idx = native_row_offset + native_col;

            // Copy char
            upscaled_char[out_idx] = out_char[native_idx];

            // Copy fg (4 floats)
            u32 out_fg_base = out_idx * 4;
            u32 native_fg_base = native_idx * 4;
            upscaled_fg[out_fg_base]     = out_fg[native_fg_base];
            upscaled_fg[out_fg_base + 1] = out_fg[native_fg_base + 1];
            upscaled_fg[out_fg_base + 2] = out_fg[native_fg_base + 2];
            upscaled_fg[out_fg_base + 3] = out_fg[native_fg_base + 3];
        }
    }
}
