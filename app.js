/* Jelly Bomb Grid — Real-time conditional win probabilities
   Rules: loser is the first who has collected ALL n bombs on their own board.
   Interaction: tap => mark SAFE, long-press => mark BOMB.
   We treat your marks as "already observed draws" on each board.
   Future draws are assumed uniform random among remaining cells (without replacement).
*/

const els = {
  aInput: document.getElementById("aInput"),
  nInput: document.getElementById("nInput"),
  applyBtn: document.getElementById("applyBtn"),
  resetBtn: document.getElementById("resetBtn"),
  langSelect: document.getElementById("langSelect"),

  boardA: document.getElementById("boardA"),
  boardB: document.getElementById("boardB"),

  metaA: document.getElementById("metaA"),
  metaB: document.getElementById("metaB"),

  pA: document.getElementById("pA"),
  pB: document.getElementById("pB"),
  pTie: document.getElementById("pTie"),

  warnBox: document.getElementById("warnBox"),
  asyncNote: document.getElementById("asyncNote"),

  resultModal: document.getElementById("resultModal"),
  resultTitle: document.getElementById("resultTitle"),
  resultSub: document.getElementById("resultSub"),
  closeResultBtn: document.getElementById("closeResultBtn"),
  restartBtn: document.getElementById("restartBtn"),
};

const I18N = {
  zh: {
    appTitle: "Bomb Grid -- 女巫的毒药🫣",
    langLabel: "语言 / Language",
    aLabel: "棋盘边长 a（≤20）",
    nLabel: "炸弹数 n（≤a²）",
    newGame: "新游戏",
    panelTitle: "实时胜率（条件概率）",
    aWin: "A胜",
    bWin: "B胜",
    tie: "平",
    legendUnknown: "未知",
    legendSafe: "安全（轻点）",
    legendBomb: "炸弹（长按）",
    reset: "重置（清空标记）",
    gameOver: "游戏结束",
    continue: "继续",
    restart: "重新开始",
    asyncNote: "提示：原题为同步回合（每轮 A、B 各抽1格）。当前两边已标记格子数不同，将按“各自已抽取次数”计算谁先踩齐全部炸弹。",
    errNTooLarge: "错误：n 不能大于 a²。",
    errBombsOver: "错误：某一方标记的炸弹数超过 n。",
    errRemainNeg: "错误：剩余炸弹数为负（请减少红色格子）。",
    errRemainTooFew: "错误：剩余格子不足以容纳剩余炸弹（请减少灰色格子或增大 n）。",
    outcomeTie: "平局",
    outcomeNoBomb: "没有炸弹",
    outcomeTieBoth: "双方同时踩满炸弹",
    outcomeAWin: "A获胜",
    outcomeBWin: "B获胜",
    outcomeADead: "A踩满炸弹",
    outcomeBDead: "B踩满炸弹",
    meta: "已标记 {picked}/{N} | 已命中炸弹 {bombsFound}/{n} | 剩余格 {remaining}",
    hintText: "点/长按",
  },
  en: {
    appTitle: "Bomb Grid -- Witch's Poison 🫣",
    langLabel: "Language",
    aLabel: "Board size a (≤20)",
    nLabel: "Bombs n (≤a²)",
    newGame: "New Game",
    panelTitle: "Live Win Odds (Conditional)",
    aWin: "A Wins",
    bWin: "B Wins",
    tie: "Tie",
    legendUnknown: "Unknown",
    legendSafe: "Safe (tap)",
    legendBomb: "Bomb (press)",
    reset: "Reset",
    gameOver: "Game Over",
    continue: "Continue",
    restart: "Restart",
    asyncNote: "Note: the original game is synchronous (each round both A and B draw one cell). Your marked counts differ, so we compute by each side’s own draws.",
    errNTooLarge: "Error: n cannot exceed a².",
    errBombsOver: "Error: bombs marked exceed n.",
    errRemainNeg: "Error: remaining bombs is negative (reduce red cells).",
    errRemainTooFew: "Error: remaining cells are fewer than remaining bombs (reduce gray cells or increase n).",
    outcomeTie: "Tie",
    outcomeNoBomb: "No bombs",
    outcomeTieBoth: "Both hit all bombs",
    outcomeAWin: "A Wins",
    outcomeBWin: "B Wins",
    outcomeADead: "A hit all bombs",
    outcomeBDead: "B hit all bombs",
    meta: "Marked {picked}/{N} | Bombs hit {bombsFound}/{n} | Remaining {remaining}",
    hintText: "Tap / Press",
  },
};

const Cell = { UNKNOWN: 0, SAFE: 1, BOMB: 2 };

let state = {
  a: 3,
  n: 3,
  N: 100,
  logFact: null,

  // each board: cells[], picked, bombsFound
  A: null,
  B: null,

  // debounce handle
  pending: false,

  gameOver: false,
  lang: "zh",
};

function clampInt(x, lo, hi){
  x = Number(x);
  if (!Number.isFinite(x)) return lo;
  x = Math.floor(x);
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function fmtProb(p){
  if (!Number.isFinite(p)) return "—";
  return (p * 100).toFixed(2) + "%";
}

function buildLogFact(N){
  const lf = new Float64Array(N + 1);
  lf[0] = 0;
  for (let i = 1; i <= N; i++) lf[i] = lf[i - 1] + Math.log(i);
  return lf;
}

function logChoose(lf, n, k){
  if (k < 0 || k > n) return -Infinity;
  return lf[n] - lf[k] - lf[n - k];
}

// Create a board object
function makeBoard(N){
  return {
    cells: new Uint8Array(N), // default 0 UNKNOWN
  };
}

function countStats(board){
  let picked = 0;
  let bombsFound = 0;
  for (let i = 0; i < board.cells.length; i++){
    const s = board.cells[i];
    if (s !== Cell.UNKNOWN) picked++;
    if (s === Cell.BOMB) bombsFound++;
  }
  return { picked, bombsFound, remaining: board.cells.length - picked };
}

/**
 * Completion time pmf for a player, conditional on current marks.
 * - Total cells N fixed.
 * - picked = already revealed cells (safe or bomb)
 * - R = remaining cells
 * - b = remaining bombs (n - bombsFound) that are hidden among remaining cells
 * If b==0 => completion already occurred at time picked (degenerate).
 * Else additional steps U = max position of b bombs in random permutation of length R.
 * P(U=u) = C(u-1, b-1) / C(R, b), u=b..R
 * Total completion time T = picked + u
 */
function completionPmf(N, picked, R, b, logFact){
  const pmf = new Float64Array(N + 1);
  if (b === 0){
    // already has all bombs
    if (picked >= 0 && picked <= N) pmf[picked] = 1;
    return pmf;
  }
  const denomLog = logChoose(logFact, R, b);
  for (let u = b; u <= R; u++){
    const logNum = logChoose(logFact, u - 1, b - 1);
    const p = Math.exp(logNum - denomLog);
    pmf[picked + u] += p;
  }
  return pmf;
}

/**
 * Compare completion times:
 * - A wins when B loses earlier: TB < TA
 * - B wins when A loses earlier: TA < TB
 * - Tie when TA == TB
 */
function compareFromPmfs(pmfA, pmfB){
  const N = pmfA.length - 1;
  let tie = 0;
  let Awin = 0;
  let Bwin = 0;

  let cdfA = 0;
  let cdfB = 0;

  for (let t = 0; t <= N; t++){
    const pA = pmfA[t];
    const pB = pmfB[t];

    tie += pA * pB;

    cdfA += pA;
    cdfB += pB;

    // P(A wins) = Σ_t P(TB=t) * P(TA > t) = Σ pB[t] * (1 - CDF_A(t))
    Awin += pB * (1 - cdfA);

    // P(B wins) = Σ_t P(TA=t) * P(TB > t) = Σ pA[t] * (1 - CDF_B(t))
    Bwin += pA * (1 - cdfB);
  }

  // numeric cleanup
  const sum = Awin + Bwin + tie;
  if (sum > 0){
    Awin /= sum;
    Bwin /= sum;
    tie  /= sum;
  }

  return { Awin, Bwin, tie };
}

function setWarning(msg){
  if (!msg){
    els.warnBox.style.display = "none";
    els.warnBox.textContent = "";
  } else {
    els.warnBox.style.display = "";
    els.warnBox.textContent = msg;
  }
}

function setAsyncNote(msg){
  if (!els.asyncNote) return;
  if (!msg){
    els.asyncNote.style.display = "none";
    els.asyncNote.textContent = "";
  } else {
    els.asyncNote.style.display = "";
    els.asyncNote.textContent = msg;
  }
}

function t(key){
  return I18N[state.lang]?.[key] ?? I18N.zh[key] ?? "";
}

function formatMeta(stats, N, n){
  return t("meta")
    .replace("{picked}", stats.picked)
    .replace("{N}", N)
    .replace("{bombsFound}", stats.bombsFound)
    .replace("{n}", n)
    .replace("{remaining}", stats.remaining);
}

function applyLanguage(){
  const nodes = document.querySelectorAll("[data-i18n]");
  nodes.forEach((el) => {
    const key = el.dataset.i18n;
    const text = t(key);
    if (text) el.textContent = text;
  });
  document.documentElement.style.setProperty("--hint-text", `"${t("hintText")}"`);
  document.title = t("appTitle") || document.title;
}

function haptic(kind){
  if (!navigator.vibrate) return;
  const isCoarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  if (!isCoarse) return;
  if (kind === "strong") navigator.vibrate([30, 20, 40]);
  else navigator.vibrate(12);
}

function applyGame(){
  const a = clampInt(els.aInput.value, 1, 100);
  const N = a * a;

  // n can be 0..N
  const nMax = N;
  els.nInput.max = String(nMax);
  const n = clampInt(els.nInput.value, 0, nMax);

  state.a = a;
  state.n = n;
  state.N = N;
  state.logFact = buildLogFact(N);

  state.A = makeBoard(N);
  state.B = makeBoard(N);

  hideResult();
  state.gameOver = false;
  renderBoards();
  scheduleRecompute(true);
}

function resetBoards(){
  state.A.cells.fill(Cell.UNKNOWN);
  state.B.cells.fill(Cell.UNKNOWN);
  hideResult();
  state.gameOver = false;
  renderBoards();
  scheduleRecompute(true);
}

function showResult({ title, sub }){
  if (!els.resultModal) return;
  els.resultTitle.textContent = title;
  els.resultSub.textContent = sub || "";
  els.resultModal.classList.add("show");
  els.resultModal.setAttribute("aria-hidden", "false");
}

function hideResult(){
  if (!els.resultModal) return;
  els.resultModal.classList.remove("show");
  els.resultModal.setAttribute("aria-hidden", "true");
}

function getOutcome(sA, sB, n){
  if (n === 0) return { title: t("outcomeTie"), sub: t("outcomeNoBomb") };
  const aDone = sA.bombsFound === n;
  const bDone = sB.bombsFound === n;
  if (aDone && bDone) return { title: t("outcomeTie"), sub: t("outcomeTieBoth") };
  if (aDone) return { title: t("outcomeBWin"), sub: t("outcomeADead") };
  if (bDone) return { title: t("outcomeAWin"), sub: t("outcomeBDead") };
  return null;
}

function renderBoards(){
  renderBoard(state.A, els.boardA, state.a);
  renderBoard(state.B, els.boardB, state.a);
}

function renderBoard(board, container, a){
  container.style.setProperty("grid-template-columns", `repeat(${a}, 1fr)`);
  container.innerHTML = "";

  const frag = document.createDocumentFragment();
  const N = board.cells.length;

  for (let i = 0; i < N; i++){
    const div = document.createElement("div");
    div.className = "cell unknown";
    div.dataset.idx = String(i);
    frag.appendChild(div);
  }
  container.appendChild(frag);

  // Apply initial classes
  syncBoardClasses(board, container);
}

function syncBoardClasses(board, container){
  const nodes = container.children;
  for (let i = 0; i < nodes.length; i++){
    const cell = nodes[i];
    cell.classList.remove("safe", "bomb", "unknown");
    const s = board.cells[i];
    if (s === Cell.SAFE) cell.classList.add("safe");
    else if (s === Cell.BOMB) cell.classList.add("bomb");
    else cell.classList.add("unknown");
  }
}

/**
 * Tap toggles SAFE (unknown <-> safe).
 * Long-press toggles BOMB (unknown <-> bomb).
 * If a cell is SAFE and you long-press => set to BOMB; if BOMB and tap => set to SAFE (simple and intuitive).
 */
function setCellState(board, idx, newState){
  const old = board.cells[idx];
  board.cells[idx] = newState;

  // Update single DOM node class fast
  // (we will also recompute probabilities later)
}

function toggleSafe(board, idx){
  const cur = board.cells[idx];
  if (cur === Cell.SAFE) board.cells[idx] = Cell.UNKNOWN;
  else board.cells[idx] = Cell.SAFE;
}

function toggleBomb(board, idx){
  const cur = board.cells[idx];
  if (cur === Cell.BOMB) board.cells[idx] = Cell.UNKNOWN;
  else board.cells[idx] = Cell.BOMB;
}

function installBoardInteractions(board, container){
  const press = new Map(); // pointerId => { idx, timer, longFired }

  container.addEventListener("contextmenu", (e) => e.preventDefault());

  container.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    const idx = Number(cell.dataset.idx);
    if (!Number.isFinite(idx)) return;

    container.setPointerCapture?.(e.pointerId);

    const info = { idx, longFired: false, timer: null };
    info.timer = setTimeout(() => {
      info.longFired = true;
      toggleBomb(board, idx);
      syncOneCell(board, container, idx);
      haptic("strong");
      scheduleRecompute();
    }, 360); // long press threshold

    press.set(e.pointerId, info);
  });

  container.addEventListener("pointerup", (e) => {
    const info = press.get(e.pointerId);
    if (!info) return;
    clearTimeout(info.timer);

    if (!info.longFired){
      toggleSafe(board, info.idx);
      syncOneCell(board, container, info.idx);
      haptic("light");
      scheduleRecompute();
    }
    press.delete(e.pointerId);
  });

  container.addEventListener("pointercancel", (e) => {
    const info = press.get(e.pointerId);
    if (!info) return;
    clearTimeout(info.timer);
    press.delete(e.pointerId);
  });
}

function syncOneCell(board, container, idx){
  const node = container.children[idx];
  if (!node) return;
  node.classList.remove("safe","bomb","unknown");
  const s = board.cells[idx];
  if (s === Cell.SAFE) node.classList.add("safe");
  else if (s === Cell.BOMB) node.classList.add("bomb");
  else node.classList.add("unknown");
}

function scheduleRecompute(force=false){
  if (force){
    recomputeNow();
    return;
  }
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    recomputeNow();
  });
}

function recomputeNow(){
  const { a, n, N, logFact } = state;

  const sA = countStats(state.A);
  const sB = countStats(state.B);

  // Remaining bombs hidden among remaining cells
  const bA = n - sA.bombsFound;
  const bB = n - sB.bombsFound;

  // Meta display
  els.metaA.textContent = formatMeta(sA, N, n);
  els.metaB.textContent = formatMeta(sB, N, n);

  // Validate logical consistency:
  // bombsFound cannot exceed n; remaining bombs cannot exceed remaining cells; remaining bombs cannot be negative.
  let warn = "";
  if (n > N) warn = t("errNTooLarge");
  else if (sA.bombsFound > n || sB.bombsFound > n) warn = t("errBombsOver");
  else if (bA < 0 || bB < 0) warn = t("errRemainNeg");
  else if (bA > sA.remaining || bB > sB.remaining) warn = t("errRemainTooFew");

  // Note about asynchronous picks (optional)
  const asyncNote = (!warn && sA.picked !== sB.picked) ? t("asyncNote") : "";

  setWarning(warn);
  setAsyncNote(asyncNote);

  // If invalid, don't compute
  if (warn.startsWith("错误")){
    els.pA.textContent = "—";
    els.pB.textContent = "—";
    els.pTie.textContent = "—";
    return;
  }

  const outcome = getOutcome(sA, sB, n);
  if (outcome && !state.gameOver){
    showResult(outcome);
    state.gameOver = true;
  }

  // Special: if n==0 => both already have all bombs at time 0 => tie 1 (under our convention)
  if (n === 0){
    els.pTie.textContent = fmtProb(1);
    els.pA.textContent = fmtProb(0);
    els.pB.textContent = fmtProb(0);
    return;
  }

  const pmfA = completionPmf(N, sA.picked, sA.remaining, bA, logFact);
  const pmfB = completionPmf(N, sB.picked, sB.remaining, bB, logFact);

  const { Awin, Bwin, tie } = compareFromPmfs(pmfA, pmfB);

  els.pA.textContent = fmtProb(Awin);
  els.pB.textContent = fmtProb(Bwin);
  els.pTie.textContent = fmtProb(tie);
}

function boot(){
  // init with current input values
  applyGame();
  applyLanguage();

  // interactions
  installBoardInteractions(state.A, els.boardA);
  installBoardInteractions(state.B, els.boardB);

  const startNewGame = () => {
    applyGame();
    // Need to reinstall because DOM rebuilt
    installBoardInteractions(state.A, els.boardA);
    installBoardInteractions(state.B, els.boardB);
  };

  els.applyBtn.addEventListener("click", startNewGame);

  els.resetBtn.addEventListener("click", () => resetBoards());

  els.closeResultBtn?.addEventListener("click", hideResult);
  els.restartBtn?.addEventListener("click", startNewGame);
  els.resultModal?.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) hideResult();
  });

  els.langSelect?.addEventListener("change", () => {
    state.lang = els.langSelect.value === "en" ? "en" : "zh";
    applyLanguage();
    scheduleRecompute(true);
  });

  // keep n within [0, a^2] when a changes
  els.aInput.addEventListener("input", () => {
    const a = clampInt(els.aInput.value, 1, 100);
    const N = a * a;
    els.nInput.max = String(N);
    const n = clampInt(els.nInput.value, 0, N);
    els.nInput.value = String(n);
  });

  // allow Enter to apply
  els.nInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.applyBtn.click();
  });
  els.aInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.applyBtn.click();
  });
}

boot();
