// ── SECTION 1: Constants ──────────────────────────────────────────
const GRAVITY          = 1.0;
const WALL_THICKNESS   = 20;
const WALL_FRICTION    = 0.3;
const WALL_RESTITUTION = 0.4;
const BUCKET_WIDTH     = 160;
const BUCKET_HEIGHT    = 120;
const EDGE_MARGIN      = 30;
const BALL_RADIUS      = 18;
const BALL_RESTITUTION = 0.6;
const RESPAWN_COOLDOWN = 45;

// Pose shadow rendering
const LIMB_THICKNESS   = 40;   // canvas-px thickness for arm/leg segments
const HEAD_RADIUS      = 36;   // canvas-px radius for head circle
const MIN_VISIBILITY   = 0.5;  // skip MediaPipe landmarks below this confidence

// ── SECTION 2: Globals ───────────────────────────────────────────
let GAME_STATE     = 'LOADING';   // 'LOADING' | 'PLAYING' | 'WIN'
let cameraViewMode = false;

// Pose estimation
let poseDetector    = null;
let poseLandmarks   = null;   // Array<{x,y,z,visibility}> normalised 0-1, updated by callback
let poseReady       = false;
let poseFramePending = false; // guard: only one frame in-flight at a time

// Camera
let video        = null;
let shadowBuffer = null;   // offscreen graphics buffer for unified silhouette compositing

// Matter
let engine;
let ball;
let boundaryBodies = [];
let bucketBodies   = [];
let shadowBodies   = [];

let lastRespawnFrame = 0;

// ── SECTION 3: p5 setup() ────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);
  shadowBuffer = createGraphics(windowWidth, windowHeight);

  video = createCapture(
    { video: { width: { ideal: 640 }, height: { ideal: 480 } } },
    () => {
      video.size(640, 480);
      video.hide();
      // Initialise pose only after the video element exists and is streaming
      initPose();
    }
  );

  // Matter engine — no Render, no Runner
  engine = Matter.Engine.create();
  engine.world.gravity.y = GRAVITY;

  rebuildStaticBodies();

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

// ── SECTION 5: Ball lifecycle ─────────────────────────────────────
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
  const statusEl = document.getElementById('calibration-status');
  const winEl    = document.getElementById('win-overlay');

  statusEl.style.display = GAME_STATE === 'LOADING' ? 'block' : 'none';
  winEl.hidden            = GAME_STATE !== 'WIN';
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

// ── SECTION 7: Pose estimation ────────────────────────────────────

function initPose() {
  // Pin to a known-good stable release so the CDN always serves the right WASM files.
  const VERSION = '0.5.1675469404';
  poseDetector = new Pose({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${VERSION}/${f}`
  });
  poseDetector.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  poseDetector.onResults((results) => {
    poseFramePending = false;   // allow the next frame to be sent
    poseLandmarks = results.poseLandmarks ?? null;
    if (!poseReady) {
      poseReady  = true;
      GAME_STATE = 'PLAYING';
      spawnBall();
      updateUIForState();
    }
  });
}

// Map a normalised MediaPipe landmark to canvas coordinates.
// Mirrors x so the player's right side appears on the right of the projection.
function landmarkToCanvas(lm) {
  return [(1 - lm.x) * width, lm.y * height];
}

// ── SECTION 8: Shadow rendering ───────────────────────────────────

// Draw one limb as a filled, rounded, rotated rectangle onto a p5.Graphics context.
function drawLimbSegment(g, ax, ay, bx, by, thickness) {
  const angle = Math.atan2(by - ay, bx - ax);
  const len   = dist(ax, ay, bx, by);
  if (len < 2) return;
  g.push();
  g.translate((ax + bx) / 2, (ay + by) / 2);
  g.rotate(angle);
  g.rectMode(CENTER);
  g.rect(0, 0, len, thickness, thickness / 2);
  g.pop();
}

function drawShadowSilhouette() {
  if (!poseLandmarks || !shadowBuffer) return;

  const lm = poseLandmarks;
  const g  = shadowBuffer;

  // Clear the offscreen buffer each frame, then draw every body part in solid
  // black. Because all shapes go onto a single buffer before compositing, any
  // overlapping parts (arm meets torso, head meets shoulder) merge seamlessly
  // into one flat black silhouette rather than producing darker blended edges.
  g.clear();
  g.noStroke();
  g.fill(0);

  // Head
  const nose = lm[0];
  if (nose.visibility >= MIN_VISIBILITY) {
    const [nx, ny] = landmarkToCanvas(nose);
    g.circle(nx, ny, HEAD_RADIUS * 2);
  }

  // Torso — filled quad: left-shoulder → right-shoulder → right-hip → left-hip
  const lShoulder = lm[11];
  const rShoulder = lm[12];
  const lHip      = lm[23];
  const rHip      = lm[24];
  if ([lShoulder, rShoulder, lHip, rHip].every(p => p.visibility >= MIN_VISIBILITY)) {
    const [lsx, lsy] = landmarkToCanvas(lShoulder);
    const [rsx, rsy] = landmarkToCanvas(rShoulder);
    const [lhx, lhy] = landmarkToCanvas(lHip);
    const [rhx, rhy] = landmarkToCanvas(rHip);
    g.beginShape();
    g.vertex(lsx, lsy);
    g.vertex(rsx, rsy);
    g.vertex(rhx, rhy);
    g.vertex(lhx, lhy);
    g.endShape(CLOSE);
  }

  // Arms and legs as filled rotated rectangles
  const limbPairs = [
    [11, 13], [13, 15],   // left upper arm, forearm
    [12, 14], [14, 16],   // right upper arm, forearm
    [23, 25], [25, 27],   // left thigh, shin
    [24, 26], [26, 28],   // right thigh, shin
  ];

  limbPairs.forEach(([iA, iB]) => {
    const a = lm[iA];
    const b = lm[iB];
    if (a.visibility < MIN_VISIBILITY || b.visibility < MIN_VISIBILITY) return;
    const [ax, ay] = landmarkToCanvas(a);
    const [bx, by] = landmarkToCanvas(b);
    drawLimbSegment(g, ax, ay, bx, by, LIMB_THICKNESS);
  });

  // Composite the unified silhouette onto the main canvas
  image(g, 0, 0);
}

// ── SECTION 9: Physics colliders from pose ────────────────────────

function updatePoseColliders() {
  shadowBodies.forEach(b => Matter.Composite.remove(engine.world, b));
  shadowBodies = [];
  if (!poseLandmarks) return;

  const lm   = poseLandmarks;
  const opts = { isStatic: true, label: 'shadow', friction: WALL_FRICTION, restitution: WALL_RESTITUTION };

  // Head — circle body at the nose landmark
  const nose = lm[0];
  if (nose.visibility >= MIN_VISIBILITY) {
    const [nx, ny] = landmarkToCanvas(nose);
    shadowBodies.push(Matter.Bodies.circle(nx, ny, HEAD_RADIUS, opts));
  }

  // Torso + limbs as rotated rectangle bars.
  // [11,12] shoulder bar and [23,24] hip bar close the torso rectangle so
  // the full torso surface (not just the sides) is a solid collider.
  const segments = [
    [11, 12],             // shoulder bar — top of torso
    [11, 13], [13, 15],   // left upper arm, forearm
    [12, 14], [14, 16],   // right upper arm, forearm
    [11, 23], [12, 24],   // left/right torso sides
    [23, 24],             // hip bar — bottom of torso
    [23, 25], [25, 27],   // left thigh, shin
    [24, 26], [26, 28],   // right thigh, shin
  ];

  segments.forEach(([iA, iB]) => {
    const lmA = lm[iA];
    const lmB = lm[iB];
    if (lmA.visibility < MIN_VISIBILITY || lmB.visibility < MIN_VISIBILITY) return;

    const [ax, ay] = landmarkToCanvas(lmA);
    const [bx, by] = landmarkToCanvas(lmB);
    const cx    = (ax + bx) / 2;
    const cy    = (ay + by) / 2;
    const len   = Math.hypot(bx - ax, by - ay);
    const angle = Math.atan2(by - ay, bx - ax);

    shadowBodies.push(
      Matter.Bodies.rectangle(cx, cy, Math.max(len, 10), LIMB_THICKNESS, { ...opts, angle })
    );
  });

  Matter.Composite.add(engine.world, shadowBodies);
}

// ── SECTION 10: p5 draw() ─────────────────────────────────────────
function draw() {
  // ── 1. Send frame to MediaPipe (one frame in-flight at a time) ──────────────
  // Only send when the previous result has arrived (poseFramePending = false)
  // and the video element is actively streaming (readyState >= 2).
  if (video && video.elt && poseDetector && !poseFramePending &&
      video.elt.readyState >= 2) {
    poseFramePending = true;
    poseDetector.send({ image: video.elt }).catch(() => {
      poseFramePending = false;   // reset on error so we don't get stuck
    });
  }

  // ── 2. Physics update ─────────────────────────────────────────
  if (GAME_STATE !== 'WIN') {
    Matter.Engine.update(engine, 1000 / 60);
  }

  // ── 3. Game logic (PLAYING only) ──────────────────────────────
  if (GAME_STATE === 'PLAYING') {
    updatePoseColliders();
    checkWin();
    checkRespawn();
  }

  // ── 4. Render ─────────────────────────────────────────────────
  background(255);

  // Optional webcam overlay (toggle with C) — mirrored to match shadow
  if (cameraViewMode && video) {
    push();
    tint(255, 80);
    translate(width, 0);
    scale(-1, 1);
    image(video, 0, 0, width, height);
    pop();
  }

  // Person shadow silhouette — drawn before game elements so ball sits on top
  if (GAME_STATE === 'PLAYING' || GAME_STATE === 'WIN') {
    drawShadowSilhouette();
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
    const vel   = ball.velocity;
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
  const poseStatus = poseLandmarks ? 'tracking' : 'searching…';
  text(`FPS: ${nf(frameRate(), 2, 1)}  pose: ${poseStatus}  [C] camera`, 10, height - 10);
  pop();
}

// ── SECTION 11: p5 windowResized / keyPressed ─────────────────────
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  shadowBuffer = createGraphics(windowWidth, windowHeight);
  rebuildStaticBodies();
  if (ball && GAME_STATE === 'PLAYING') spawnBall();
}

function keyPressed() {
  if (key === 'C' || key === 'c') cameraViewMode = !cameraViewMode;
}
