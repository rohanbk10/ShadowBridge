# ShadowBridge

A projection + webcam shadow physics game. Use your body to cast shadows on a
projected wall, guide a bouncing ball into the bucket.

## How it works

1. A projector displays this page fullscreen on a wall or flat surface.
2. A webcam (mobile phone recommended) faces the projected area.
3. The four corner QR codes calibrate the perspective transform.
4. Stand between the projector and the wall — your shadow becomes a ramp.
5. Guide the ball into the glowing bucket in the bottom-right corner to win.

## Run locally

HTTPS (or `localhost`) is required for webcam access.

```bash
npx serve .
```

Then open `http://localhost:3000` (or the port shown). Live Server in VS Code
also works — enable HTTPS in its settings if testing on a phone.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Source → Deploy from a branch → main / root**.
3. Open the `https://username.github.io/ShadowBridge/` URL on the projector device.

No build step required.

## Hardware setup

| Component | Recommendation |
|-----------|---------------|
| Projector | Any; display this browser tab fullscreen (`F11`) |
| Webcam | Mobile phone via [DroidCam](https://www.dev47apps.com/) or [iVCam](https://www.e2esoft.com/ivcam/) |
| Camera placement | Mount phone so it sees all four QR corners simultaneously |
| Lighting | Dimmer ambient light → stronger shadow contrast → better detection |

## Calibration

- Point the camera at the projected wall until all four markers show ✓.
- Calibration is automatic — the game starts as soon as all four are found.
- Use **Recalibrate** if the camera moves.

## Tuning

Edit the constants block at the top of `sketch.js`:

| Constant | Effect |
|----------|--------|
| `SHADOW_THRESHOLD` | Shadow sensitivity (lower = need darker shadow) |
| `GRAVITY` | Ball fall speed |
| `BALL_RESTITUTION` | Ball bounciness |
| `BUCKET_WIDTH / HEIGHT` | Bucket size |
| `SHADOW_CELL_SIZE` | Shadow detection resolution (smaller = finer, slower) |

## Debug

Press **`C`** to toggle the webcam overlay on the canvas (off by default).

Press **`D`** to toggle the shadow collider overlay (red rectangles).
