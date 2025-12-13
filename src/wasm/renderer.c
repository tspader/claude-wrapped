// WASM Raymarcher - Hello World
// Compile: clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry -Wl,--export-all -o renderer.wasm renderer.c

typedef unsigned int uint32_t;
typedef float f32;

// Output buffer for background color (3 floats: r, g, b)
static f32 bg_color[3];

// Simple sin approximation (no libm)
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

// Get pointer to background color buffer
f32* get_bg_ptr(void) {
    return bg_color;
}

// Compute background color from time
// Returns dark colors with visible variation for testing
void compute_background(f32 time) {
    f32 base_r = 0.05f;
    f32 base_g = 0.05f;
    f32 base_b = 0.08f;
    
    // More visible oscillation for testing (0.03-0.05 amplitude)
    f32 osc1 = sinf_approx(time * 0.5f) * 0.04f;
    f32 osc2 = sinf_approx(time * 0.3f + 1.0f) * 0.04f;
    f32 osc3 = sinf_approx(time * 0.7f + 2.0f) * 0.05f;
    
    bg_color[0] = base_r + osc1;
    bg_color[1] = base_g + osc2;
    bg_color[2] = base_b + osc3;
    
    if (bg_color[0] < 0.0f) bg_color[0] = 0.0f;
    if (bg_color[1] < 0.0f) bg_color[1] = 0.0f;
    if (bg_color[2] < 0.0f) bg_color[2] = 0.0f;
    if (bg_color[0] > 1.0f) bg_color[0] = 1.0f;
    if (bg_color[1] > 1.0f) bg_color[1] = 1.0f;
    if (bg_color[2] > 1.0f) bg_color[2] = 1.0f;
}
