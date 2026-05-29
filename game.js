const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

let hoveredUnit = null;

const PANEL = { x: 820, y: 30, w: 220, h: 500 };

const GRID_W = 10, GRID_H = 10;
const TILE_W = 64, TILE_H = 32;
const OFFSET_X = 400, OFFSET_Y = 60;

const TEAMS = {
  A: { name: 'Blue', color: '#4aa3ff', dark: '#1f5fb0' },
  B: { name: 'Red',  color: '#ff5a5a', dark: '#a02525' },
};

const CLASSES = {
  Knight: { hp: 32, move: 4, atk: 9,  atkRange: 1, evade: 0.05, crit: 0.05, color: '#ddd', sprite: 'knight.png' },
  Archer: { hp: 22, move: 4, atk: 6,  atkRange: 3, evade: 0.10, crit: 0.10, color: '#bfa' },
  Mage:   { hp: 18, move: 3, atk: 11, atkRange: 2, evade: 0.05, crit: 0.05, color: '#fae' },
  Rogue:  { hp: 24, move: 5, atk: 7,  atkRange: 1, evade: 0.30, crit: 0.25, color: '#fc6' },
};

// per-team sprite cache: SPRITES[cls][team] -> canvas or image
const SPRITES = {};
function tintSprite(img, color) {
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const c = off.getContext('2d');
  c.drawImage(img, 0, 0);
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = color;
  c.globalAlpha = 0.45;
  c.fillRect(0, 0, off.width, off.height);
  return off;
}
for (const [cls, def] of Object.entries(CLASSES)) {
  if (!def.sprite) continue;
  const img = new Image();
  img.onload = () => {
    SPRITES[cls] = { A: img, B: tintSprite(img, '#ff3030') };
    render();
  };
  img.src = `assets/${def.sprite}`;
}

let grid, units, currentTeam, selected, mode, moveTiles, attackTiles, acted, nextId, gameOver;
let projectile = null; // {from, to, t, kind, onComplete}

function init() {
  grid = Array.from({length: GRID_H}, () => Array(GRID_W).fill(0));
  [[4,4],[4,5],[5,4],[5,5],[2,7],[7,2],[3,2],[6,7]].forEach(([x,y]) => grid[y][x] = 1);

  nextId = 1;
  units = [];
  const make = (team, cls, x, y) => {
    const c = CLASSES[cls];
    units.push({
      id: nextId++, team, cls, name: cls, x, y,
      hp: c.hp, maxHp: c.hp,
      move: c.move, atk: c.atk, atkRange: c.atkRange,
      evade: c.evade, crit: c.crit,
    });
  };
  make('A', 'Knight', 0, 1);
  make('A', 'Archer', 0, 3);
  make('A', 'Mage',   1, 5);
  make('A', 'Rogue',  0, 7);
  make('B', 'Knight', 9, 8);
  make('B', 'Archer', 9, 6);
  make('B', 'Mage',   8, 4);
  make('B', 'Rogue',  9, 2);

  currentTeam = 'A';
  selected = null;
  mode = 'select';
  moveTiles = [];
  attackTiles = [];
  acted = new Set();
  gameOver = false;
  projectile = null;
  logEl.textContent = '';
  log('Battle begins. Blue moves first.');
  render();
}

function log(msg) {
  logEl.textContent = msg + '\n' + logEl.textContent;
}

function unitAt(x, y) {
  return units.find(u => u.x === x && u.y === y);
}

function isoToScreen(x, y) {
  return {
    sx: OFFSET_X + (x - y) * (TILE_W / 2),
    sy: OFFSET_Y + (x + y) * (TILE_H / 2),
  };
}

function unitCenter(u) {
  const { sx, sy } = isoToScreen(u.x, u.y);
  return { sx, sy: sy + TILE_H / 2 - 10 };
}

function screenToIso(sx, sy) {
  const mx = sx - OFFSET_X;
  const my = sy - OFFSET_Y - TILE_H / 2;
  const x = Math.round(mx / TILE_W + my / TILE_H);
  const y = Math.round(my / TILE_H - mx / TILE_W);
  return { x, y };
}

function drawDiamond(x, y, fill, stroke, lineWidth = 1) {
  const { sx, sy } = isoToScreen(x, y);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + TILE_W / 2, sy + TILE_H / 2);
  ctx.lineTo(sx, sy + TILE_H);
  ctx.lineTo(sx - TILE_W / 2, sy + TILE_H / 2);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

function bfsMoveRange(unit) {
  const key = (x, y) => `${x},${y}`;
  const dist = { [key(unit.x, unit.y)]: 0 };
  const queue = [[unit.x, unit.y, 0]];
  const result = [];
  while (queue.length) {
    const [x, y, d] = queue.shift();
    if (d === unit.move) continue;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      if (key(nx, ny) in dist) continue;
      if (grid[ny][nx] === 1) continue;
      const occ = unitAt(nx, ny);
      if (occ && occ.team !== unit.team) continue;
      dist[key(nx, ny)] = d + 1;
      if (!occ) result.push({ x: nx, y: ny, d: d + 1 });
      queue.push([nx, ny, d + 1]);
    }
  }
  return result;
}

function getAttackRange(unit) {
  const result = [];
  for (let dy = -unit.atkRange; dy <= unit.atkRange; dy++) {
    for (let dx = -unit.atkRange; dx <= unit.atkRange; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d === 0 || d > unit.atkRange) continue;
      const nx = unit.x + dx, ny = unit.y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      result.push({ x: nx, y: ny });
    }
  }
  return result;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let fill;
      if (grid[y][x] === 1) {
        fill = (x + y) % 2 === 0 ? '#5a4a3a' : '#4a3a2a';
      } else {
        fill = (x + y) % 2 === 0 ? '#3a6a3a' : '#2f5a30';
      }
      drawDiamond(x, y, fill, '#1a1a1a');
    }
  }

  if (mode === 'move') {
    for (const t of moveTiles) drawDiamond(t.x, t.y, 'rgba(80, 160, 255, 0.45)', '#5af', 1.5);
  }
  if (mode === 'attack') {
    for (const t of attackTiles) drawDiamond(t.x, t.y, 'rgba(255, 80, 80, 0.4)', '#f55', 1.5);
  }
  if (selected) drawDiamond(selected.x, selected.y, null, '#ff0', 2);

  const sorted = [...units].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  for (const u of sorted) {
    const { sx, sy } = isoToScreen(u.x, u.y);
    const cx = sx, cy = sy + TILE_H / 2;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 10, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // team aura ring
    ctx.fillStyle = TEAMS[u.team].color + '55';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 10, 18, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = TEAMS[u.team].color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;

    const sprite = SPRITES[u.cls] && SPRITES[u.cls][u.team];
    const dimmed = acted.has(u.id);

    if (sprite) {
      const size = 44;
      if (dimmed) ctx.globalAlpha = 0.55;
      ctx.drawImage(sprite, cx - size / 2, cy - size + 12, size, size);
      ctx.globalAlpha = 1.0;
    } else {
      ctx.fillStyle = TEAMS[u.team].color;
      ctx.fillRect(cx - 10, cy - 22, 20, 26);
      ctx.strokeStyle = TEAMS[u.team].dark;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - 10, cy - 22, 20, 26);
      ctx.fillStyle = CLASSES[u.cls].color;
      ctx.beginPath();
      ctx.arc(cx, cy - 26, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (dimmed) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(cx - 11, cy - 23, 22, 28);
      }
    }

    const hpW = 26;
    ctx.fillStyle = '#400';
    ctx.fillRect(cx - hpW/2, cy + 14, hpW, 4);
    ctx.fillStyle = u.hp / u.maxHp > 0.4 ? '#4f4' : (u.hp / u.maxHp > 0.2 ? '#fc4' : '#f44');
    ctx.fillRect(cx - hpW/2, cy + 14, hpW * (u.hp / u.maxHp), 4);

    ctx.fillStyle = '#fff';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(u.cls, cx, cy - (sprite ? 36 : 30));
  }

  if (projectile) drawProjectile(projectile);

  drawStatsPanel();

  let s = `Turn: ${TEAMS[currentTeam].name}   Mode: ${mode}`;
  const remain = units.filter(u => u.team === currentTeam && !acted.has(u.id)).length;
  s += `   Units left this turn: ${remain}`;
  statusEl.textContent = s;
}

function drawStatsPanel() {
  const u = hoveredUnit || selected;
  const { x: px, y: py, w: pw, h: ph } = PANEL;

  // translucent panel background
  ctx.fillStyle = 'rgba(8, 8, 16, 0.72)';
  ctx.fillRect(px, py, pw, ph);

  // border (team-colored when a unit is shown, neutral otherwise)
  ctx.strokeStyle = u ? TEAMS[u.team].color : '#444';
  ctx.lineWidth = 2;
  ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);

  // title bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(px + 2, py + 2, pw - 4, 28);

  if (!u) {
    ctx.fillStyle = '#888';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('UNIT INFO', px + pw / 2, py + 20);
    ctx.fillStyle = '#666';
    ctx.font = 'italic 12px system-ui';
    ctx.fillText('Hover or select', px + pw / 2, py + ph / 2 - 6);
    ctx.fillText('a unit to view stats', px + pw / 2, py + ph / 2 + 12);
    return;
  }

  // header label (HOVER / SELECTED)
  ctx.fillStyle = '#999';
  ctx.font = 'bold 10px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(hoveredUnit ? 'HOVERING' : 'SELECTED', px + 12, py + 20);

  // team badge (top-right of title bar)
  const teamText = TEAMS[u.team].name.toUpperCase();
  ctx.font = 'bold 10px system-ui';
  const tw = ctx.measureText(teamText).width + 12;
  ctx.fillStyle = TEAMS[u.team].color;
  ctx.fillRect(px + pw - tw - 12, py + 8, tw, 16);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.fillText(teamText, px + pw - tw / 2 - 12, py + 19);

  let cy = py + 50;

  // class name
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(u.cls, px + 14, cy);
  cy += 18;

  // sprite portrait if available
  const sprite = SPRITES[u.cls] && SPRITES[u.cls][u.team];
  if (sprite) {
    const portraitSize = 72;
    const portraitX = px + pw - portraitSize - 12;
    const portraitY = cy - 12;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(portraitX, portraitY, portraitSize, portraitSize);
    ctx.strokeStyle = TEAMS[u.team].color + '88';
    ctx.lineWidth = 1;
    ctx.strokeRect(portraitX + 0.5, portraitY + 0.5, portraitSize - 1, portraitSize - 1);
    ctx.drawImage(sprite, portraitX + 4, portraitY + 4, portraitSize - 8, portraitSize - 8);
  }

  cy += 16;

  // HP label + numbers
  ctx.fillStyle = '#aaa';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('HP', px + 14, cy);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'right';
  ctx.fillText(`${u.hp} / ${u.maxHp}`, px + pw - 14, cy);
  cy += 6;

  // HP bar
  const barX = px + 14, barW = pw - 28;
  ctx.fillStyle = 'rgba(80, 0, 0, 0.8)';
  ctx.fillRect(barX, cy, barW, 8);
  const hpPct = Math.max(0, u.hp / u.maxHp);
  const hpColor = hpPct > 0.4 ? '#4f4' : (hpPct > 0.2 ? '#fc4' : '#f44');
  ctx.fillStyle = hpColor;
  ctx.fillRect(barX, cy, barW * hpPct, 8);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, cy + 0.5, barW - 1, 7);
  cy += 24;

  // stat rows
  const rows = [
    ['Move', u.move],
    ['Attack', u.atk],
    ['Range', u.atkRange],
    ['Evade', `${Math.round((u.evade || 0) * 100)}%`],
    ['Crit', `${Math.round((u.crit || 0) * 100)}%`],
    ['Position', `(${u.x}, ${u.y})`],
  ];
  ctx.font = '12px system-ui';
  for (const [label, value] of rows) {
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'left';
    ctx.fillText(label, px + 14, cy);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText(String(value), px + pw - 14, cy);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 14, cy + 6);
    ctx.lineTo(px + pw - 14, cy + 6);
    ctx.stroke();
    cy += 22;
  }

  if (acted.has(u.id)) {
    cy += 6;
    ctx.fillStyle = '#fa4';
    ctx.font = 'italic 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Has acted this turn', px + pw / 2, cy);
  }
}

function drawProjectile(p) {
  // arc: project follows a slight parabolic curve
  const t = Math.min(1, p.t);
  const x = p.from.sx + (p.to.sx - p.from.sx) * t;
  const yLinear = p.from.sy + (p.to.sy - p.from.sy) * t;
  const arc = -Math.sin(t * Math.PI) * 30;
  const y = yLinear + arc;

  if (p.kind === 'Archer') {
    // arrow: line oriented along travel direction
    const dx = p.to.sx - p.from.sx;
    const dy = p.to.sy - p.from.sy;
    // tangent of the arc: derivative of y wrt t
    const dyArc = -Math.cos(t * Math.PI) * Math.PI * 30;
    const angle = Math.atan2(dy + dyArc, dx);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();
    // arrowhead
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(2, -3);
    ctx.lineTo(2, 3);
    ctx.closePath();
    ctx.fill();
    // fletching
    ctx.strokeStyle = '#f33';
    ctx.beginPath();
    ctx.moveTo(-10, 0);
    ctx.lineTo(-13, -3);
    ctx.moveTo(-10, 0);
    ctx.lineTo(-13, 3);
    ctx.stroke();
    ctx.restore();
  } else if (p.kind === 'Mage') {
    // glowing orb
    const grad = ctx.createRadialGradient(x, y, 1, x, y, 12);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.4, '#a6f');
    grad.addColorStop(1, 'rgba(120, 80, 200, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // fallback dot
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function animateProjectile() {
  if (!projectile) return;
  projectile.t += 0.06;
  if (projectile.t >= 1) {
    const cb = projectile.onComplete;
    projectile = null;
    render();
    cb();
    return;
  }
  render();
  requestAnimationFrame(animateProjectile);
}

function startProjectile(attacker, target, onComplete) {
  const from = unitCenter(attacker);
  const to = unitCenter(target);
  projectile = { from, to, t: 0, kind: attacker.cls, onComplete };
  requestAnimationFrame(animateProjectile);
}

function resolveAttack(attacker, target) {
  if (Math.random() < (target.evade || 0)) {
    log(`${TEAMS[target.team].name} ${target.cls} evades the attack!`);
  } else {
    const roll = Math.floor(Math.random() * 5) - 2;
    let dmg = Math.max(1, attacker.atk + roll);
    let critTag = '';
    if (Math.random() < (attacker.crit || 0)) {
      dmg = Math.floor(dmg * 1.6);
      critTag = ' (CRIT!)';
    }
    target.hp -= dmg;
    log(`${attacker.cls} hits ${TEAMS[target.team].name} ${target.cls} for ${dmg}${critTag}.`);
    if (target.hp <= 0) {
      log(`${TEAMS[target.team].name} ${target.cls} is defeated!`);
      units = units.filter(u => u.id !== target.id);
    }
  }
  finishUnit(attacker);
  if (checkVictory()) { render(); return; }
  render();
}

function endTurn() {
  if (gameOver) return;
  currentTeam = currentTeam === 'A' ? 'B' : 'A';
  acted = new Set();
  selected = null;
  moveTiles = [];
  attackTiles = [];
  mode = 'select';
  log(`--- ${TEAMS[currentTeam].name} team's turn ---`);
  render();
}

function finishUnit(u) {
  acted.add(u.id);
  selected = null;
  moveTiles = [];
  attackTiles = [];
  mode = 'select';
  if (units.filter(x => x.team === currentTeam).every(x => acted.has(x.id))) {
    log(`${TEAMS[currentTeam].name} team has no more units to act. Ending turn.`);
    setTimeout(endTurn, 250);
  }
}

function checkVictory() {
  const aliveA = units.some(u => u.team === 'A');
  const aliveB = units.some(u => u.team === 'B');
  if (!aliveA || !aliveB) {
    gameOver = true;
    const winner = aliveA ? 'Blue' : 'Red';
    log(`*** ${winner} team wins! ***`);
    setTimeout(() => alert(`${winner} team wins!`), 50);
    return true;
  }
  return false;
}

function cancelSelection() {
  if (mode === 'attack' && selected) {
    log(`${selected.cls} waits.`);
    finishUnit(selected);
    return;
  }
  selected = null;
  moveTiles = [];
  attackTiles = [];
  mode = 'select';
}

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (projectile) return;
  cancelSelection();
  render();
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const { x, y } = screenToIso(sx, sy);
  const u = (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) ? unitAt(x, y) : null;
  if (u !== hoveredUnit) {
    hoveredUnit = u;
    render();
  }
});

canvas.addEventListener('mouseleave', () => {
  if (hoveredUnit) {
    hoveredUnit = null;
    render();
  }
});

canvas.addEventListener('click', (e) => {
  if (gameOver || projectile) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const { x, y } = screenToIso(sx, sy);
  if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) { cancelSelection(); render(); return; }

  const clicked = unitAt(x, y);

  if (mode === 'select') {
    if (clicked && clicked.team === currentTeam && !acted.has(clicked.id)) {
      selected = clicked;
      moveTiles = bfsMoveRange(selected);
      mode = 'move';
    }
  } else if (mode === 'move') {
    if (clicked && clicked.id === selected.id) {
      attackTiles = getAttackRange(selected);
      mode = 'attack';
    } else if (!clicked && moveTiles.some(t => t.x === x && t.y === y)) {
      log(`${selected.cls} moves to (${x}, ${y}).`);
      selected.x = x;
      selected.y = y;
      attackTiles = getAttackRange(selected);
      mode = 'attack';
    } else {
      cancelSelection();
    }
  } else if (mode === 'attack') {
    if (clicked && clicked.team !== currentTeam && attackTiles.some(t => t.x === x && t.y === y)) {
      const attacker = selected;
      const target = clicked;
      if (attacker.atkRange > 1) {
        startProjectile(attacker, target, () => resolveAttack(attacker, target));
        render();
        return;
      } else {
        resolveAttack(attacker, target);
        return;
      }
    } else {
      log(`${selected.cls} waits.`);
      finishUnit(selected);
    }
  }
  render();
});

document.getElementById('endTurn').addEventListener('click', endTurn);
document.getElementById('wait').addEventListener('click', () => {
  if (projectile) return;
  if (selected) {
    log(`${selected.cls} waits.`);
    finishUnit(selected);
    render();
  }
});
document.getElementById('reset').addEventListener('click', init);

// --- music ---
const midiPlayer = document.getElementById('midiPlayer');
const musicBtn = document.getElementById('music');
let musicEnabled = true;
let musicStarted = false;
let playerReady = false;

console.log('[music] init — player el:', midiPlayer, ' btn el:', musicBtn);

if (midiPlayer) {
  midiPlayer.addEventListener('load', () => {
    playerReady = true;
    console.log('[music] player loaded — ready to play');
  });
  midiPlayer.addEventListener('start', () => console.log('[music] playback started'));
  midiPlayer.addEventListener('stop', () => console.log('[music] playback stopped'));
}

function setBtnLabel() {
  if (musicBtn) musicBtn.textContent = (musicEnabled ? '♫ Music: ON' : '♫ Music: OFF');
}

function safeStart() {
  if (!midiPlayer || typeof midiPlayer.start !== 'function') {
    console.warn('[music] start() unavailable — player not upgraded yet');
    return false;
  }
  try {
    midiPlayer.start();
    return true;
  } catch (e) {
    console.warn('[music] start() threw:', e);
    return false;
  }
}

function safeStop() {
  if (!midiPlayer || typeof midiPlayer.stop !== 'function') return;
  try { midiPlayer.stop(); } catch (e) { console.warn('[music] stop() threw:', e); }
}

function tryStartMusic() {
  if (!musicEnabled || musicStarted) return;
  if (safeStart()) musicStarted = true;
}

function toggleMusic() {
  musicEnabled = !musicEnabled;
  setBtnLabel();
  console.log('[music] toggled — enabled now:', musicEnabled);
  if (musicEnabled) {
    if (safeStart()) musicStarted = true;
  } else {
    safeStop();
    musicStarted = false;
  }
}

if (musicBtn) {
  musicBtn.addEventListener('click', toggleMusic);
  console.log('[music] click handler attached to button');
}
document.addEventListener('click', tryStartMusic);
document.addEventListener('keydown', tryStartMusic);

setBtnLabel();
init();
