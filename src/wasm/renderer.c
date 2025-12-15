#include <wasm_simd128.h>

///////////
// TYPES //
///////////
typedef unsigned int u32;
typedef unsigned char u8;
typedef int i32;
typedef float f32;

///////////////
// CONSTANTS //
///////////////
#define MAX_RAYS 16384
#define MAX_SHAPES 64
#define MAX_STEPS 64
#define MAX_DIST 100.0f
#define HIT_THRESHOLD 0.001f
#define NORMAL_EPS 0.001f

#define SHAPE_SPHERE 0
#define SHAPE_BOX 1
#define SHAPE_CYLINDER 2
#define SHAPE_CONE 3
#define SHAPE_CYLINDER_Y 4

#define PERF_METRICS_SIZE 16
#define PERF_TOTAL_STEPS 0
#define PERF_TOTAL_SDF_CALLS 1
#define PERF_NORMAL_SDF_CALLS 2
#define PERF_COLOR_LOOKUPS 3
#define PERF_EARLY_HITS 4
#define PERF_MISSES 5
#define PERF_AVG_STEPS 6
#define PERF_HIT_RATE 7

#define MAX_POINT_LIGHTS 8
#define MAX_GROUPS 8

#define RGB_AVG_DIVISOR 0.333333f
#define BG_THRESHOLD 0.04f
#define ASCII_RAMP_MAX_IDX 9.0f
#define BG_FILL_R 0.03f
#define BG_FILL_G 0.05f
#define BG_FILL_B 0.04f

#define SQRT_ITERATIONS 5

#define MAKE_F32X4(v) wasm_f32x4_const(v, v, v, v)

#define BLOCK_FULL  0x2588
#define BLOCK_UPPER 0x2580
#define BLOCK_LOWER 0x2584

/////////////
// BUFFERS //
/////////////
f32 light_dir[3] = {0.577f, 0.577f, -0.577f};
f32 light_intensity = 1.0f;
f32 ambient_weight = 0.1f;

f32 point_light_x[MAX_POINT_LIGHTS];
f32 point_light_y[MAX_POINT_LIGHTS];
f32 point_light_z[MAX_POINT_LIGHTS];
f32 point_light_r[MAX_POINT_LIGHTS];
f32 point_light_g[MAX_POINT_LIGHTS];
f32 point_light_b[MAX_POINT_LIGHTS];
f32 point_light_intensity[MAX_POINT_LIGHTS];
f32 point_light_radius[MAX_POINT_LIGHTS];
u32 point_light_count = 0;

v128_t pl_x_simd[MAX_POINT_LIGHTS];
v128_t pl_y_simd[MAX_POINT_LIGHTS];
v128_t pl_z_simd[MAX_POINT_LIGHTS];
v128_t pl_r_simd[MAX_POINT_LIGHTS];
v128_t pl_g_simd[MAX_POINT_LIGHTS];
v128_t pl_b_simd[MAX_POINT_LIGHTS];
v128_t pl_intensity_simd[MAX_POINT_LIGHTS];
v128_t pl_radius_simd[MAX_POINT_LIGHTS];

f32 ray_ox[MAX_RAYS];
f32 ray_oy[MAX_RAYS];
f32 ray_oz[MAX_RAYS];
f32 ray_dx[MAX_RAYS];
f32 ray_dy[MAX_RAYS];
f32 ray_dz[MAX_RAYS];

f32 out_r[MAX_RAYS];
f32 out_g[MAX_RAYS];
f32 out_b[MAX_RAYS];

u32 out_char[MAX_RAYS];
f32 out_fg[MAX_RAYS * 4];
f32 out_bg[MAX_RAYS * 4];

u32 upscaled_char[MAX_RAYS];
f32 upscaled_fg[MAX_RAYS * 4];

f32 bg_color[3];

u8 shape_types[MAX_SHAPES];
f32 shape_params[MAX_SHAPES * 4];
f32 shape_positions[MAX_SHAPES * 3];
f32 shape_colors[MAX_SHAPES * 3];
u8 shape_groups[MAX_SHAPES];
u32 shape_count = 0;
f32 smooth_k = 0.5f;

f32 scene_aabb_min[3];
f32 scene_aabb_max[3];

u8 group_blend_mode[MAX_GROUPS];
u32 group_count = 0;

v128_t shape_cx[MAX_SHAPES];
v128_t shape_cy[MAX_SHAPES];
v128_t shape_cz[MAX_SHAPES];
v128_t shape_p0[MAX_SHAPES];
v128_t shape_p1[MAX_SHAPES];
v128_t shape_p2[MAX_SHAPES];
v128_t shape_r[MAX_SHAPES];
v128_t shape_g[MAX_SHAPES];
v128_t shape_b[MAX_SHAPES];

v128_t smooth_k_simd;

u32 ray_count = 0;

f32 cam_eye[3];
f32 cam_forward[3];
f32 cam_right[3];
f32 cam_up[3];
f32 cam_half_width;
f32 cam_half_height;

f32 perf_metrics[PERF_METRICS_SIZE];

v128_t max_dist_simd;
v128_t light_x_simd;
v128_t light_y_simd;
v128_t light_z_simd;
v128_t zero_simd;
v128_t ambient_simd;
v128_t diffuse_simd;

u8 simd_constants_initialized = 0;

const char ascii_ramp[10] = {' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'};
const f32 bayer2x2[4] = {-0.075f, 0.0f, 0.0375f, -0.0375f};

f32    sqrtf_approx(f32 x);
f32    sinf_approx(f32 x);
f32    maxf(f32 a, f32 b);
f32    minf(f32 a, f32 b);
f32    clampf(f32 x, f32 lo, f32 hi);
v128_t sdf_sphere(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r);
v128_t sdf_box(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t bx, v128_t by, v128_t bz);
v128_t sdf_cylinder(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h);
v128_t sdf_cone(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h);
v128_t sdf_cylinder_y(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h);
v128_t sdf_smooth_union(v128_t d1, v128_t d2, v128_t k);
v128_t eval_shape(u32 i, v128_t px, v128_t py, v128_t pz);
v128_t scene_sdf(v128_t px, v128_t py, v128_t pz);
void   get_hit_colors(v128_t px, v128_t py, v128_t pz, i32* hit_mask, f32* out_cr, f32* out_cg, f32* out_cb);
void   init_simd_constants(void);

/////////
// API //
/////////
f32* get_perf_metrics_ptr(void);
void reset_perf_metrics(void);
f32* get_bg_ptr(void);
f32* get_ray_ox_ptr(void);
f32* get_ray_oy_ptr(void);
f32* get_ray_oz_ptr(void);
f32* get_ray_dx_ptr(void);
f32* get_ray_dy_ptr(void);
f32* get_ray_dz_ptr(void);
f32* get_out_r_ptr(void);
f32* get_out_g_ptr(void);
f32* get_out_b_ptr(void);
u8*  get_shape_types_ptr(void);
f32* get_shape_params_ptr(void);
f32* get_shape_positions_ptr(void);
f32* get_shape_colors_ptr(void);
u8*  get_shape_groups_ptr(void);
u8*  get_group_blend_modes_ptr(void);
void set_ray_count(u32 count);
void set_scene(u32 count, f32 k);
void set_groups(u32 count);
u32  get_max_shapes(void);
u32  get_max_groups(void);
f32* get_point_light_x_ptr(void);
f32* get_point_light_y_ptr(void);
f32* get_point_light_z_ptr(void);
f32* get_point_light_r_ptr(void);
f32* get_point_light_g_ptr(void);
f32* get_point_light_b_ptr(void);
f32* get_point_light_intensity_ptr(void);
f32* get_point_light_radius_ptr(void);
u32  get_max_point_lights(void);
void set_point_lights(u32 count);
void set_camera(f32 ex, f32 ey, f32 ez, f32 fx, f32 fy, f32 fz, f32 rx, f32 ry, f32 rz, f32 ux, f32 uy, f32 uz, f32 halfW, f32 halfH);
void generate_rays(u32 width, u32 height);
void compute_background(f32 time);
void set_lighting(f32 ambient, f32 dir_x, f32 dir_y, f32 dir_z, f32 intensity);
void march_rays(void);
u32  get_max_rays(void);
u32* get_out_char_ptr(void);
f32* get_out_fg_ptr(void);
f32* get_out_bg_ptr(void);
void composite(u32 width, u32 height);
void composite_blocks(u32 width, u32 height);
u32* get_upscaled_char_ptr(void);
f32* get_upscaled_fg_ptr(void);
u32  get_max_upscaled(void);
void upscale(u32 native_width, u32 native_height, u32 output_width, u32 output_height, u32 scale);

//////////
// MATH //
//////////
f32 sqrtf_approx(f32 x) {
  if (x <= 0.0f) return 0.0f;
  return wasm_f32x4_extract_lane(wasm_f32x4_sqrt(wasm_f32x4_splat(x)), 0);
}

f32 sinf_approx(f32 x) {
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

f32 maxf(f32 a, f32 b) {
  return a > b ? a : b;
}

f32 minf(f32 a, f32 b) {
  return a < b ? a : b;
}

f32 clampf(f32 x, f32 lo, f32 hi) {
  return minf(maxf(x, lo), hi);
}

/////////
// SDF //
/////////
v128_t sdf_sphere(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r) {
  v128_t dx = wasm_f32x4_sub(px, cx);
  v128_t dy = wasm_f32x4_sub(py, cy);
  v128_t dz = wasm_f32x4_sub(pz, cz);
  v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
    wasm_f32x4_mul(dx, dx),
    wasm_f32x4_mul(dy, dy)),
    wasm_f32x4_mul(dz, dz));
  return wasm_f32x4_sub(wasm_f32x4_sqrt(len_sq), r);
}

v128_t sdf_box(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t bx, v128_t by, v128_t bz) {
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

v128_t sdf_cylinder(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h) {
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

v128_t sdf_cone(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h) {
  v128_t dx = wasm_f32x4_sub(px, cx);
  v128_t dy = wasm_f32x4_sub(py, cy);
  v128_t dz = wasm_f32x4_sub(pz, cz);

  v128_t zero = wasm_f32x4_splat(0.0f);
  v128_t one = wasm_f32x4_splat(1.0f);

  v128_t q = wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dz, dz)));

  v128_t cone_len_sq = wasm_f32x4_add(wasm_f32x4_mul(r, r), wasm_f32x4_mul(h, h));
  v128_t cone_len = wasm_f32x4_sqrt(cone_len_sq);
  v128_t sin_a = wasm_f32x4_div(r, cone_len);
  v128_t cos_a = wasm_f32x4_div(h, cone_len);

  v128_t t = wasm_f32x4_max(zero, wasm_f32x4_min(one, wasm_f32x4_div(dy, h)));
  v128_t r_at_y = wasm_f32x4_mul(r, wasm_f32x4_sub(one, t));

  v128_t dist_to_surface = wasm_f32x4_sub(q, r_at_y);
  v128_t cone_dist = wasm_f32x4_mul(dist_to_surface, cos_a);

  v128_t below = wasm_f32x4_lt(dy, zero);
  v128_t base_radial = wasm_f32x4_max(wasm_f32x4_sub(q, r), zero);
  v128_t base_axial = wasm_f32x4_sub(zero, dy);
  v128_t base_dist = wasm_f32x4_sqrt(wasm_f32x4_add(
    wasm_f32x4_mul(base_radial, base_radial),
    wasm_f32x4_mul(base_axial, base_axial)));

  v128_t above = wasm_f32x4_gt(dy, h);
  v128_t dy_h = wasm_f32x4_sub(dy, h);
  v128_t tip_dist = wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_mul(q, q), wasm_f32x4_mul(dy_h, dy_h)));

  v128_t result = cone_dist;
  result = wasm_v128_bitselect(base_dist, result, below);
  result = wasm_v128_bitselect(tip_dist, result, above);

  return result;
}

v128_t sdf_cylinder_y(v128_t px, v128_t py, v128_t pz, v128_t cx, v128_t cy, v128_t cz, v128_t r, v128_t h) {
  v128_t dx = wasm_f32x4_sub(px, cx);
  v128_t dz = wasm_f32x4_sub(pz, cz);
  v128_t radial_sq = wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dz, dz));
  v128_t d_radial = wasm_f32x4_sub(wasm_f32x4_sqrt(radial_sq), r);
  v128_t d_axial = wasm_f32x4_sub(wasm_f32x4_abs(wasm_f32x4_sub(py, cy)), h);

  v128_t zero = wasm_f32x4_splat(0.0f);
  v128_t d_radial_pos = wasm_f32x4_max(d_radial, zero);
  v128_t d_axial_pos = wasm_f32x4_max(d_axial, zero);

  v128_t outside = wasm_f32x4_sqrt(wasm_f32x4_add(
    wasm_f32x4_mul(d_radial_pos, d_radial_pos),
    wasm_f32x4_mul(d_axial_pos, d_axial_pos)));
  v128_t inside = wasm_f32x4_min(wasm_f32x4_max(d_radial, d_axial), zero);

  return wasm_f32x4_add(outside, inside);
}

v128_t sdf_smooth_union(v128_t d1, v128_t d2, v128_t k) {
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


///////////
// SCENE //
///////////
v128_t eval_shape(u32 i, v128_t px, v128_t py, v128_t pz) {
  v128_t cx = shape_cx[i];
  v128_t cy = shape_cy[i];
  v128_t cz = shape_cz[i];

  if (shape_types[i] == SHAPE_SPHERE) {
    return sdf_sphere(px, py, pz, cx, cy, cz, shape_p0[i]);
  } else if (shape_types[i] == SHAPE_CYLINDER) {
    return sdf_cylinder(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i]);
  } else if (shape_types[i] == SHAPE_CONE) {
    return sdf_cone(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i]);
  } else if (shape_types[i] == SHAPE_CYLINDER_Y) {
    return sdf_cylinder_y(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i]);
  } else {
    return sdf_box(px, py, pz, cx, cy, cz, shape_p0[i], shape_p1[i], shape_p2[i]);
  }
}

v128_t scene_sdf(v128_t px, v128_t py, v128_t pz) {
  if (shape_count == 0) return max_dist_simd;

  v128_t group_dists[MAX_GROUPS];
  u8 group_initialized[MAX_GROUPS] = {0};

  for (u32 i = 0; i < shape_count; i++) {
    u8 g = shape_groups[i];
    if (g >= group_count) g = 0;

    v128_t d = eval_shape(i, px, py, pz);

    if (!group_initialized[g]) {
      group_dists[g] = d;
      group_initialized[g] = 1;
    } else {
      if (group_blend_mode[g] == 0) {
        group_dists[g] = wasm_f32x4_min(group_dists[g], d);
      } else {
        group_dists[g] = sdf_smooth_union(group_dists[g], d, smooth_k_simd);
      }
    }
  }

  v128_t result = max_dist_simd;
  u8 first = 1;
  for (u32 g = 0; g < group_count; g++) {
    if (group_initialized[g]) {
      if (first) {
        result = group_dists[g];
        first = 0;
      } else {
        result = sdf_smooth_union(result, group_dists[g], smooth_k_simd);
      }
    }
  }

  return result;
}

void get_hit_colors(v128_t px, v128_t py, v128_t pz, i32* hit_mask, f32* out_cr, f32* out_cg, f32* out_cb) {
  v128_t min_dist = wasm_f32x4_splat(MAX_DIST);
  v128_t closest_r = wasm_f32x4_splat(0.0f);
  v128_t closest_g = wasm_f32x4_splat(0.0f);
  v128_t closest_b = wasm_f32x4_splat(0.0f);
  v128_t hit_thresh = wasm_f32x4_splat(HIT_THRESHOLD);

  v128_t done = wasm_i32x4_splat(0);
  v128_t valid = wasm_i32x4_make(hit_mask[0], hit_mask[1], hit_mask[2], hit_mask[3]);

  for (u32 i = 0; i < shape_count; i++) {
    perf_metrics[PERF_COLOR_LOOKUPS] += 1.0f;

    v128_t d = eval_shape(i, px, py, pz);

    v128_t is_closer = wasm_f32x4_lt(d, min_dist);
    v128_t should_update = wasm_v128_and(is_closer, wasm_v128_andnot(valid, done));

    min_dist = wasm_v128_bitselect(d, min_dist, should_update);

    closest_r = wasm_v128_bitselect(shape_r[i], closest_r, should_update);
    closest_g = wasm_v128_bitselect(shape_g[i], closest_g, should_update);
    closest_b = wasm_v128_bitselect(shape_b[i], closest_b, should_update);

    v128_t very_close = wasm_f32x4_lt(d, hit_thresh);
    done = wasm_v128_or(done, wasm_v128_and(should_update, very_close));

    v128_t all_done = wasm_v128_or(done, wasm_v128_not(valid));
    if (wasm_i32x4_all_true(all_done)) break;
  }

  wasm_v128_store(out_cr, closest_r);
  wasm_v128_store(out_cg, closest_g);
  wasm_v128_store(out_cb, closest_b);
}

// =============================================================================
// API Implementation
// =============================================================================

f32* get_perf_metrics_ptr(void) {
  return perf_metrics;
}

void reset_perf_metrics(void) {
  for (int i = 0; i < PERF_METRICS_SIZE; i++) perf_metrics[i] = 0.0f;
}

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

u8* get_shape_types_ptr(void) { return shape_types; }
f32* get_shape_params_ptr(void) { return shape_params; }
f32* get_shape_positions_ptr(void) { return shape_positions; }
f32* get_shape_colors_ptr(void) { return shape_colors; }
u8* get_shape_groups_ptr(void) { return shape_groups; }
u8* get_group_blend_modes_ptr(void) { return group_blend_mode; }

void set_ray_count(u32 count) {
  ray_count = count < MAX_RAYS ? count : MAX_RAYS;
}

void init_simd_constants(void) {
  max_dist_simd = wasm_f32x4_splat(MAX_DIST);
  zero_simd = wasm_f32x4_splat(0.0f);
}

void set_lighting(f32 ambient, f32 dir_x, f32 dir_y, f32 dir_z, f32 intensity) {
  ambient_weight = ambient;
  light_intensity = intensity;

  f32 len = sqrtf_approx(dir_x*dir_x + dir_y*dir_y + dir_z*dir_z);
  if (len > 0.0f) {
    light_dir[0] = dir_x / len;
    light_dir[1] = dir_y / len;
    light_dir[2] = dir_z / len;
  }

  light_x_simd = wasm_f32x4_splat(light_dir[0]);
  light_y_simd = wasm_f32x4_splat(light_dir[1]);
  light_z_simd = wasm_f32x4_splat(light_dir[2]);
  ambient_simd = wasm_f32x4_splat(ambient_weight);
  diffuse_simd = wasm_f32x4_splat(intensity);
}

void set_scene(u32 count, f32 k) {
  if (!simd_constants_initialized) {
    init_simd_constants();
    simd_constants_initialized = 1;
  }

  shape_count = count < MAX_SHAPES ? count : MAX_SHAPES;
  smooth_k = k;
  smooth_k_simd = wasm_f32x4_splat(k);

  if (shape_count == 0) {
    scene_aabb_min[0] = scene_aabb_min[1] = scene_aabb_min[2] = -MAX_DIST;
    scene_aabb_max[0] = scene_aabb_max[1] = scene_aabb_max[2] = MAX_DIST;
    return;
  }

  scene_aabb_min[0] = scene_aabb_min[1] = scene_aabb_min[2] = 1e10f;
  scene_aabb_max[0] = scene_aabb_max[1] = scene_aabb_max[2] = -1e10f;

  for (u32 i = 0; i < shape_count; i++) {
    f32 cx = shape_positions[i * 3];
    f32 cy = shape_positions[i * 3 + 1];
    f32 cz = shape_positions[i * 3 + 2];

    shape_cx[i] = wasm_f32x4_splat(cx);
    shape_cy[i] = wasm_f32x4_splat(cy);
    shape_cz[i] = wasm_f32x4_splat(cz);
    shape_p0[i] = wasm_f32x4_splat(shape_params[i * 4]);
    shape_p1[i] = wasm_f32x4_splat(shape_params[i * 4 + 1]);
    shape_p2[i] = wasm_f32x4_splat(shape_params[i * 4 + 2]);
    shape_r[i] = wasm_f32x4_splat(shape_colors[i * 3]);
    shape_g[i] = wasm_f32x4_splat(shape_colors[i * 3 + 1]);
    shape_b[i] = wasm_f32x4_splat(shape_colors[i * 3 + 2]);

    f32 ex, ey, ez;
    if (shape_types[i] == SHAPE_SPHERE) {
      f32 r = shape_params[i * 4];
      ex = ey = ez = r;
    } else if (shape_types[i] == SHAPE_CYLINDER) {
      f32 r = shape_params[i * 4];
      f32 h = shape_params[i * 4 + 1];
      ex = h;
      ey = ez = r;
    } else if (shape_types[i] == SHAPE_CONE) {
      f32 r = shape_params[i * 4];
      f32 h = shape_params[i * 4 + 1];
      ex = ez = r;
      ey = h;
    } else if (shape_types[i] == SHAPE_CYLINDER_Y) {
      f32 r = shape_params[i * 4];
      f32 h = shape_params[i * 4 + 1];
      ex = ez = r;
      ey = h;
    } else {
      ex = shape_params[i * 4];
      ey = shape_params[i * 4 + 1];
      ez = shape_params[i * 4 + 2];
    }

    if (cx - ex < scene_aabb_min[0]) scene_aabb_min[0] = cx - ex;
    if (cy - ey < scene_aabb_min[1]) scene_aabb_min[1] = cy - ey;
    if (cz - ez < scene_aabb_min[2]) scene_aabb_min[2] = cz - ez;
    if (cx + ex > scene_aabb_max[0]) scene_aabb_max[0] = cx + ex;
    if (cy + ey > scene_aabb_max[1]) scene_aabb_max[1] = cy + ey;
    if (cz + ez > scene_aabb_max[2]) scene_aabb_max[2] = cz + ez;
  }

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

//////////////////
// POINT LIGHTS //
//////////////////
f32* get_point_light_x_ptr(void) { return point_light_x; }
f32* get_point_light_y_ptr(void) { return point_light_y; }
f32* get_point_light_z_ptr(void) { return point_light_z; }
f32* get_point_light_r_ptr(void) { return point_light_r; }
f32* get_point_light_g_ptr(void) { return point_light_g; }
f32* get_point_light_b_ptr(void) { return point_light_b; }
f32* get_point_light_intensity_ptr(void) { return point_light_intensity; }
f32* get_point_light_radius_ptr(void) { return point_light_radius; }
u32 get_max_point_lights(void) { return MAX_POINT_LIGHTS; }

void set_point_lights(u32 count) {
  point_light_count = count < MAX_POINT_LIGHTS ? count : MAX_POINT_LIGHTS;

  for (u32 i = 0; i < point_light_count; i++) {
    pl_x_simd[i] = wasm_f32x4_splat(point_light_x[i]);
    pl_y_simd[i] = wasm_f32x4_splat(point_light_y[i]);
    pl_z_simd[i] = wasm_f32x4_splat(point_light_z[i]);
    pl_r_simd[i] = wasm_f32x4_splat(point_light_r[i]);
    pl_g_simd[i] = wasm_f32x4_splat(point_light_g[i]);
    pl_b_simd[i] = wasm_f32x4_splat(point_light_b[i]);
    pl_intensity_simd[i] = wasm_f32x4_splat(point_light_intensity[i]);
    pl_radius_simd[i] = wasm_f32x4_splat(point_light_radius[i]);
  }
}

void set_camera(f32 ex, f32 ey, f32 ez, f32 fx, f32 fy, f32 fz, f32 rx, f32 ry, f32 rz, f32 ux, f32 uy, f32 uz, f32 halfW, f32 halfH) {
  cam_eye[0] = ex; cam_eye[1] = ey; cam_eye[2] = ez;
  cam_forward[0] = fx; cam_forward[1] = fy; cam_forward[2] = fz;
  cam_right[0] = rx; cam_right[1] = ry; cam_right[2] = rz;
  cam_up[0] = ux; cam_up[1] = uy; cam_up[2] = uz;
  cam_half_width = halfW;
  cam_half_height = halfH;
}

void generate_rays(u32 width, u32 height) {
  u32 count = width * height;
  if (count > MAX_RAYS) count = MAX_RAYS;

  f32 inv_w = 1.0f / (f32)(width - 1);
  f32 inv_h = 1.0f / (f32)(height - 1);

  for (u32 row = 0; row < height; row++) {
    f32 v = 1.0f - 2.0f * (f32)row * inv_h;

    for (u32 col = 0; col < width; col++) {
      u32 idx = row * width + col;
      if (idx >= MAX_RAYS) break;

      f32 u = 2.0f * (f32)col * inv_w - 1.0f;

      ray_ox[idx] = cam_eye[0];
      ray_oy[idx] = cam_eye[1];
      ray_oz[idx] = cam_eye[2];

      f32 dx = cam_forward[0] + u * cam_half_width * cam_right[0] + v * cam_half_height * cam_up[0];
      f32 dy = cam_forward[1] + u * cam_half_width * cam_right[1] + v * cam_half_height * cam_up[1];
      f32 dz = cam_forward[2] + u * cam_half_width * cam_right[2] + v * cam_half_height * cam_up[2];

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

void march_rays(void) {
  u32 batch_count = (ray_count + 3) / 4;

  u32 total_steps_all = 0;
  u32 total_hits = 0;
  u32 total_misses = 0;

  for (u32 batch = 0; batch < batch_count; batch++) {
    u32 base = batch * 4;

    v128_t ox = wasm_v128_load(&ray_ox[base]);
    v128_t oy = wasm_v128_load(&ray_oy[base]);
    v128_t oz = wasm_v128_load(&ray_oz[base]);
    v128_t dx = wasm_v128_load(&ray_dx[base]);
    v128_t dy = wasm_v128_load(&ray_dy[base]);
    v128_t dz = wasm_v128_load(&ray_dz[base]);

    v128_t px = ox;
    v128_t py = oy;
    v128_t pz = oz;

    v128_t total_dist = wasm_f32x4_splat(0.0f);

    v128_t active = wasm_i32x4_splat(-1);

    v128_t max_dist = wasm_f32x4_splat(MAX_DIST);
    v128_t hit_thresh = wasm_f32x4_splat(HIT_THRESHOLD);

    v128_t accumulated_hit = wasm_i32x4_splat(0);

    u32 steps_this_batch = 0;
    for (int step = 0; step < MAX_STEPS; step++) {
      v128_t dist = scene_sdf(px, py, pz);
      steps_this_batch++;

      v128_t hit = wasm_f32x4_lt(dist, hit_thresh);
      v128_t miss = wasm_f32x4_gt(total_dist, max_dist);

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

    v128_t hit = accumulated_hit;

    i32 hit_arr[4];
    wasm_v128_store(hit_arr, hit);

    i32 any_hit = hit_arr[0] | hit_arr[1] | hit_arr[2] | hit_arr[3];

    f32 bright_arr[4] = {0.0f, 0.0f, 0.0f, 0.0f};

    if (any_hit) {
      v128_t eps = wasm_f32x4_splat(NORMAL_EPS);
      v128_t neg_eps = wasm_f32x4_splat(-NORMAL_EPS);

      v128_t d0 = scene_sdf(
        wasm_f32x4_add(px, eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, neg_eps));
      v128_t d1 = scene_sdf(
        wasm_f32x4_add(px, eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, eps));
      v128_t d2 = scene_sdf(
        wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, eps));
      v128_t d3 = scene_sdf(
        wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, neg_eps));

      v128_t nx = wasm_f32x4_sub(wasm_f32x4_add(d0, d1), wasm_f32x4_add(d2, d3));
      v128_t ny = wasm_f32x4_sub(wasm_f32x4_add(d0, d2), wasm_f32x4_add(d1, d3));
      v128_t nz = wasm_f32x4_sub(wasm_f32x4_add(d1, d2), wasm_f32x4_add(d0, d3));

      perf_metrics[PERF_NORMAL_SDF_CALLS] += 4.0f;

      v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(nx, nx),
        wasm_f32x4_mul(ny, ny)),
        wasm_f32x4_mul(nz, nz));
      v128_t inv_len = wasm_f32x4_div(wasm_f32x4_splat(1.0f), wasm_f32x4_sqrt(len_sq));
      nx = wasm_f32x4_mul(nx, inv_len);
      ny = wasm_f32x4_mul(ny, inv_len);
      nz = wasm_f32x4_mul(nz, inv_len);

      v128_t ndotl = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(nx, light_x_simd),
        wasm_f32x4_mul(ny, light_y_simd)),
        wasm_f32x4_mul(nz, light_z_simd));
      ndotl = wasm_f32x4_max(ndotl, zero_simd);

      v128_t brightness = wasm_f32x4_add(
        ambient_simd,
        wasm_f32x4_mul(ndotl, diffuse_simd)
      );

      wasm_v128_store(bright_arr, brightness);
    }

    f32 cr_arr[4], cg_arr[4], cb_arr[4];
    if (any_hit) {
      get_hit_colors(px, py, pz, hit_arr, cr_arr, cg_arr, cb_arr);
    }

    f32 pl_contrib_r[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    f32 pl_contrib_g[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    f32 pl_contrib_b[4] = {0.0f, 0.0f, 0.0f, 0.0f};

    if (any_hit && point_light_count > 0) {
      v128_t eps = wasm_f32x4_splat(NORMAL_EPS);
      v128_t neg_eps = wasm_f32x4_splat(-NORMAL_EPS);
      v128_t d0 = scene_sdf(
        wasm_f32x4_add(px, eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, neg_eps));
      v128_t d1 = scene_sdf(
        wasm_f32x4_add(px, eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, eps));
      v128_t d2 = scene_sdf(
        wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, eps), wasm_f32x4_add(pz, eps));
      v128_t d3 = scene_sdf(
        wasm_f32x4_add(px, neg_eps), wasm_f32x4_add(py, neg_eps), wasm_f32x4_add(pz, neg_eps));
      v128_t nx = wasm_f32x4_sub(wasm_f32x4_add(d0, d1), wasm_f32x4_add(d2, d3));
      v128_t ny = wasm_f32x4_sub(wasm_f32x4_add(d0, d2), wasm_f32x4_add(d1, d3));
      v128_t nz = wasm_f32x4_sub(wasm_f32x4_add(d1, d2), wasm_f32x4_add(d0, d3));
      v128_t len_sq = wasm_f32x4_add(wasm_f32x4_add(
        wasm_f32x4_mul(nx, nx), wasm_f32x4_mul(ny, ny)), wasm_f32x4_mul(nz, nz));
      v128_t inv_len = wasm_f32x4_div(wasm_f32x4_splat(1.0f), wasm_f32x4_sqrt(len_sq));
      nx = wasm_f32x4_mul(nx, inv_len);
      ny = wasm_f32x4_mul(ny, inv_len);
      nz = wasm_f32x4_mul(nz, inv_len);

      v128_t one = wasm_f32x4_splat(1.0f);

      for (u32 pl = 0; pl < point_light_count; pl++) {
        v128_t lx = wasm_f32x4_sub(pl_x_simd[pl], px);
        v128_t ly = wasm_f32x4_sub(pl_y_simd[pl], py);
        v128_t lz = wasm_f32x4_sub(pl_z_simd[pl], pz);

        v128_t dist_sq = wasm_f32x4_add(wasm_f32x4_add(
          wasm_f32x4_mul(lx, lx), wasm_f32x4_mul(ly, ly)), wasm_f32x4_mul(lz, lz));
        v128_t dist = wasm_f32x4_sqrt(dist_sq);

        v128_t inv_dist = wasm_f32x4_div(one, wasm_f32x4_max(dist, wasm_f32x4_splat(0.001f)));
        lx = wasm_f32x4_mul(lx, inv_dist);
        ly = wasm_f32x4_mul(ly, inv_dist);
        lz = wasm_f32x4_mul(lz, inv_dist);

        v128_t ndotl_pl = wasm_f32x4_add(wasm_f32x4_add(
          wasm_f32x4_mul(nx, lx), wasm_f32x4_mul(ny, ly)), wasm_f32x4_mul(nz, lz));
        ndotl_pl = wasm_f32x4_max(ndotl_pl, zero_simd);

        v128_t dist_norm = wasm_f32x4_div(dist, pl_radius_simd[pl]);
        v128_t atten = wasm_f32x4_div(one,
          wasm_f32x4_add(one, wasm_f32x4_mul(dist_norm, dist_norm)));

        v128_t factor = wasm_f32x4_mul(wasm_f32x4_mul(pl_intensity_simd[pl], atten), ndotl_pl);
        v128_t contrib_r = wasm_f32x4_mul(pl_r_simd[pl], factor);
        v128_t contrib_g = wasm_f32x4_mul(pl_g_simd[pl], factor);
        v128_t contrib_b = wasm_f32x4_mul(pl_b_simd[pl], factor);

        f32 tmp_r[4], tmp_g[4], tmp_b[4];
        wasm_v128_store(tmp_r, contrib_r);
        wasm_v128_store(tmp_g, contrib_g);
        wasm_v128_store(tmp_b, contrib_b);
        for (int i = 0; i < 4; i++) {
          pl_contrib_r[i] += tmp_r[i];
          pl_contrib_g[i] += tmp_g[i];
          pl_contrib_b[i] += tmp_b[i];
        }
      }
    }

    for (int i = 0; i < 4; i++) {
      u32 idx = base + i;
      if (idx >= ray_count) break;

      if (hit_arr[i]) {
        total_hits++;
        out_r[idx] = bright_arr[i] * cr_arr[i] + pl_contrib_r[i] * cr_arr[i];
        out_g[idx] = bright_arr[i] * cg_arr[i] + pl_contrib_g[i] * cg_arr[i];
        out_b[idx] = bright_arr[i] * cb_arr[i] + pl_contrib_b[i] * cb_arr[i];
      } else {
        total_misses++;
        out_r[idx] = bg_color[0];
        out_g[idx] = bg_color[1];
        out_b[idx] = bg_color[2];
      }
    }
  }

  perf_metrics[PERF_TOTAL_STEPS] = (f32)total_steps_all;
  perf_metrics[PERF_EARLY_HITS] = (f32)total_hits;
  perf_metrics[PERF_MISSES] = (f32)total_misses;
  u32 active_batches = batch_count > 0 ? batch_count : 1;
  perf_metrics[PERF_AVG_STEPS] = (f32)total_steps_all / (f32)active_batches;
  perf_metrics[PERF_HIT_RATE] = (ray_count > 0) ? (100.0f * (f32)total_hits / (f32)ray_count) : 0.0f;
}

u32 get_max_rays(void) { return MAX_RAYS; }

u32* get_out_char_ptr(void) { return out_char; }
f32* get_out_fg_ptr(void) { return out_fg; }
f32* get_out_bg_ptr(void) { return out_bg; }

void composite(u32 width, u32 height) {
  u32 count = width * height;
  if (count > MAX_RAYS) count = MAX_RAYS;

  u32 i = 0;
  for (u32 row = 0; row < height; row++) {
    u32 row_bit = (row & 1) * 2;

    for (u32 col = 0; col < width; col++, i++) {
      if (i >= MAX_RAYS) break;

      f32 r = out_r[i];
      f32 g = out_g[i];
      f32 b = out_b[i];

      f32 brightness = (r + g + b) * RGB_AVG_DIVISOR;
      u32 dither_idx = row_bit + (col & 1);
      brightness += bayer2x2[dither_idx];

      if (brightness < 0.0f) brightness = 0.0f;
      if (brightness > 1.0f) brightness = 1.0f;

      u32 fg_base = i * 4;

      if (r > BG_THRESHOLD || g > BG_THRESHOLD || b > BG_THRESHOLD) {
        i32 char_idx = (i32)(brightness * ASCII_RAMP_MAX_IDX);
        if (char_idx < 0) char_idx = 0;
        if (char_idx > 9) char_idx = 9;

        out_char[i] = (u32)ascii_ramp[char_idx];
        out_fg[fg_base]   = r;
        out_fg[fg_base + 1] = g;
        out_fg[fg_base + 2] = b;
        out_fg[fg_base + 3] = 1.0f;
      } else {
        out_char[i] = '@';
        out_fg[fg_base]   = BG_FILL_R;
        out_fg[fg_base + 1] = BG_FILL_G;
        out_fg[fg_base + 2] = BG_FILL_B;
        out_fg[fg_base + 3] = 1.0f;
      }
    }
  }
}

void composite_blocks(u32 width, u32 height) {
  u32 out_height = height / 2;
  u32 out_count = width * out_height;
  if (out_count > MAX_RAYS) out_count = MAX_RAYS;

  for (u32 out_row = 0; out_row < out_height; out_row++) {
    u32 top_row = out_row * 2;
    u32 bot_row = top_row + 1;
    if (bot_row >= height) bot_row = top_row;

    for (u32 col = 0; col < width; col++) {
      u32 out_idx = out_row * width + col;
      if (out_idx >= MAX_RAYS) break;

      u32 top_idx = top_row * width + col;
      u32 bot_idx = bot_row * width + col;

      f32 top_r = out_r[top_idx];
      f32 top_g = out_g[top_idx];
      f32 top_b = out_b[top_idx];
      f32 bot_r = out_r[bot_idx];
      f32 bot_g = out_g[bot_idx];
      f32 bot_b = out_b[bot_idx];

      f32 top_bright = (top_r + top_g + top_b) * RGB_AVG_DIVISOR;
      f32 bot_bright = (bot_r + bot_g + bot_b) * RGB_AVG_DIVISOR;
      i32 top_on = top_bright > BG_THRESHOLD;
      i32 bot_on = bot_bright > BG_THRESHOLD;

      u32 fg_base = out_idx * 4;
      u32 bg_base = out_idx * 4;

      if (top_on && bot_on) {
        out_char[out_idx] = BLOCK_FULL;
        out_fg[fg_base]   = (top_r + bot_r) * 0.5f;
        out_fg[fg_base + 1] = (top_g + bot_g) * 0.5f;
        out_fg[fg_base + 2] = (top_b + bot_b) * 0.5f;
        out_fg[fg_base + 3] = 1.0f;
        out_bg[bg_base]   = (top_r + bot_r) * 0.5f;
        out_bg[bg_base + 1] = (top_g + bot_g) * 0.5f;
        out_bg[bg_base + 2] = (top_b + bot_b) * 0.5f;
        out_bg[bg_base + 3] = 1.0f;
      } else if (top_on && !bot_on) {
        out_char[out_idx] = BLOCK_UPPER;
        out_fg[fg_base]   = top_r;
        out_fg[fg_base + 1] = top_g;
        out_fg[fg_base + 2] = top_b;
        out_fg[fg_base + 3] = 1.0f;
        out_bg[bg_base]   = bot_r;
        out_bg[bg_base + 1] = bot_g;
        out_bg[bg_base + 2] = bot_b;
        out_bg[bg_base + 3] = 1.0f;
      } else if (!top_on && bot_on) {
        out_char[out_idx] = BLOCK_LOWER;
        out_fg[fg_base]   = bot_r;
        out_fg[fg_base + 1] = bot_g;
        out_fg[fg_base + 2] = bot_b;
        out_fg[fg_base + 3] = 1.0f;
        out_bg[bg_base]   = top_r;
        out_bg[bg_base + 1] = top_g;
        out_bg[bg_base + 2] = top_b;
        out_bg[bg_base + 3] = 1.0f;
      } else {
        out_char[out_idx] = ' ';
        out_fg[fg_base]   = bg_color[0];
        out_fg[fg_base + 1] = bg_color[1];
        out_fg[fg_base + 2] = bg_color[2];
        out_fg[fg_base + 3] = 1.0f;
        out_bg[bg_base]   = bg_color[0];
        out_bg[bg_base + 1] = bg_color[1];
        out_bg[bg_base + 2] = bg_color[2];
        out_bg[bg_base + 3] = 1.0f;
      }
    }
  }
}

u32* get_upscaled_char_ptr(void) { return upscaled_char; }
f32* get_upscaled_fg_ptr(void) { return upscaled_fg; }
u32 get_max_upscaled(void) { return MAX_RAYS; }

void upscale(u32 native_width, u32 native_height, u32 output_width, u32 output_height, u32 scale) {
  u32 out_count = output_width * output_height;
  if (out_count > MAX_RAYS) out_count = MAX_RAYS;

  u32 out_idx = 0;
  for (u32 out_row = 0; out_row < output_height; out_row++) {
    u32 native_row = out_row / scale;
    if (native_row >= native_height) native_row = native_height - 1;
    u32 native_row_offset = native_row * native_width;

    for (u32 out_col = 0; out_col < output_width; out_col++, out_idx++) {
      if (out_idx >= MAX_RAYS) break;

      u32 native_col = out_col / scale;
      if (native_col >= native_width) native_col = native_width - 1;

      u32 native_idx = native_row_offset + native_col;

      upscaled_char[out_idx] = out_char[native_idx];

      u32 out_fg_base = out_idx * 4;
      u32 native_fg_base = native_idx * 4;
      upscaled_fg[out_fg_base]   = out_fg[native_fg_base];
      upscaled_fg[out_fg_base + 1] = out_fg[native_fg_base + 1];
      upscaled_fg[out_fg_base + 2] = out_fg[native_fg_base + 2];
      upscaled_fg[out_fg_base + 3] = out_fg[native_fg_base + 3];
    }
  }
}
