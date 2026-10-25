// פרומפטר - PWA סטטי. אין שרת, אין חשבונות, אין תלות ב-CDN.
const $ = (id) => document.getElementById(id);
const LS = { script: 'tp.script', pos: 'tp.pos', settings: 'tp.settings' };
const DEF = { speed: 4, font: 34, ph: 40, cd: 3, q: '4k', ts: 0, te: 3, mirror: true };
const QUAL = {
  '4k':   { w: 3840, h: 2160, vbps: 24_000_000 },
  '1080': { w: 1920, h: 1080, vbps: 12_000_000 },
  '720':  { w: 1280, h: 720,  vbps: 6_000_000 },
};
let S = { ...DEF, ...safeJSON(localStorage.getItem(LS.settings)) };
function safeJSON(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() { localStorage.setItem(LS.settings, JSON.stringify(S)); }

const toastEl = $('toast'); let toastT;
function toast(msg, ms = 2600) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => toastEl.hidden = true, ms); }
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };

/* ================= IndexedDB (טייקים שורדים רענון) ================= */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('teleprompter', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('takes', { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}).catch((e) => { console.warn('IDB unavailable', e); return null; });
function idb(mode, fn) {
  if (!db) return Promise.resolve();
  return new Promise((res, rej) => { const tx = db.transaction('takes', mode); const st = tx.objectStore('takes'); const out = fn(st); tx.oncomplete = () => res(out && out.result); tx.onerror = () => rej(tx.error); });
}
const dbAll = () => idb('readonly', (st) => st.getAll());
const dbPut = (t) => idb('readwrite', (st) => st.put(t));
const dbDel = (id) => idb('readwrite', (st) => st.delete(id));
const dbClear = () => idb('readwrite', (st) => st.clear());
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

let takes = ((await dbAll().catch(() => [])) || []).sort((a, b) => a.created - b.created);

/* ================= מסכים ================= */
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'cam') openCam(); else closeCam();
  if (id === 'takes') renderTakes();
  if (id === 'home') updateHome();
}
$('goCam').onclick = () => show('cam');
$('goTakes').onclick = () => show('takes');
$('camTakes').onclick = () => { if (!busyRec()) show('takes'); };
$('camBack').onclick = () => { if (!busyRec()) show('home'); };
$('takesBack').onclick = () => show('home');
$('takesCam').onclick = () => show('cam');

/* ================= תסריט ================= */
const scriptEl = $('script');
scriptEl.value = localStorage.getItem(LS.script) || '';
scriptEl.addEventListener('input', () => { localStorage.setItem(LS.script, scriptEl.value); renderScript(); });
let posFrac = parseFloat(localStorage.getItem(LS.pos)) || 0;
$('resetPos').onclick = () => { setFrac(0); updateHome(); toast('התסריט יתחיל מההתחלה'); };
function updateHome() {
  $('takesBadge').textContent = $('takesBadge2').textContent = takes.length;
  $('posInfo').textContent = posFrac > 0.001 ? `המשך מ-${Math.round(posFrac * 100)}% מהתסריט` : 'מתחיל מההתחלה';
}

/* ================= פרומפטר ================= */
const ptext = $('ptext'), prompter = $('prompter');
let pos = 0; // px
function renderScript() {
  ptext.replaceChildren(...(scriptEl.value || 'הדבק תסריט במסך הראשי.').split(/\n/).map((line) => {
    const p = document.createElement('p'); p.dir = 'auto'; p.textContent = line || '\u00a0'; return p;
  }));
}
const maxPos = () => Math.max(0, ptext.scrollHeight - window.innerHeight * 0.8 - 10);
function applyPos() { pos = Math.min(Math.max(0, pos), maxPos()); ptext.style.transform = `translate3d(0,${-pos}px,0)`; }
function setFrac(f) { posFrac = Math.min(Math.max(0, f), 1); localStorage.setItem(LS.pos, String(posFrac)); }
function storeFrac() { const h = ptext.scrollHeight || 1; setFrac(pos / h); }
function loadFrac() { pos = posFrac * (ptext.scrollHeight || 0); applyPos(); }
function applyStyle() {
  const r = document.documentElement.style;
  r.setProperty('--font', S.font + 'px'); r.setProperty('--ph', S.ph + '%');
  $('preview').classList.toggle('mirror', !!S.mirror); $('mirrorBtn').classList.toggle('on', !!S.mirror);
  $('speedVal').textContent = S.speed;
}
function changeFont(d) { storeFrac(); S.font = Math.min(80, Math.max(18, S.font + d)); saveSettings(); applyStyle(); syncSettingsUI(); requestAnimationFrame(loadFrac); }
function changeSpeed(d) { S.speed = Math.min(20, Math.max(1, +(S.speed + d).toFixed(1))); saveSettings(); applyStyle(); syncSettingsUI(); }
$('fontUp').onclick = () => changeFont(2); $('fontDown').onclick = () => changeFont(-2);
$('speedUp').onclick = () => changeSpeed(0.5); $('speedDown').onclick = () => changeSpeed(-0.5);
$('mirrorBtn').onclick = () => { S.mirror = !S.mirror; saveSettings(); applyStyle(); };

// גרירה להזזת התסריט (כשלא מקליטים), הקשה = השהיה/המשך בזמן הקלטה
let drag = null;
prompter.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, p: pos, moved: false }; prompter.setPointerCapture(e.pointerId); });
prompter.addEventListener('pointermove', (e) => {
  if (!drag) return; const dy = e.clientY - drag.y; if (Math.abs(dy) > 6) drag.moved = true;
  if (drag.moved) { pos = drag.p - dy; applyPos(); }
});
prompter.addEventListener('pointerup', () => {
  if (!drag) return; const moved = drag.moved; drag = null;
  if (moved) { storeFrac(); return; }
  if (state === 'rec') { paused = !paused; $('pausedTag').hidden = !paused; }
});

// לולאת גלילה
let state = 'idle'; // idle | count | rec | review
let paused = false, lastT = 0, scrolling = false, hist = [];
function loop(t) {
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0; lastT = t;
  if (scrolling && !paused && !drag) { pos += S.speed * S.font * 0.11 * dt; applyPos(); }
  if (state === 'rec') {
    hist.push([t, pos]); if (hist.length > 20000) hist.splice(0, 5000);
    $('recInfo').textContent = '● ' + fmt((t - recStartT) / 1000);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ================= מצלמה ================= */
let stream = null, wakeLock = null, mime = '';
function pickMime() {
  const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4',
             'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (!window.MediaRecorder) return '';
  return c.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}
async function getStream() {
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
  const q = QUAL[S.q] || QUAL['4k'];
  const tries = [
    { w: q.w, h: q.h }, { w: 1920, h: 1080 }, null,
  ];
  let lastErr;
  for (const t of tries) {
    const video = t ? { facingMode: 'user', width: { ideal: t.w }, height: { ideal: t.h }, frameRate: { ideal: 30 } } : { facingMode: 'user' };
    try { return await navigator.mediaDevices.getUserMedia({ video, audio }); }
    catch (e) { lastErr = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
  }
  // ניסיון אחרון: עם עיבוד אודיו ברירת מחדל
  try { return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true }); } catch {}
  throw lastErr;
}
async function openCam() {
  renderScript(); applyStyle(); requestAnimationFrame(loadFrac);
  $('takesBadge2').textContent = takes.length;
  if (stream && stream.getVideoTracks()[0]?.readyState === 'live') return;
  if (!navigator.mediaDevices?.getUserMedia) { toast('הדפדפן לא מאפשר גישה למצלמה. צריך HTTPS וספארי עדכני.', 6000); return; }
  try {
    stream = await getStream();
    if (!$('cam').classList.contains('active')) { stopStream(); return; }
    $('preview').srcObject = stream; await $('preview').play().catch(() => {});
    mime = pickMime();
    const st = stream.getVideoTracks()[0].getSettings();
    $('recInfo').textContent = `${st.width}×${st.height} · ${Math.round(st.frameRate || 30)}fps`;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (e) {
    console.warn(e);
    toast(e.name === 'NotAllowedError' ? 'אין הרשאה למצלמה. אפשר בהגדרות ספארי > מצלמה ומיקרופון.' : 'לא הצלחתי לפתוח מצלמה: ' + e.name, 6000);
  }
}
function stopStream() { stream?.getTracks().forEach((t) => t.stop()); stream = null; $('preview').srcObject = null; }
function closeCam() {
  if (state === 'rec') stopRec(); cancelCount();
  stopStream(); try { wakeLock?.release(); } catch {} wakeLock = null; $('settings').hidden = true;
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { if (state === 'rec') stopRec(); }
  else if ($('cam').classList.contains('active')) {
    if (!stream || stream.getVideoTracks()[0]?.readyState !== 'live') { stopStream(); openCam(); }
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

/* ================= הקלטה ================= */
let recorder = null, chunks = [], recStartT = 0, takeStartPos = 0, countT = null, pending = null;
const busyRec = () => state === 'rec' || state === 'count';
$('recBtn').onclick = () => {
  if (state === 'idle') startCount();
  else if (state === 'count') cancelCount();
  else if (state === 'rec') stopRec();
};
function startCount() {
  if (!stream) { openCam(); return; }
  if (!mime) { toast('הדפדפן לא תומך בהקלטת וידאו (MediaRecorder).', 5000); return; }
  $('settings').hidden = true;
  let n = +S.cd; state = 'count'; $('recBtn').className = 'counting';
  const cdEl = $('countdown');
  const tick = () => {
    if (n <= 0) { cdEl.hidden = true; startRec(); return; }
    cdEl.textContent = n; cdEl.hidden = false; n--; countT = setTimeout(tick, 1000);
  };
  tick();
}
function cancelCount() { if (state !== 'count') return; clearTimeout(countT); $('countdown').hidden = true; state = 'idle'; $('recBtn').className = ''; }
function startRec() {
  chunks = []; hist = []; paused = false; $('pausedTag').hidden = true;
  const q = QUAL[S.q] || QUAL['4k'];
  const st = stream.getVideoTracks()[0].getSettings();
  const px = (st.width || 1920) * (st.height || 1080);
  const vbps = px >= 3840 * 2160 * 0.9 ? QUAL['4k'].vbps : px >= 1920 * 1080 * 0.9 ? Math.min(q.vbps, QUAL['1080'].vbps) : QUAL['720'].vbps;
  try { recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 192_000 }); }
  catch { recorder = new MediaRecorder(stream, { mimeType: mime }); }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecStop;
  recorder.start(1000);
  recStartT = performance.now(); takeStartPos = pos;
  state = 'rec'; scrolling = true; $('recBtn').className = 'recording'; $('recInfo').classList.add('rec');
  pending = { w: st.width, h: st.height, vbps };
}
function stopRec() {
  if (state !== 'rec') return;
  const stopT = performance.now();
  scrolling = false; paused = false; $('pausedTag').hidden = true; state = 'review';
  $('recBtn').className = ''; $('recInfo').classList.remove('rec');
  // התסריט חוזר אחורה בזמן ההליכה לטלפון (חיתוך הסוף)
  const target = stopT - S.te * 1000;
  let back = takeStartPos; for (const [t, p] of hist) { if (t <= target) back = p; else break; }
  pending.stopPos = pos; pending.resumePos = back; pending.dur = (stopT - recStartT) / 1000;
  try { recorder.requestData?.(); } catch {}
  recorder.stop();
}
function onRecStop() {
  const type = (recorder.mimeType || mime).split(';')[0] || 'video/mp4';
  const blob = new Blob(chunks, { type }); chunks = [];
  pending.blob = blob; pending.type = type;
  const v = $('reviewVideo'); v.src = URL.createObjectURL(blob);
  $('review').hidden = false;
  v.play().catch(() => {});
}
$('keepBtn').onclick = async () => {
  const p = pending; if (!p) return;
  const take = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), created: Date.now(), blob: p.blob, type: p.type,
    dur: p.dur, w: p.w, h: p.h, ts: +S.ts, te: Math.min(+S.te, Math.max(0, p.dur - 1)) };
  const v = $('reviewVideo'); if (isFinite(v.duration) && v.duration > 0) take.dur = v.duration;
  takes.push(take);
  try { await dbPut(take); } catch (e) { console.warn(e); toast('אזהרה: הטייק לא נשמר לזיכרון הקבוע. שמור אותו לתמונות לפני סגירה.', 5000); }
  pos = p.resumePos; applyPos(); storeFrac();
  closeReview(); toast(`טייק ${takes.length} נשמר ✓`, 1500);
};
$('retakeBtn').onclick = () => { pos = takeStartPos; applyPos(); storeFrac(); closeReview(); toast('נמחק. מצלמים שוב מאותה נקודה', 1500); };
function closeReview() {
  const v = $('reviewVideo'); v.pause(); URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load();
  $('review').hidden = true; pending = null; state = 'idle';
  $('takesBadge2').textContent = takes.length;
  const st = stream?.getVideoTracks()[0]?.getSettings(); if (st) $('recInfo').textContent = `${st.width}×${st.height}`;
}

// שלט / מקלדת Bluetooth
document.addEventListener('keydown', (e) => {
  if (!$('cam').classList.contains('active') || e.target.matches('input,textarea,select')) return;
  if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (state !== 'review') $('recBtn').click(); else $('keepBtn').click(); }
  else if (e.code === 'ArrowUp' || e.code === 'ArrowRight') changeSpeed(0.5);
  else if (e.code === 'ArrowDown' || e.code === 'ArrowLeft') changeSpeed(-0.5);
  else if (e.key === 'p' || e.key === 'פ') { if (state === 'rec') { paused = !paused; $('pausedTag').hidden = !paused; } }
  else if (e.key === 'Backspace' && state === 'review') $('retakeBtn').click();
});

/* ================= הגדרות ================= */
function syncSettingsUI() {
  $('s_speed').value = S.speed; $('o_speed').textContent = S.speed;
  $('s_font').value = S.font; $('o_font').textContent = S.font;
  $('s_ph').value = S.ph; $('o_ph').textContent = S.ph + '%';
  $('s_cd').value = S.cd; $('s_q').value = S.q; $('s_ts').value = S.ts; $('s_te').value = S.te;
}
$('gearBtn').onclick = () => { if (busyRec()) return; syncSettingsUI(); $('settings').hidden = !$('settings').hidden; };
$('closeSettings').onclick = () => $('settings').hidden = true;
$('s_speed').oninput = (e) => { S.speed = +e.target.value; saveSettings(); applyStyle(); syncSettingsUI(); };
$('s_font').oninput = (e) => { storeFrac(); S.font = +e.target.value; saveSettings(); applyStyle(); syncSettingsUI(); requestAnimationFrame(loadFrac); };
$('s_ph').oninput = (e) => { S.ph = +e.target.value; saveSettings(); applyStyle(); syncSettingsUI(); };
$('s_cd').onchange = (e) => { S.cd = +e.target.value; saveSettings(); };
$('s_ts').onchange = (e) => { S.ts = Math.max(0, +e.target.value || 0); saveSettings(); };
$('s_te').onchange = (e) => { S.te = Math.max(0, +e.target.value || 0); saveSettings(); };
$('s_q').onchange = (e) => { S.q = e.target.value; saveSettings(); stopStream(); openCam(); };

/* ================= טייקים: רשימה, חיתוך, ייצוא ================= */
const urls = new Map();
const urlFor = (t) => { if (!urls.has(t.id)) urls.set(t.id, URL.createObjectURL(t.blob)); return urls.get(t.id); };
const ext = (type) => (type.includes('webm') ? 'webm' : 'mp4');
const keepDur = (t) => Math.max(0.1, t.dur - t.ts - t.te);
const needsTrim = (t) => t.ts > 0.05 || t.te > 0.05;

function renderTakes() {
  const list = $('takeList'); list.replaceChildren();
  $('noTakes').hidden = takes.length > 0; $('bulk').hidden = takes.length === 0;
  takes.forEach((t, i) => {
    const el = document.createElement('div'); el.className = 'take';
    el.innerHTML = `
      <div class="meta"><b>טייק ${i + 1}</b><span class="d"></span></div>
      <video playsinline controls preload="metadata"></video>
      <div class="trim">
        <label>חיתוך בהתחלה (שנ׳)<div class="stepper"><button data-k="ts" data-d="-0.5">−</button><input type="number" step="0.1" min="0" data-f="ts"><button data-k="ts" data-d="0.5">+</button></div></label>
        <label>חיתוך בסוף (שנ׳)<div class="stepper"><button data-k="te" data-d="-0.5">−</button><input type="number" step="0.1" min="0" data-f="te"><button data-k="te" data-d="0.5">+</button></div></label>
      </div>
      <div class="acts">
        <button class="btn" data-a="play">▶ תצוגה חתוכה</button>
        <button class="btn primary" data-a="save">שמור</button>
        <button class="btn danger" data-a="del">מחק</button>
      </div>`;
    const v = el.querySelector('video'); v.src = urlFor(t);
    v.onloadedmetadata = () => { if (isFinite(v.duration) && v.duration > 0 && Math.abs(v.duration - t.dur) > 0.2) { t.dur = v.duration; dbPut(t).catch(() => {}); upd(); } };
    const inTs = el.querySelector('[data-f=ts]'), inTe = el.querySelector('[data-f=te]');
    const upd = () => {
      inTs.value = t.ts.toFixed(1); inTe.value = t.te.toFixed(1);
      el.querySelector('.d').textContent = `${fmt(t.dur)} ← ${fmt(keepDur(t))} · ${t.w || '?'}×${t.h || '?'}`;
    };
    const setTrim = (k, val) => {
      val = Math.max(0, +val || 0);
      const other = k === 'ts' ? t.te : t.ts; val = Math.min(val, Math.max(0, t.dur - other - 0.5));
      t[k] = Math.round(val * 10) / 10; dbPut(t).catch(() => {}); upd();
      v.currentTime = k === 'ts' ? t.ts : Math.max(0, t.dur - t.te);
    };
    el.querySelectorAll('.stepper button').forEach((b) => b.onclick = () => setTrim(b.dataset.k, t[b.dataset.k] + +b.dataset.d));
    inTs.onchange = () => setTrim('ts', inTs.value); inTe.onchange = () => setTrim('te', inTe.value);
    let stopAt = null;
    v.ontimeupdate = () => { if (stopAt != null && v.currentTime >= stopAt) { v.pause(); stopAt = null; } };
    el.querySelector('[data-a=play]').onclick = () => { v.currentTime = t.ts; stopAt = t.dur - t.te; v.play(); };
    el.querySelector('[data-a=save]').onclick = () => exportTakes([t], false, `take-${i + 1}`);
    el.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`למחוק את טייק ${i + 1}?`)) return;
      takes = takes.filter((x) => x !== t); URL.revokeObjectURL(urls.get(t.id)); urls.delete(t.id);
      await dbDel(t.id).catch(() => {}); renderTakes(); updateHome();
    };
    upd(); list.appendChild(el);
  });
}
$('saveAll').onclick = () => exportTakes(takes, false, 'take');
$('joinAll').onclick = () => exportTakes(takes, true, 'video');
$('clearAll').onclick = async () => {
  if (!confirm('למחוק את כל הטייקים ולהתחיל סשן חדש? (קבצים שכבר נשמרו לתמונות לא יימחקו)')) return;
  urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); takes = []; await dbClear().catch(() => {});
  setFrac(0); renderTakes(); updateHome(); toast('סשן חדש. התסריט יתחיל מההתחלה');
};

// --- שמירה: Web Share (שמור סרטון לתמונות) או הורדה ---
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
async function saveFiles(files) {
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files }); return true; }
  } catch (e) { if (e.name === 'AbortError') return false; console.warn('share failed', e); }
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    await new Promise((r) => setTimeout(r, 400));
  }
  return true;
}

// --- ffmpeg.wasm (מקומי, נטען רק כשצריך לחתוך) ---
let ff = null;
async function getFF(onMsg) {
  if (ff) return ff;
  onMsg('טוען מנוע חיתוך (פעם ראשונה בלבד, כ-32MB)...');
  const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
  const inst = new FFmpeg();
  const base = new URL('./vendor/ffmpeg/', location.href).href;
  await inst.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
  inst.on('progress', ({ progress }) => { if (progress >= 0 && progress <= 1) proc.bar.value = progress; });
  ff = inst; return ff;
}
async function ffRun(args) { const code = await ff.exec(args); if (code !== 0) throw new Error('ffmpeg exit ' + code); }

const proc = { el: $('proc'), title: $('procTitle'), bar: $('procBar'), msg: $('procMsg'), save: $('procSave'), close: $('procClose') };
proc.close.onclick = () => { proc.el.hidden = true; proc.save.hidden = true; proc.save.onclick = null; };
function procOpen(title) { proc.title.textContent = title; proc.bar.removeAttribute('value'); proc.msg.textContent = ''; proc.save.hidden = true; proc.el.hidden = false; }

async function exportTakes(list, join, base) {
  if (!list.length) return;
  const s = stamp();
  // בלי חיתוך ובלי חיבור: שומרים את הקובץ המקורי מייד (בלי עיבוד, איכות מקורית)
  if (!join && !list.some(needsTrim)) {
    const files = list.map((t, i) => new File([t.blob], `${base}${list.length > 1 ? '-' + (i + 1) : ''}-${s}.${ext(t.type)}`, { type: t.type }));
    await saveFiles(files); return;
  }
  if (join && new Set(list.map((t) => `${t.w}x${t.h}|${t.type}`)).size > 1) {
    if (!confirm('הטייקים צולמו ברזולוציות שונות, וחיבור בלי קידוד מחדש עלול להיכשל. להמשיך?')) return;
  }
  procOpen(join ? 'מחבר את הטייקים...' : 'חותך טייקים...');
  const out = [];
  try {
    await getFF((m) => proc.msg.textContent = m);
    const e = ext(list[0].type);
    const blobs = list.map((t, i) => ({ name: `t${i}.${ext(t.type)}`, data: t.blob }));
    await ff.createDir('/in').catch(() => {});
    let mounted = false;
    try { await ff.mount('WORKERFS', { blobs }, '/in'); mounted = true; } catch (err) { console.warn('WORKERFS failed, copying', err); }
    if (!mounted) for (const b of blobs) await ff.writeFile(`/in/${b.name}`, new Uint8Array(await b.data.arrayBuffer()));
    try {
      if (join) {
        proc.msg.textContent = 'מחבר בלי קידוד מחדש...';
        const txt = list.map((t, i) => `file '/in/${blobs[i].name}'\n` + (t.ts > 0.05 ? `inpoint ${t.ts.toFixed(3)}\n` : '') + (t.te > 0.05 ? `outpoint ${(t.dur - t.te).toFixed(3)}\n` : '')).join('');
        await ff.writeFile('list.txt', new TextEncoder().encode(txt));
        await ffRun(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', `out.${e}`]);
        const data = await ff.readFile(`out.${e}`); await ff.deleteFile(`out.${e}`);
        out.push(new File([data], `${base}-${s}.${e}`, { type: list[0].type }));
      } else {
        for (let i = 0; i < list.length; i++) {
          const t = list[i], te = ext(t.type), name = `${base}${list.length > 1 ? '-' + (i + 1) : ''}-${s}.${te}`;
          proc.msg.textContent = `טייק ${i + 1} מתוך ${list.length}`;
          if (!needsTrim(t)) { out.push(new File([t.blob], name, { type: t.type })); continue; }
          const args = [];
          if (t.ts > 0.05) args.push('-ss', t.ts.toFixed(3));
          args.push('-i', `/in/${blobs[i].name}`, '-t', keepDur(t).toFixed(3), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', `o.${te}`);
          await ffRun(args);
          const data = await ff.readFile(`o.${te}`); await ff.deleteFile(`o.${te}`);
          out.push(new File([data], name, { type: t.type }));
        }
      }
    } finally {
      if (mounted) await ff.unmount('/in').catch(() => {});
      else for (const b of blobs) await ff.deleteFile(`/in/${b.name}`).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    proc.title.textContent = 'העיבוד נכשל';
    proc.msg.textContent = 'כנראה שהזיכרון בטלפון לא הספיק (קבצי 4K גדולים). אפשר לשמור כל טייק בנפרד, או לצלם ב-1080p. פרטים: ' + (err.message || err);
    try { ff?.terminate(); } catch {} ff = null; return;
  }
  proc.bar.value = 1; proc.title.textContent = 'מוכן ✓';
  const mb = out.reduce((a, f) => a + f.size, 0) / 1e6;
  proc.msg.textContent = `${out.length} קבצים · ${mb.toFixed(0)}MB. לחץ "שמור לתמונות" ובחר "שמור סרטון".`;
  proc.save.hidden = false;
  proc.save.onclick = async () => { if (await saveFiles(out)) { proc.el.hidden = true; toast('נשמר ✓'); } };
}

/* ================= אתחול ================= */
renderScript(); applyStyle(); updateHome();
const env = [];
if (!window.isSecureContext) env.push('⚠️ המצלמה עובדת רק בכתובת HTTPS.');
if (!window.MediaRecorder) env.push('⚠️ הדפדפן לא תומך בהקלטה.');
else env.push('פורמט הקלטה: ' + (pickMime() || 'לא נתמך'));
$('envInfo').textContent = env.join(' ');
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
window.__tp = { takes: () => takes, state: () => state }; // לבדיקות
