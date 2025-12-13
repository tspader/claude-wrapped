// SIMD test for WASM
// Compile: clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export-all -o simd_test.wasm simd_test.c

#include <wasm_simd128.h>

typedef float f32;
typedef unsigned int u32;

// Output buffer
static f32 result[4];

// Get pointer to result buffer
f32* get_result_ptr(void) {
    return result;
}

// Test SIMD: add 4 floats at once
void simd_add_test(f32 a0, f32 a1, f32 a2, f32 a3, f32 b0, f32 b1, f32 b2, f32 b3) {
    // Load into SIMD registers
    v128_t va = wasm_f32x4_make(a0, a1, a2, a3);
    v128_t vb = wasm_f32x4_make(b0, b1, b2, b3);
    
    // SIMD add
    v128_t vc = wasm_f32x4_add(va, vb);
    
    // Store result
    wasm_v128_store(result, vc);
}

// Test SIMD: compute 4 sphere SDFs at once
// Returns distances to a sphere at origin with radius 1
void simd_sdf_sphere_test(f32 px0, f32 py0, f32 pz0,
                          f32 px1, f32 py1, f32 pz1,
                          f32 px2, f32 py2, f32 pz2,
                          f32 px3, f32 py3, f32 pz3) {
    // Load x, y, z components
    v128_t x = wasm_f32x4_make(px0, px1, px2, px3);
    v128_t y = wasm_f32x4_make(py0, py1, py2, py3);
    v128_t z = wasm_f32x4_make(pz0, pz1, pz2, pz3);
    
    // length = sqrt(x*x + y*y + z*z)
    v128_t x2 = wasm_f32x4_mul(x, x);
    v128_t y2 = wasm_f32x4_mul(y, y);
    v128_t z2 = wasm_f32x4_mul(z, z);
    v128_t sum = wasm_f32x4_add(wasm_f32x4_add(x2, y2), z2);
    v128_t len = wasm_f32x4_sqrt(sum);
    
    // distance = length - radius (radius = 1.0)
    v128_t radius = wasm_f32x4_splat(1.0f);
    v128_t dist = wasm_f32x4_sub(len, radius);
    
    // Store result
    wasm_v128_store(result, dist);
}
