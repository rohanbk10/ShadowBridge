// ── SECTION 1: Constants ──────────────────────────────────────────
const GRAVITY            = 1.0;

// Camera capture resolution
const CAL_WIDTH          = 640;
const CAL_HEIGHT         = 480;

// Shadow detection processes cells at a coarser logical grid.
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
const EDGE_MARGIN        = 30;   // inset from window edges for walls, bucket, and ball
const BALL_RADIUS        = 18;
const BALL_RESTITUTION   = 0.6;
const RESPAWN_COOLDOWN   = 45;

const BG_CAPTURE_FRAMES  = 180;  // 3 seconds at 60 fps

// ── SECTION 2: Globals ───────────────────────────────────────────
let GAME_STATE = 'CAPTURING_BG';   // 'CAPTURING_BG' | 'PLAYING' | 'WIN'
let debugMode  = false;
let cameraViewMode = false;

// Vision
let video            = null;
let referencePixels  = null;
let shadowGrid       = null;   // reused each frame for both render and physics
let shadowGridCols   = 0;
let shadowGridRows   = 0;

// Background capture countdown
let bgCaptureCountdown = BG_CAPTURE_FRAMES;

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

  video = createCapture(
    { video: { width: { ideal: CAL_WIDTH }, height: { ideal: CAL_HEIGHT } } },
    () => {
      video.size(CAL_WIDTH, CAL_HEIGHT);
      video.hide();
    }
  );

  // Compute grid dimensions once (they don't change)
  shadowGridCols = Math.floor(PROCESS_WIDTH  / SHADOW_CELL_SIZE);
  shadowGridRows = Math.floor(PROCESS_HEIGHT / SHADOW_CELL_SIZE);
  shadowGrid     = new Uint8Array(shadowGridCols * shadowGridRows);

  // Matter engine — no Render, no Runner
  engine = Matter.Engine.create();
  engine.world.gravity.y = GRAVITY;

  GAME_STATE         = 'CAPTURING_BG';
  bgCaptureCountdown = BG_CAPTURE_FRAMES;

  rebuildStaticBodies();

  document.getElementById('btn-recapture')
    .addEventListener('click', startBgCapture);
  document.getElementById('btn-play-again')
    .addEventListener('click', resetToPlaying);

  updateUIForState();
  noStroke();
}

// ── SECTION 4: Layout + Matter bodies ────────────────────────────
function getBucketOrigin() {
  return {
    bx: width  - EDGE_MARGIN - BUCKET_WIDTH,
    by: height - EDGE_MARGIN,
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
    x: EDGE_MARGIN + BALL_RADIUS + 12,
    y: EDGE_MARGIN + 36,
  };
}

function rebuildStaticBodies() {
  boundaryBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  bucketBodies.forEach(b   => Matter.Composite.remove(engine.world, b));
  boundaryBodies = [];
  bucketBodies   = [];

  const opts = { isStatic: true, friction: WALL_FRICTION, restitution: WALL_RESTITUTION };

  const wallTop     = EDGE_MARGIN;
  const wallHeight  = max(height - EDGE_MARGIN * 2, 100);
  const wallCenterY = wallTop + wallHeight / 2;

  const leftWall  = Matter.Bodies.rectangle(
    WALL_THICKNESS / 2, wallCenterY, WALL_THICKNESS, wallHeight, opts);
  const rightWall = Matter.Bodies.rectangle(
    width - WALL_THICKNESS / 2, wallCenterY, WALL_THICKNESS, wallHeight, opts);
  const ceilingWidth = max(width - EDGE_MARGIN * 2, 100);
  const ceiling = Matter.Bodies.rectangle(
    width / 2, EDGE_MARGIN - WALL_THICKNESS / 2,
    ceilingWidth, WALL_THICKNESS, opts);
  boundaryBodies.push(leftWall, rightWall, ceiling);

  // Bucket — bottom-right
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
  const recapBtn  = document.getElementById('btn-recapture');
  const winEl     = document.getElementById('win-overlay');

  statusEl.style.display = GAME_STATE === 'CAPTURING_BG' ? 'block' : 'none';
  recapBtn.hidden         = GAME_STATE !== 'PLAYING';
  winEl.hidden            = GAME_STATE !== 'WIN';
}

function startBgCapture() {
  referencePixels = null;
  bgCaptureCountdown = BG_CAPTURE_FRAMES;
  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];
  if (ball) {
    Matter.Composite.remove(engine.world, ball);
    ball = null;
  }
  GAME_STATE = 'CAPTURING_BG';
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

// Linear mapping: camera pixel coordinates → canvas coordinates.
// Mirrors horizontally so the shadow behaves like a reflection
// when the camera faces the same direction as the projector.
function camToCanvas(camX, camY) {
  return [
    width  - (camX / CAL_WIDTH)  * width,
    (camY / CAL_HEIGHT) * height,
  ];
}

function buildShadowGrid() {
  video.loadPixels();
  if (!video.pixels || video.pixels.length === 0) return false;

  const px  = video.pixels;
  const ref = referencePixels;

  for (let row = 0; row < shadowGridRows; row++) {
    for (let col = 0; col < shadowGridCols; col++) {
      let darkCount = 0;
      const totalPixels = SHADOW_CELL_SIZE * SHADOW_CELL_SIZE;
      for (let dy = 0; dy < SHADOW_CELL_SIZE; dy++) {
        for (let dx = 0; dx < SHADOW_CELL_SIZE; dx++) {
          const cx = (col * SHADOW_CELL_SIZE + dx) * PROCESS_STRIDE;
          const cy = (row * SHADOW_CELL_SIZE + dy) * PROCESS_STRIDE;
          const i  = (cy * CAL_WIDTH + cx) * 4;
          const brightness    = (px[i] + px[i + 1] + px[i + 2]) / 3;
          const refBrightness = ref
            ? (ref[i] + ref[i + 1] + ref[i + 2]) / 3
            : 255;
          if (brightness < refBrightness - SHADOW_THRESHOLD) darkCount++;
        }
      }
      shadowGrid[row * shadowGridCols + col] = darkCount > totalPixels * 0.5 ? 1 : 0;
    }
  }
  return true;
}

function updateShadowColliders() {
  if (!buildShadowGrid()) return;

  // RLE: collect candidate segments per row
  const candidates = [];
  for (let row = 0; row < shadowGridRows; row++) {
    let runStart = -1;
    for (let col = 0; col <= shadowGridCols; col++) {
      const isShadow = col < shadowGridCols && shadowGrid[row * shadowGridCols + col] === 1;
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

  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];

  toAdd.forEach(({ row, runStart, runLen }) => {
    const camCX = (runStart + runLen / 2) * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const camCY = (row + 0.5)             * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const [cx, cy] = camToCanvas(camCX, camCY);

    if (cx < WALL_THICKNESS || cx > width - WALL_THICKNESS) return;
    if (cy < EDGE_MARGIN    || cy > height) return;

    // Width: transform both horizontal edges through the linear mapping
    const camLeft  = runStart            * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const camRight = (runStart + runLen) * SHADOW_CELL_SIZE * PROCESS_STRIDE;
    const [lx]     = camToCanvas(camLeft,  camCY);
    const [rx]     = camToCanvas(camRight, camCY);
    const bodyW    = Math.abs(rx - lx);

    // Height: transform top and bottom of the cell row
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

  // ── 2. Background capture countdown ───────────────────────────
  if (GAME_STATE === 'CAPTURING_BG') {
    bgCaptureCountdown--;

    const secsLeft = Math.ceil(bgCaptureCountdown / 60);
    document.getElementById('calibration-status').textContent =
      bgCaptureCountdown > 0
        ? `Step away from the camera — capturing in ${secsLeft}…`
        : 'Capturing background…';

    if (bgCaptureCountdown <= 0) {
      video.loadPixels();
      if (video.pixels && video.pixels.length > 0) {
        referencePixels = new Uint8Array(video.pixels);
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

  // Optional webcam overlay (toggle with C)
  if (cameraViewMode && video) {
    push();
    tint(255, 80);
    // Draw mirrored to match camToCanvas horizontal flip
    translate(width, 0);
    scale(-1, 1);
    image(video, 0, 0, width, height);
    pop();
  }

  // Shadow silhouette rendering — drawn first so game elements sit on top
  if (GAME_STATE === 'PLAYING' || GAME_STATE === 'WIN') {
    push();
    noStroke();
    const cellW = width  / shadowGridCols;
    const cellH = height / shadowGridRows;
    for (let row = 0; row < shadowGridRows; row++) {
      for (let col = 0; col < shadowGridCols; col++) {
        if (shadowGrid[row * shadowGridCols + col] === 1) {
          // Mirror horizontally to match camToCanvas
          const drawCol = shadowGridCols - 1 - col;
          fill(20, 20, 20, 160);
          rect(drawCol * cellW, row * cellH, cellW + 1, cellH + 1);
        }
      }
    }
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

  // Bucket glow (bottom-right)
  const { bx, by } = getBucketOrigin();
  push();
  noStroke();
  fill(255, 200, 0, 40);
  rect(bx, by - BUCKET_HEIGHT, BUCKET_WIDTH, BUCKET_HEIGHT);

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

    drawingContext.shadowColor = 'rgba(0,0,0,0.25)';
    drawingContext.shadowBlur  = 16;
    fill(30, 30, 40);
    noStroke();
    circle(ballX, ballY, BALL_RADIUS * 2);

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
  if (ball && GAME_STATE === 'PLAYING') spawnBall();
}

function keyPressed() {
  if (key === 'D' || key === 'd') debugMode = !debugMode;
  if (key === 'C' || key === 'c') cameraViewMode = !cameraViewMode;
}
