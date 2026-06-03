# ShadowBridge

A projection + webcam body-physics game. Your webcam feed is analysed in real time to detect your body pose, which is rendered as a black silhouette on the projected wall. A ball bounces off the walls, the bucket, and your body. Guide it into the glowing bucket in the bottom-right corner to win.

## How it works

1. A projector displays this page fullscreen on a wall or flat surface.
2. A webcam (mobile phone recommended) captures the player in front of the wall.
3. **MediaPipe Pose** detects 33 body landmarks (head, shoulders, arms, hips, legs) from the webcam feed.
4. Those landmarks are rendered as a unified black silhouette on the canvas — head circle, torso quad, and rounded limb segments.
5. The same landmarks are used to build a matching set of **Matter.js static physics bodies** each frame, so the ball actually collides with your body shape.
6. The game starts automatically as soon as the first pose is detected — no manual calibration required.
7. Guide the ball into the glowing gold bucket (bottom-right) to win. Press **Play Again** to restart.

### Game states

| State | Description |
|-------|-------------|
| `LOADING` | Pose model is initialising — a status banner is shown at the top. |
| `PLAYING` | First pose detected; ball spawned, physics and win-checking active. |
| `WIN` | Ball is inside the bucket; ball is frozen and the win overlay appears. |

## Run locally

HTTPS (or `localhost`) is required for webcam access.

```bash
npx serve .
```

Then open `http://localhost:3000` (or the port shown). **Live Server** in VS Code also works — enable HTTPS in its settings if testing from a phone on the same network.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Source → Deploy from a branch → `main` / root**.
3. Open the `https://username.github.io/ShadowBridge/` URL on the projector device.

No build step required — everything loads from CDN.

## Hardware setup

| Component | Recommendation |
|-----------|---------------|
| Projector | Any; display this browser tab fullscreen (`F11`) |
| Webcam | Mobile phone via [DroidCam](https://www.dev47apps.com/) or [iVCam](https://www.e2esoft.com/ivcam/) |
| Camera placement | Position the phone so it has a clear view of the player in front of the projected wall |
| Lighting | Dimmer ambient light makes the black silhouette on the projection more dramatic |

## Tuning

Edit the constants block at the top of `sketch.js`:

| Constant | Default | Effect |
|----------|---------|--------|
| `GRAVITY` | `1.0` | Ball fall speed |
| `BALL_RESTITUTION` | `0.6` | Ball bounciness (0 = no bounce, 1 = full bounce) |
| `BALL_RADIUS` | `18` | Ball size in canvas pixels |
| `WALL_FRICTION` | `0.3` | Friction on walls and shadow bodies |
| `WALL_RESTITUTION` | `0.4` | Bounciness of walls and shadow bodies |
| `BUCKET_WIDTH` | `160` | Bucket width in canvas pixels |
| `BUCKET_HEIGHT` | `120` | Bucket height in canvas pixels |
| `EDGE_MARGIN` | `30` | Gap between bucket / walls and the canvas edge |
| `RESPAWN_COOLDOWN` | `45` | Frames to wait before respawning an out-of-bounds ball |
| `LIMB_THICKNESS` | `40` | Thickness of arm and leg silhouette segments |
| `HEAD_RADIUS` | `36` | Radius of the head circle in the silhouette |
| `MIN_VISIBILITY` | `0.5` | MediaPipe confidence threshold — landmarks below this are skipped |

## Controls

| Input | Action |
|-------|--------|
| `C` / `c` | Toggle semi-transparent mirrored webcam overlay on the canvas |
| **Play Again** button | Resets to `PLAYING` and respawns the ball |

## Architecture

The project is three files with no build tooling — all dependencies load from CDN.

```
index.html   HTML shell, fullscreen CSS, UI overlay elements, CDN script tags
sketch.js    All game logic — pose, physics, rendering, state machine
```

**Dependencies (CDN):**

| Library | Version | Role |
|---------|---------|------|
| [p5.js](https://p5js.org/) | 1.9.4 | Canvas / game loop / webcam capture |
| [Matter.js](https://brm.io/matter-js/) | 0.19.0 | 2D rigid-body physics |
| [@mediapipe/pose](https://developers.google.com/mediapipe/solutions/vision/pose_landmarker) | 0.5.1675469404 | Real-time body pose landmark detection |

**Per-frame flow (`draw()`):**

1. One webcam frame is sent to MediaPipe Pose (one frame in-flight at a time — the next is only sent after the previous result arrives).
2. The physics engine steps forward at a fixed 60 Hz tick (skipped in `WIN` state).
3. In `PLAYING`: pose colliders are rebuilt from the latest landmarks, win and respawn checks run.
4. Render order: white background → optional camera overlay → black silhouette → bucket glow → ball → HUD.

**Shadow silhouette vs physics colliders:**

The visual silhouette (drawn to an offscreen `shadowBuffer`) uses a filled torso quad + rounded limb rectangles so overlapping body parts merge into one seamless black shape. The physics colliders use a denser set of segment rectangles (including shoulder bar and hip bar across the torso top and bottom) to give the ball a solid surface to land on. Both are rebuilt every frame from the same MediaPipe landmarks.
