// ── SECTION 1: Constants ──────────────────────────────────────────
const GRAVITY            = 1.0;

// Camera capture resolution — higher res makes QR codes larger in the frame
// so jsQR can decode them reliably even when the camera is far from the wall.
const CAL_WIDTH          = 640;
const CAL_HEIGHT         = 480;

// Shadow detection processes cells at a coarser logical grid.
// PROCESS_STRIDE is how many CAL pixels equal one logical shadow pixel.
// Keeping this as a power-of-two integer makes the stride arithmetic exact.
const PROCESS_WIDTH      = 320;
const PROCESS_HEIGHT     = 240;
const PROCESS_STRIDE     = CAL_WIDTH / PROCESS_WIDTH;   // = 2

const SHADOW_THRESHOLD   = 50;
const SHADOW_CELL_SIZE   = 8;
const SHADOW_MIN_SEGMENT = 3;
const WALL_THICKNESS     = 20;
const WALL_FRICTION      = 0.3;
const WALL_RESTITUTION   = 0.4;
const BUCKET_WIDTH       = 160;
const BUCKET_HEIGHT      = 120;
const QR_SIZE            = 80;
const QR_PADDING         = 20;
const QR_SAFE_MARGIN     = QR_PADDING + QR_SIZE + 16;
const BALL_RADIUS        = 18;
const BALL_RESTITUTION   = 0.6;
const RESPAWN_COOLDOWN   = 45;

// ── SECTION 2: Globals ───────────────────────────────────────────
let GAME_STATE = 'CALIBRATING';   // 'CALIBRATING' | 'PLAYING' | 'WIN'
let debugMode  = false;
let cameraViewMode = false;

// Vision
let homographyTransform = null;
let detectedMarkers     = {};     // { 'SHADOW_TL': {camX,camY}, ... }
let video               = null;
let referencePixels     = null;   // Uint8Array snapshot of the projected wall with no shadow present;
                                  // captured at the CALIBRATING→PLAYING transition for background subtraction

// Matter
let engine;
let ball;
let boundaryBodies = [];
let bucketBodies   = [];
let shadowBodies   = [];

// Adaptive shadow rebuild rate
let shadowRebuildRate = 6;
let lastRespawnFrame  = 0;

// ── SECTION 3: p5 setup() ────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);

  // Request calibration resolution explicitly so jsQR sees large, crisp QR
  // codes. Shadow detection samples this same frame at a 2× stride, so no
  // separate low-res stream or mid-game resize is needed.
  video = createCapture(
    { video: { width: { ideal: CAL_WIDTH }, height: { ideal: CAL_HEIGHT } } },
    () => {
      video.size(CAL_WIDTH, CAL_HEIGHT);
      video.hide();
    }
  );

  // Matter engine — no Render, no Runner
  engine = Matter.Engine.create();
  engine.world.gravity.y = GRAVITY;

  GAME_STATE = 'CALIBRATING';
  detectedMarkers = {};
  homographyTransform = null;

  rebuildStaticBodies();

  // DOM wiring
  document.getElementById('btn-recalibrate')
    .addEventListener('click', startRecalibration);
  document.getElementById('btn-play-again')
    .addEventListener('click', resetToPlaying);

  updateUIForState();
  noStroke();
}

// ── SECTION 4: Layout + Matter bodies ────────────────────────────
function getBucketOrigin() {
  return {
    bx: width - QR_SAFE_MARGIN - BUCKET_WIDTH,
    by: height - QR_SAFE_MARGIN,
  };
}

function getBucketWinBounds() {
  const { bx, by } = getBucketOrigin();
  return {
    bucketLeft:   bx + WALL_THICKNESS,
    bucketRight:  bx + BUCKET_WIDTH - WALL_THICKNESS,
    bucketTop:    by - BUCKET_HEIGHT,
    bucketBottom: by - WALL_THICKNESS,
  };
}

function getBallSpawnPoint() {
  return {
    x: QR_SAFE_MARGIN + BALL_RADIUS + 12,
    y: QR_SAFE_MARGIN + 36,
  };
}

function rebuildStaticBodies() {
  boundaryBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  bucketBodies.forEach(b   => Matter.Composite.remove(engine.world, b));
  boundaryBodies = [];
  bucketBodies   = [];

  const opts = { isStatic: true, friction: WALL_FRICTION, restitution: WALL_RESTITUTION };

  // Side walls + ceiling inset so they do not run through corner QR zones
  const wallTop    = QR_SAFE_MARGIN;
  const wallHeight = max(height - QR_SAFE_MARGIN * 2, 100);
  const wallCenterY = wallTop + wallHeight / 2;

  const leftWall  = Matter.Bodies.rectangle(
    WALL_THICKNESS / 2, wallCenterY, WALL_THICKNESS, wallHeight, opts);
  const rightWall = Matter.Bodies.rectangle(
    width - WALL_THICKNESS / 2, wallCenterY, WALL_THICKNESS, wallHeight, opts);
  const ceilingWidth = max(width - QR_SAFE_MARGIN * 2, 100);
  const ceiling = Matter.Bodies.rectangle(
    width / 2, QR_SAFE_MARGIN - WALL_THICKNESS / 2,
    ceilingWidth, WALL_THICKNESS, opts);
  boundaryBodies.push(leftWall, rightWall, ceiling);

  // Bucket — bottom-right, clear of BR QR corner
  const { bx, by } = getBucketOrigin();

  const bucketBottom = Matter.Bodies.rectangle(
    bx + BUCKET_WIDTH / 2,
    by - WALL_THICKNESS / 2,
    BUCKET_WIDTH, WALL_THICKNESS, opts);
  const bucketLeft = Matter.Bodies.rectangle(
    bx + WALL_THICKNESS / 2,
    by - BUCKET_HEIGHT / 2,
    WALL_THICKNESS, BUCKET_HEIGHT, opts);
  const bucketRight = Matter.Bodies.rectangle(
    bx + BUCKET_WIDTH - WALL_THICKNESS / 2,
    by - BUCKET_HEIGHT / 2,
    WALL_THICKNESS, BUCKET_HEIGHT, opts);

  bucketBodies.push(bucketBottom, bucketLeft, bucketRight);

  Matter.Composite.add(engine.world, [...boundaryBodies, ...bucketBodies]);
}

// ── SECTION 5: Ball lifecycle ────────────────────────────────────
function spawnBall() {
  if (ball) Matter.Composite.remove(engine.world, ball);
  const { x, y } = getBallSpawnPoint();
  ball = Matter.Bodies.circle(x, y, BALL_RADIUS, {
    restitution: BALL_RESTITUTION,
    friction: 0.01,
    label: 'ball'
  });
  Matter.Body.setStatic(ball, false);
  Matter.Body.setVelocity(ball, { x: 4, y: 1 });
  Matter.Composite.add(engine.world, ball);
  lastRespawnFrame = frameCount;
}

function checkRespawn() {
  if (!ball) return;
  const outOfBounds = ball.position.y > height + 100 || ball.position.y < -100;
  if (!outOfBounds) return;
  if (frameCount - lastRespawnFrame < RESPAWN_COOLDOWN) return;
  spawnBall();
}

function checkWin() {
  if (!ball || ball.isStatic) return;
  const { bucketLeft, bucketRight, bucketTop, bucketBottom } = getBucketWinBounds();

  if (ball.position.x > bucketLeft  && ball.position.x < bucketRight &&
      ball.position.y > bucketTop   && ball.position.y < bucketBottom) {
    GAME_STATE = 'WIN';
    Matter.Body.setStatic(ball, true);
    updateUIForState();
    console.log('Level Won');
  }
}

// ── SECTION 6: State machine helpers ─────────────────────────────
function updateUIForState() {
  const statusEl  = document.getElementById('calibration-status');
  const recalBtn  = document.getElementById('btn-recalibrate');
  const winEl     = document.getElementById('win-overlay');
  const qrOverlay = document.getElementById('qr-overlay');

  statusEl.style.display = GAME_STATE === 'CALIBRATING' ? 'block' : 'none';
  recalBtn.hidden         = GAME_STATE !== 'PLAYING';
  winEl.hidden            = GAME_STATE !== 'WIN';
  qrOverlay.classList.toggle('dimmed', GAME_STATE !== 'CALIBRATING');
}

function startRecalibration() {
  detectedMarkers     = {};
  homographyTransform = null;
  referencePixels     = null;   // stale snapshot — will be re-captured at next transition
  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];
  if (ball) {
    Matter.Composite.remove(engine.world, ball);
    ball = null;
  }
  GAME_STATE = 'CALIBRATING';
  updateUIForState();
}

function resetToPlaying() {
  GAME_STATE = 'PLAYING';
  if (ball) {
    Matter.Composite.remove(engine.world, ball);
    ball = null;
  }
  spawnBall();
  updateUIForState();
}

// ── SECTION 7: Camera / vision helpers ───────────────────────────

function buildDstPts() {
  const half = QR_SIZE / 2;
  const p    = QR_PADDING;
  const W    = windowWidth;
  const H    = windowHeight;
  return [
    p + half,     p + half,       // TL
    W - p - half, p + half,       // TR
    W - p - half, H - p - half,   // BR
    p + half,     H - p - half,   // BL
  ];
}

function buildSrcPts(m) {
  return [
    m['SHADOW_TL'].camX, m['SHADOW_TL'].camY,
    m['SHADOW_TR'].camX, m['SHADOW_TR'].camY,
    m['SHADOW_BR'].camX, m['SHADOW_BR'].camY,
    m['SHADOW_BL'].camX, m['SHADOW_BL'].camY,
  ];
}

function camToCanvas(camX, camY) {
  if (!homographyTransform) return [camX, camY];
  return homographyTransform.transform(camX, camY); // returns [x, y]
}

function scanQuadrant(px, rx, ry, rw, rh) {
  const data = new Uint8ClampedArray(rw * rh * 4);
  for (let row = 0; row < rh; row++) {
    for (let col = 0; col < rw; col++) {
      // Stride must match the full CAL frame width, not the shadow-processing width.
      const si = ((ry + row) * CAL_WIDTH + (rx + col)) * 4;
      const di = (row * rw + col) * 4;
      data[di]     = px[si];
      data[di + 1] = px[si + 1];
      data[di + 2] = px[si + 2];
      data[di + 3] = px[si + 3];
    }
  }
  const result = jsQR(data, rw, rh);
  if (!result) return null;

  // Map sub-region corner back to full-frame coordinates
  const loc = result.location;
  const camX = rx + (loc.topLeftCorner.x + loc.topRightCorner.x +
                     loc.bottomRightCorner.x + loc.bottomLeftCorner.x) / 4;
  const camY = ry + (loc.topLeftCorner.y + loc.topRightCorner.y +
                     loc.bottomRightCorner.y + loc.bottomLeftCorner.y) / 4;
  return { text: result.data, camX, camY };
}

function updateShadowColliders() {
  if (!homographyTransform) return;

  video.loadPixels();
  if (!video.pixels || video.pixels.length === 0) return;

  const px   = video.pixels;
  const ref  = referencePixels; // may be null before first calibration
  const cols = Math.floor(PROCESS_WIDTH  / SHADOW_CELL_SIZE);
  const rows = Math.floor(PROCESS_HEIGHT / SHADOW_CELL_SIZE);

  // Build shadow grid: true = cell is meaningfully darker than the reference frame.
  // Background subtraction lets us ignore projected game graphics (ball, bucket lines)
  // that would otherwise look like shadow under a pure brightness threshold.
  //
  // Pixels are sampled from the full 640×480 CAL frame using PROCESS_STRIDE,
  // giving the same logical cell density as a 320×240 frame but from a
  // higher-quality capture — no second video stream or mid-game resize needed.
  const grid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let darkCount = 0;
      const totalPixels = SHADOW_CELL_SIZE * SHADOW_CELL_SIZE;
      for (let dy = 0; dy < SHADOW_CELL_SIZE; dy++) {
        for (let dx = 0; dx < SHADOW_CELL_SIZE; dx++) {
          // Multiply by PROCESS_STRIDE to convert logical coords → CAL pixels
          const cx = (col * SHADOW_CELL_SIZE + dx) * PROCESS_STRIDE;
          const cy = (row * SHADOW_CELL_SIZE + dy) * PROCESS_STRIDE;
          const i  = (cy * CAL_WIDTH + cx) * 4;
          const brightness    = (px[i] + px[i + 1] + px[i + 2]) / 3;
          const refBrightness = ref
            ? (ref[i] + ref[i + 1] + ref[i + 2]) / 3
            : 255; // treat full white as reference when no snapshot exists
          if (brightness < refBrightness - SHADOW_THRESHOLD) darkCount++;
        }
      }
      if (darkCount > totalPixels * 0.5) grid[row * cols + col] = 1;
    }
  }

  // RLE: collect candidate segments per row
  const candidates = [];
  for (let row = 0; row < rows; row++) {
    let runStart = -1;
    for (let col = 0; col <= cols; col++) {
      const isShadow = col < cols && grid[row * cols + col] === 1;
      if (isShadow && runStart === -1) {
        runStart = col;
      } else if (!isShadow && runStart !== -1) {
        const runLen = col - runStart;
        if (runLen >= SHADOW_MIN_SEGMENT) {
          candidates.push({ row, runStart, runLen });
        }
        runStart = -1;
      }
    }
  }

  // Sort by length descending, cap at 200
  candidates.sort((a, b) => b.runLen - a.runLen);
  const toAdd = candidates.slice(0, 200);

  // Remove old shadow bodies
  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];

  toAdd.forEach(({ row, runStart, runLen }) => {
    // All cam-space coordinates are in CAL pixels (multiply logical cell coords
    // by PROCESS_STRIDE) so they align with the homography, which was built
    // from QR-code positions detected in the 640×480 frame.
    const camCX = (runStart + runLen / 2) * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const camCY = (row + 0.5)             * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const [cx, cy] = camToCanvas(camCX, camCY);

    // Discard segments that project outside the walled play area. Without this,
    // shadow bodies can appear behind the side walls or above the ceiling wall,
    // creating invisible obstacles outside the playfield.
    if (cx < WALL_THICKNESS || cx > width - WALL_THICKNESS) return;
    if (cy < QR_SAFE_MARGIN || cy > height) return;

    // Derive actual canvas-space width by transforming both horizontal edges
    // of the segment through the homography rather than using a linear scale.
    const camLeft  = runStart             * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const camRight = (runStart + runLen)  * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const [lx]     = camToCanvas(camLeft,  camCY);
    const [rx]     = camToCanvas(camRight, camCY);
    const bodyW    = Math.abs(rx - lx);

    // Derive height by transforming the top and bottom edges of the cell row.
    const camTop    = row       * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const camBottom = (row + 1) * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const [, ty]    = camToCanvas(camCX, camTop);
    const [, by2]   = camToCanvas(camCX, camBottom);
    const bodyH     = Math.abs(by2 - ty);

    const b = Matter.Bodies.rectangle(cx, cy, Math.max(bodyW, 2), Math.max(bodyH, 2), {
      isStatic:    true,
      label:       'shadow',
      friction:    WALL_FRICTION,
      restitution: WALL_RESTITUTION,
    });
    shadowBodies.push(b);
  });

  Matter.Composite.add(engine.world, shadowBodies);
}

// ── SECTION 8: p5 draw() ─────────────────────────────────────────
function draw() {
  // ── 1. Physics update ──────────────────────────────────────────
  if (GAME_STATE !== 'WIN') {
    Matter.Engine.update(engine, 1000 / 60);
  }

  // ── 2. QR scan (CALIBRATING only) ─────────────────────────────
  if (GAME_STATE === 'CALIBRATING') {
    video.loadPixels();
    if (video.pixels && video.pixels.length > 0) {
      // Overlap margin scaled to CAL resolution so each half-frame has the
      // same proportional overlap as before (≈12.5 % of each half-width).
      const OV = 20 * PROCESS_STRIDE;
      const HW = CAL_WIDTH  / 2 + OV;
      const HH = CAL_HEIGHT / 2 + OV;

      const quadrants = [
        { rx: 0,                ry: 0,               rw: HW, rh: HH },  // TL
        { rx: CAL_WIDTH/2-OV,  ry: 0,               rw: HW, rh: HH },  // TR
        { rx: 0,               ry: CAL_HEIGHT/2-OV, rw: HW, rh: HH },  // BL
        { rx: CAL_WIDTH/2-OV,  ry: CAL_HEIGHT/2-OV, rw: HW, rh: HH }, // BR
      ];

      quadrants.forEach(q => {
        const hit = scanQuadrant(video.pixels, q.rx, q.ry, q.rw, q.rh);
        if (hit && ['SHADOW_TL','SHADOW_TR','SHADOW_BL','SHADOW_BR'].includes(hit.text)) {
          detectedMarkers[hit.text] = { camX: hit.camX, camY: hit.camY };
        }
      });

      // Transition when all four found
      if (Object.keys(detectedMarkers).length === 4) {
        // Snapshot the current camera frame as the background reference.
        // At this moment no user shadow is present (user was holding the camera
        // to frame the QR codes), so this cleanly represents the projected wall
        // without any occlusion.
        referencePixels = new Uint8Array(video.pixels);

        homographyTransform = PerspT(buildSrcPts(detectedMarkers), buildDstPts());
        GAME_STATE = 'PLAYING';
        spawnBall();
        updateUIForState();
      }
    }
  }

  // ── 3. Game logic (PLAYING only) ──────────────────────────────
  if (GAME_STATE === 'PLAYING') {
    if (frameCount % shadowRebuildRate === 0) updateShadowColliders();
    checkWin();
    checkRespawn();
  }

  // ── 4. Render ─────────────────────────────────────────────────
  background(255);

  // Optional webcam overlay (toggle with C — unmirrored mobile camera feed)
  if (cameraViewMode && video) {
    push();
    tint(255, 80);
    image(video, 0, 0, width, height);
    pop();
  }

  // Calibration feedback (CALIBRATING only)
  if (GAME_STATE === 'CALIBRATING') {
    const found = ['SHADOW_TL','SHADOW_TR','SHADOW_BL','SHADOW_BR']
      .map(k => `${k.replace('SHADOW_','')} ${detectedMarkers[k] ? '✓' : '✗'}`)
      .join('  ');
    document.getElementById('calibration-status').textContent = `Found: ${found}`;

    push();
    noStroke();
    fill(0, 160, 60, 220);
    Object.values(detectedMarkers).forEach(({ camX, camY }) => {
      const [sx, sy] = camToCanvas(camX, camY);
      circle(sx, sy, 16);
    });
    pop();
  }

  // Debug: shadow collider rects
  if (debugMode && shadowBodies.length > 0) {
    push();
    fill(255, 0, 0, 80);
    stroke(255, 0, 0);
    strokeWeight(1);
    shadowBodies.forEach(b => {
      const { x, y } = b.position;
      const w = b.bounds.max.x - b.bounds.min.x;
      const h = b.bounds.max.y - b.bounds.min.y;
      rectMode(CENTER);
      rect(x, y, w, h);
    });
    pop();
  }

  // Bucket glow (bottom-right, clear of QR corners)
  const { bx, by } = getBucketOrigin();
  push();
  noStroke();
  fill(255, 200, 0, 40);
  rect(bx, by - BUCKET_HEIGHT, BUCKET_WIDTH, BUCKET_HEIGHT);

  // Bucket walls (visual only — physics bodies drawn separately)
  stroke(200, 140, 0, 200);
  strokeWeight(2);
  noFill();
  line(bx + WALL_THICKNESS, by - BUCKET_HEIGHT,
       bx + WALL_THICKNESS, by);
  line(bx + BUCKET_WIDTH - WALL_THICKNESS, by - BUCKET_HEIGHT,
       bx + BUCKET_WIDTH - WALL_THICKNESS, by);
  line(bx, by, bx + BUCKET_WIDTH, by);
  pop();

  // Ball
  if (ball) {
    push();
    const ballX = ball.position.x;
    const ballY = ball.position.y;

    // Glow
    drawingContext.shadowColor = 'rgba(0,0,0,0.25)';
    drawingContext.shadowBlur  = 16;
    fill(30, 30, 40);
    noStroke();
    circle(ballX, ballY, BALL_RADIUS * 2);

    // Velocity direction dot
    drawingContext.shadowBlur = 0;
    fill(0, 120, 220);
    const vel = ball.velocity;
    const speed = sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed > 0.5) {
      circle(ballX + vel.x * 2, ballY + vel.y * 2, 5);
    }
    pop();
  }

  // HUD
  push();
  fill(40, 40, 40, 200);
  noStroke();
  textSize(12);
  textFont('monospace');
  text(`FPS: ${nf(frameRate(), 2, 1)}  shadowRate: ${shadowRebuildRate}  [C] camera  [D] debug`, 10, height - 10);
  pop();

  // ── 5. Adaptive shadow rebuild rate ───────────────────────────
  if (frameRate() < 30) shadowRebuildRate = min(shadowRebuildRate + 1, 15);
  if (frameRate() > 55) shadowRebuildRate = max(shadowRebuildRate - 1, 3);
}

// ── SECTION 9: p5 windowResized / keyPressed ─────────────────────
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  rebuildStaticBodies();
  // If already calibrated, recompute homography for new window size
  if (homographyTransform && Object.keys(detectedMarkers).length === 4) {
    const srcPts = buildSrcPts(detectedMarkers);
    const dstPts = buildDstPts();
    homographyTransform = PerspT(srcPts, dstPts);
  }
  if (ball && GAME_STATE === 'PLAYING') spawnBall();
}

function keyPressed() {
  if (key === 'D' || key === 'd') debugMode = !debugMode;
  if (key === 'C' || key === 'c') cameraViewMode = !cameraViewMode;
}
