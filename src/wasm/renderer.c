// WASM Raymarcher with SIMD
// Compile: clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export-all -o renderer.wasm renderer.c

#include <wasm_simd128.h>

typedef unsigned int u32;
typedef int i32;
typedef float f32;

// =============================================================================
// Constants
// =============================================================================

#define MAX_RAYS 16384      // 128x128 max resolution
#define MAX_STEPS 32
#define MAX_DIST 100.0f
#define HIT_THRESHOLD 0.01f
#define NORMAL_EPS 0.001f

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

// Background color
static f32 bg_color[3];

// Current ray count
static u32 ray_count = 0;

// =============================================================================
// Math helpers
// =============================================================================

static f32 sqrtf_approx(f32 x) {
    // Newton-Raphson iteration
    if (x <= 0.0f) return 0.0f;
    f32 guess = x * 0.5f;
    for (int i = 0; i < 5; i++) {
        guess = 0.5f * (guess + x / guess);
    }
    return guess;
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

// =============================================================================
// SDF Primitives (scalar versions for normal estimation)
// =============================================================================

static f32 sdf_sphere(f32 px, f32 py, f32 pz, f32 cx, f32 cy, f32 cz, f32 r) {
    f32 dx = px - cx;
    f32 dy = py - cy;
    f32 dz = pz - cz;
    return sqrtf_approx(dx*dx + dy*dy + dz*dz) - r;
}

static f32 sdf_box(f32 px, f32 py, f32 pz, f32 cx, f32 cy, f32 cz, f32 bx, f32 by, f32 bz) {
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

// Smooth union
static f32 sdf_smooth_union(f32 d1, f32 d2, f32 k) {
    f32 h = clampf(0.5f + 0.5f * (d2 - d1) / k, 0.0f, 1.0f);
    return d2 + (d1 - d2) * h - k * h * (1.0f - h);
}

// =============================================================================
// Hardcoded Scene: Two spheres with smooth union
// =============================================================================

// Scene: sphere at (-1.5, 0, 0) r=1.2, sphere at (1.5, 0, 0) r=1.2
// Color: green-ish (0.4, 0.6, 0.5)
#define SPHERE1_X -1.5f
#define SPHERE1_Y 0.0f
#define SPHERE1_Z 0.0f
#define SPHERE1_R 1.2f

#define SPHERE2_X 1.5f
#define SPHERE2_Y 0.0f
#define SPHERE2_Z 0.0f
#define SPHERE2_R 1.2f

#define SMOOTH_K 0.8f

#define SCENE_COLOR_R 0.4f
#define SCENE_COLOR_G 0.6f
#define SCENE_COLOR_B 0.5f

static f32 scene_sdf(f32 px, f32 py, f32 pz) {
    f32 d1 = sdf_sphere(px, py, pz, SPHERE1_X, SPHERE1_Y, SPHERE1_Z, SPHERE1_R);
    f32 d2 = sdf_sphere(px, py, pz, SPHERE2_X, SPHERE2_Y, SPHERE2_Z, SPHERE2_R);
    return sdf_smooth_union(d1, d2, SMOOTH_K);
}

// =============================================================================
// SIMD Scene SDF (4 points at once)
// =============================================================================

static v128_t scene_sdf_simd(v128_t px, v128_t py, v128_t pz) {
    // Sphere 1
    v128_t s1x = wasm_f32x4_splat(SPHERE1_X);
    v128_t s1y = wasm_f32x4_splat(SPHERE1_Y);
    v128_t s1z = wasm_f32x4_splat(SPHERE1_Z);
    v128_t s1r = wasm_f32x4_splat(SPHERE1_R);
    
    v128_t dx1 = wasm_f32x4_sub(px, s1x);
    v128_t dy1 = wasm_f32x4_sub(py, s1y);
    v128_t dz1 = wasm_f32x4_sub(pz, s1z);
    v128_t len1_sq = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(dx1, dx1),
        wasm_f32x4_mul(dy1, dy1)),
        wasm_f32x4_mul(dz1, dz1));
    v128_t d1 = wasm_f32x4_sub(wasm_f32x4_sqrt(len1_sq), s1r);
    
    // Sphere 2
    v128_t s2x = wasm_f32x4_splat(SPHERE2_X);
    v128_t s2y = wasm_f32x4_splat(SPHERE2_Y);
    v128_t s2z = wasm_f32x4_splat(SPHERE2_Z);
    v128_t s2r = wasm_f32x4_splat(SPHERE2_R);
    
    v128_t dx2 = wasm_f32x4_sub(px, s2x);
    v128_t dy2 = wasm_f32x4_sub(py, s2y);
    v128_t dz2 = wasm_f32x4_sub(pz, s2z);
    v128_t len2_sq = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(dx2, dx2),
        wasm_f32x4_mul(dy2, dy2)),
        wasm_f32x4_mul(dz2, dz2));
    v128_t d2 = wasm_f32x4_sub(wasm_f32x4_sqrt(len2_sq), s2r);
    
    // Smooth union
    v128_t k = wasm_f32x4_splat(SMOOTH_K);
    v128_t half = wasm_f32x4_splat(0.5f);
    v128_t one = wasm_f32x4_splat(1.0f);
    v128_t zero = wasm_f32x4_splat(0.0f);
    
    // h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0, 1)
    v128_t diff = wasm_f32x4_sub(d2, d1);
    v128_t h = wasm_f32x4_add(half, wasm_f32x4_mul(half, wasm_f32x4_div(diff, k)));
    h = wasm_f32x4_max(zero, wasm_f32x4_min(one, h));
    
    // result = d2 + (d1 - d2) * h - k * h * (1 - h)
    v128_t result = wasm_f32x4_add(d2,
        wasm_f32x4_sub(
            wasm_f32x4_mul(wasm_f32x4_sub(d1, d2), h),
            wasm_f32x4_mul(k, wasm_f32x4_mul(h, wasm_f32x4_sub(one, h)))
        )
    );
    
    return result;
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

void set_ray_count(u32 count) {
    ray_count = count < MAX_RAYS ? count : MAX_RAYS;
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
    // Process rays in batches of 4
    u32 batch_count = (ray_count + 3) / 4;
    
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
        
        // Hit mask (all ones = still marching)
        v128_t active = wasm_i32x4_splat(-1);
        
        v128_t max_dist = wasm_f32x4_splat(MAX_DIST);
        v128_t hit_thresh = wasm_f32x4_splat(HIT_THRESHOLD);
        
        for (int step = 0; step < MAX_STEPS; step++) {
            // Evaluate SDF at current positions
            v128_t dist = scene_sdf_simd(px, py, pz);
            
            // Check for hits (dist < HIT_THRESHOLD)
            v128_t hit = wasm_f32x4_lt(dist, hit_thresh);
            
            // Check for misses (total_dist > MAX_DIST)
            v128_t miss = wasm_f32x4_gt(total_dist, max_dist);
            
            // Update active mask
            active = wasm_v128_andnot(active, wasm_v128_or(hit, miss));
            
            // Early exit if no rays active
            if (!wasm_v128_any_true(active)) break;
            
            // Advance positions (only active rays)
            v128_t step_dist = wasm_v128_and(dist, active);
            px = wasm_f32x4_add(px, wasm_f32x4_mul(dx, step_dist));
            py = wasm_f32x4_add(py, wasm_f32x4_mul(dy, step_dist));
            pz = wasm_f32x4_add(pz, wasm_f32x4_mul(dz, step_dist));
            total_dist = wasm_f32x4_add(total_dist, step_dist);
        }
        
        // Final hit test
        v128_t final_dist = scene_sdf_simd(px, py, pz);
        v128_t hit = wasm_f32x4_lt(final_dist, hit_thresh);
        
        // Compute normals for hit points (central differences)
        v128_t eps = wasm_f32x4_splat(NORMAL_EPS);
        
        v128_t nx = wasm_f32x4_sub(
            scene_sdf_simd(wasm_f32x4_add(px, eps), py, pz),
            scene_sdf_simd(wasm_f32x4_sub(px, eps), py, pz)
        );
        v128_t ny = wasm_f32x4_sub(
            scene_sdf_simd(px, wasm_f32x4_add(py, eps), pz),
            scene_sdf_simd(px, wasm_f32x4_sub(py, eps), pz)
        );
        v128_t nz = wasm_f32x4_sub(
            scene_sdf_simd(px, py, wasm_f32x4_add(pz, eps)),
            scene_sdf_simd(px, py, wasm_f32x4_sub(pz, eps))
        );
        
        // Normalize
        v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
            wasm_f32x4_mul(nx, nx),
            wasm_f32x4_mul(ny, ny)),
            wasm_f32x4_mul(nz, nz));
        v128_t inv_len = wasm_f32x4_div(wasm_f32x4_splat(1.0f), wasm_f32x4_sqrt(len_sq));
        nx = wasm_f32x4_mul(nx, inv_len);
        ny = wasm_f32x4_mul(ny, inv_len);
        nz = wasm_f32x4_mul(nz, inv_len);
        
        // Simple directional light from (1, 1, -1) normalized
        const f32 light_x = 0.577f;  // 1/sqrt(3)
        const f32 light_y = 0.577f;
        const f32 light_z = -0.577f;
        
        v128_t lx = wasm_f32x4_splat(light_x);
        v128_t ly = wasm_f32x4_splat(light_y);
        v128_t lz = wasm_f32x4_splat(light_z);
        
        // N dot L
        v128_t ndotl = wasm_f32x4_add(wasm_f32x4_add(
            wasm_f32x4_mul(nx, lx),
            wasm_f32x4_mul(ny, ly)),
            wasm_f32x4_mul(nz, lz));
        ndotl = wasm_f32x4_max(ndotl, wasm_f32x4_splat(0.0f));
        
        // Ambient + diffuse
        v128_t ambient = wasm_f32x4_splat(0.1f);
        v128_t brightness = wasm_f32x4_add(ambient, wasm_f32x4_mul(ndotl, wasm_f32x4_splat(0.9f)));
        
        // Apply scene color
        v128_t r = wasm_f32x4_mul(brightness, wasm_f32x4_splat(SCENE_COLOR_R));
        v128_t g = wasm_f32x4_mul(brightness, wasm_f32x4_splat(SCENE_COLOR_G));
        v128_t b = wasm_f32x4_mul(brightness, wasm_f32x4_splat(SCENE_COLOR_B));
        
        // Background for misses
        v128_t bg_r = wasm_f32x4_splat(bg_color[0]);
        v128_t bg_g = wasm_f32x4_splat(bg_color[1]);
        v128_t bg_b = wasm_f32x4_splat(bg_color[2]);
        
        // Select hit color or background
        r = wasm_v128_bitselect(r, bg_r, hit);
        g = wasm_v128_bitselect(g, bg_g, hit);
        b = wasm_v128_bitselect(b, bg_b, hit);
        
        // Store results
        wasm_v128_store(&out_r[base], r);
        wasm_v128_store(&out_g[base], g);
        wasm_v128_store(&out_b[base], b);
    }
}

u32 get_max_rays(void) { return MAX_RAYS; }
