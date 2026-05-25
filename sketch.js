// ── SECTION 1: Constants ──────────────────────────────────────────
const GRAVITY            = 1.0;
const PROCESS_WIDTH      = 320;
const PROCESS_HEIGHT     = 240;
const SHADOW_THRESHOLD   = 50;
const SHADOW_CELL_SIZE   = 8;
const SHADOW_MIN_SEGMENT = 3;
const WALL_THICKNESS     = 20;
const WALL_FRICTION      = 0.3;
const WALL_RESTITUTION   = 0.4;
const BUCKET_WIDTH       = 160;
const BUCKET_HEIGHT      = 120;
const BUCKET_PADDING     = 20;
const QR_SIZE            = 80;
const QR_PADDING         = 20;
const BALL_RADIUS        = 18;
const BALL_RESTITUTION   = 0.6;

// ── SECTION 2: Globals ───────────────────────────────────────────
let GAME_STATE = 'CALIBRATING';   // 'CALIBRATING' | 'PLAYING' | 'WIN'
let debugMode  = false;

// Vision (populated by Part 2; stubs live in Section 7)
let homographyTransform = null;
let detectedMarkers     = {};     // { 'SHADOW_TL': {camX,camY}, ... }
let video               = null;
let shadowMask          = null;   // Uint8Array, allocated in Part 2

// Matter
let engine;
let ball;
let boundaryBodies = [];
let bucketBodies   = [];
let shadowBodies   = [];          // managed by Part 2

// Adaptive shadow rebuild rate (Part 2 reads/writes this)
let shadowRebuildRate = 6;

// ── SECTION 3: p5 setup() ────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);

  // Video capture — constrained to processing resolution, hidden from DOM
  video = createCapture(VIDEO, () => {
    video.size(PROCESS_WIDTH, PROCESS_HEIGHT);
    video.hide();
  });

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

// ── SECTION 4: Matter bodies ─────────────────────────────────────
function rebuildStaticBodies() {
  boundaryBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  bucketBodies.forEach(b   => Matter.Composite.remove(engine.world, b));
  boundaryBodies = [];
  bucketBodies   = [];

  const opts = { isStatic: true, friction: WALL_FRICTION, restitution: WALL_RESTITUTION };

  // Left wall
  const leftWall  = Matter.Bodies.rectangle(
    WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height, opts);
  // Right wall
  const rightWall = Matter.Bodies.rectangle(
    width - WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height, opts);
  boundaryBodies.push(leftWall, rightWall);

  // Bucket — bottom-left, U-shape (3 bodies)
  const bx = BUCKET_PADDING;                    // bucket left edge (outer)
  const by = height - BUCKET_PADDING;           // bucket bottom edge (outer)

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
  ball = Matter.Bodies.circle(width * 0.85, 80, BALL_RADIUS, {
    restitution: BALL_RESTITUTION,
    friction: 0.01,
    label: 'ball'
  });
  Matter.Body.setVelocity(ball, { x: -3, y: 2 });
  Matter.Composite.add(engine.world, ball);
}

function checkRespawn() {
  if (ball && ball.position.y > height + 100) spawnBall();
}

function checkWin() {
  if (!ball) return;
  const bucketLeft   = BUCKET_PADDING + WALL_THICKNESS;
  const bucketRight  = BUCKET_PADDING + BUCKET_WIDTH - WALL_THICKNESS;
  const bucketTop    = height - BUCKET_PADDING - BUCKET_HEIGHT;
  const bucketBottom = height - BUCKET_PADDING - WALL_THICKNESS;

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
  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];
  GAME_STATE   = 'CALIBRATING';
  updateUIForState();
}

function resetToPlaying() {
  GAME_STATE = 'PLAYING';
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
      const si = ((ry + row) * PROCESS_WIDTH + (rx + col)) * 4;
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
  const cols = Math.floor(PROCESS_WIDTH  / SHADOW_CELL_SIZE);
  const rows = Math.floor(PROCESS_HEIGHT / SHADOW_CELL_SIZE);

  // Build shadow grid: true = cell is in shadow
  const grid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let darkCount = 0;
      const totalPixels = SHADOW_CELL_SIZE * SHADOW_CELL_SIZE;
      for (let dy = 0; dy < SHADOW_CELL_SIZE; dy++) {
        for (let dx = 0; dx < SHADOW_CELL_SIZE; dx++) {
          const cx = col * SHADOW_CELL_SIZE + dx;
          const cy = row * SHADOW_CELL_SIZE + dy;
          const i  = (cy * PROCESS_WIDTH + cx) * 4;
          const brightness = (px[i] + px[i + 1] + px[i + 2]) / 3;
          if (brightness < SHADOW_THRESHOLD) darkCount++;
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

  const scaleX = width  / PROCESS_WIDTH;
  const scaleY = height / PROCESS_HEIGHT;

  toAdd.forEach(({ row, runStart, runLen }) => {
    const camCX = (runStart + runLen / 2) * SHADOW_CELL_SIZE;
    const camCY = (row + 0.5) * SHADOW_CELL_SIZE;
    const [cx, cy] = camToCanvas(camCX, camCY);

    const bodyW = runLen * SHADOW_CELL_SIZE * scaleX;
    const bodyH = SHADOW_CELL_SIZE * scaleY;

    const b = Matter.Bodies.rectangle(cx, cy, bodyW, bodyH, {
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
      const OV = 20; // overlap margin in camera pixels
      const HW = PROCESS_WIDTH  / 2 + OV;
      const HH = PROCESS_HEIGHT / 2 + OV;

      const quadrants = [
        { rx: 0,                   ry: 0,                    rw: HW, rh: HH },  // TL
        { rx: PROCESS_WIDTH/2-OV,  ry: 0,                    rw: HW, rh: HH },  // TR
        { rx: 0,                   ry: PROCESS_HEIGHT/2-OV,  rw: HW, rh: HH },  // BL
        { rx: PROCESS_WIDTH/2-OV,  ry: PROCESS_HEIGHT/2-OV,  rw: HW, rh: HH }, // BR
      ];

      quadrants.forEach(q => {
        const hit = scanQuadrant(video.pixels, q.rx, q.ry, q.rw, q.rh);
        if (hit && ['SHADOW_TL','SHADOW_TR','SHADOW_BL','SHADOW_BR'].includes(hit.text)) {
          detectedMarkers[hit.text] = { camX: hit.camX, camY: hit.camY };
        }
      });

      // Transition when all four found
      if (Object.keys(detectedMarkers).length === 4) {
        homographyTransform = PerspT(buildSrcPts(detectedMarkers), buildDstPts());
        GAME_STATE = 'PLAYING';
        spawnBall();
        updateUIForState();
      }
    }
  }

  // ── 3. Game logic (PLAYING only) ──────────────────────────────
  if (GAME_STATE === 'PLAYING') {
    updateShadowColliders();
    checkWin();
    checkRespawn();
  }

  // ── 4. Render ─────────────────────────────────────────────────
  background(0);

  // Ghost webcam (unmirrored — mobile camera stream is not flipped)
  if (video) {
    push();
    tint(255, 30);
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
    fill(0, 255, 80, 200);
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

  // Bucket glow
  push();
  noStroke();
  fill(255, 220, 50, 18);
  rect(BUCKET_PADDING, height - BUCKET_PADDING - BUCKET_HEIGHT,
       BUCKET_WIDTH, BUCKET_HEIGHT);

  // Bucket walls (visual only — physics bodies drawn separately)
  stroke(255, 220, 50, 160);
  strokeWeight(2);
  noFill();
  // left wall
  line(BUCKET_PADDING + WALL_THICKNESS,
       height - BUCKET_PADDING - BUCKET_HEIGHT,
       BUCKET_PADDING + WALL_THICKNESS,
       height - BUCKET_PADDING);
  // right wall
  line(BUCKET_PADDING + BUCKET_WIDTH - WALL_THICKNESS,
       height - BUCKET_PADDING - BUCKET_HEIGHT,
       BUCKET_PADDING + BUCKET_WIDTH - WALL_THICKNESS,
       height - BUCKET_PADDING);
  // bottom
  line(BUCKET_PADDING, height - BUCKET_PADDING,
       BUCKET_PADDING + BUCKET_WIDTH, height - BUCKET_PADDING);
  pop();

  // Ball
  if (ball) {
    push();
    const bx = ball.position.x;
    const by = ball.position.y;

    // Glow
    drawingContext.shadowColor = 'rgba(255,255,255,0.8)';
    drawingContext.shadowBlur  = 24;
    fill(255);
    noStroke();
    circle(bx, by, BALL_RADIUS * 2);

    // Velocity direction dot
    drawingContext.shadowBlur = 0;
    fill(0, 200, 255);
    const vel = ball.velocity;
    const speed = sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed > 0.5) {
      circle(bx + vel.x * 2, by + vel.y * 2, 5);
    }
    pop();
  }

  // HUD
  push();
  fill(255, 200);
  noStroke();
  textSize(12);
  textFont('monospace');
  text(`FPS: ${nf(frameRate(), 2, 1)}  shadowRate: ${shadowRebuildRate}  [D] debug`, 10, height - 10);
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
}

function keyPressed() {
  if (key === 'D' || key === 'd') {
    debugMode = !debugMode;
  }
}
