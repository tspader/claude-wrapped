- Never run the CLI in animated mode. It destroys your context window. Instead, render a single frame like this:
```bash
bun src/main.ts --time 0
```
-

# summary
Terminal raymarcher with OpenTUI integration. Renders 3D SDF scenes as ASCII art with UI overlays.

# references
## opentui
- `createCliRenderer()` - creates renderer context
- `FrameBufferRenderable` - low-level canvas for custom rendering
- `frameBuffer.setCell(x, y, char, fgRGBA, bgRGBA, attrs)` - write cells
- `BoxRenderable` - container with borders
- `TextRenderable` - text display
- `renderer.root.add()` - add renderables to scene
## ours
- `src/main.ts` - main entry, renderer setup, UI
- `src/renderer/` - raymarching (Camera, RayMarcher, SDF)
- `src/scene.ts` - scene config
- `doc/opentui/packages/core/` - OpenTUI source reference

# architecture
makeScene(t) → SDF scene
    ↓
Camera.generateRays() → ray origins/directions
    ↓
RayMarcher.march() → hit positions
    ↓
renderToBuffer() → writes to OpenTUI FrameBuffer via setCell()
    ↓
BoxRenderable/TextRenderable → UI overlays on top

- `src/main.ts` uses:
  - OpenTUI's createCliRenderer(), FrameBufferRenderable for the raymarched scene
  - BoxRenderable/TextRenderable for UI
- The raymarcher outputs ASCII art with colored characters.
- Canvas size detected from terminal

# commands
- bun src/main.ts --time 0      # single frame
- bun src/main.ts -a            # animate (DON'T run in AI context)
