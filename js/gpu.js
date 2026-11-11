// Calcul sur la carte graphique (WebGPU natif du navigateur, sans Three.js ni bibliothèque), 08/11/2026.
// Accélère les deux calculs lourds de Confort et Chaleur sur la grille des hauteurs de Soleil (app.soleil.grilleHauteurs,
// 1 px = 1 m, hauteurs du bâti effectif et des couronnes d'arbres) :
//   - ouverture au ciel (facteur de vue du ciel) : une invocation par point × direction (horizon le long de la direction),
//     puis une invocation par point pour la moyenne (1 − moyenne de sin² de l'angle d'horizon) ;
//   - masques d'ombre : une invocation par point × position du soleil (marche le long du rayon vers le soleil).
// Mêmes règles que le calcul sur le processeur (CPU), qui reste le calcul de secours (Safari / iPhone, borne, PC sans WebGPU,
// pilote désactivé, perte du périphérique, erreur) : svfCPU et masquesCPU ci-dessous reproduisent les boucles de
// js/chaleur-modele.js et js/confort.js (mêmes pas, mêmes arrêts) et servent au diagnostic « Tester WebGPU ».
// Écarts possibles : calcul en flottants 32 bits sur la carte (64 bits en JavaScript) → un échantillon peut tomber dans la
// maille voisine quand un point de la marche touche exactement une limite de maille (quelques millièmes sur l'ouverture au ciel,
// quelques pour mille de masques différents).
// Réglage « Calcul sur la carte graphique (WebGPU) » : localStorage atlas-hdv-webgpu ('1' oui, '0' non, absent = automatique :
// oui si une vraie carte est détectée ET plus rapide que le processeur à l'auto-test, transferts compris ; non pour un adaptateur
// logiciel de secours, plus lent que le JavaScript).

const CLE_LS = 'atlas-hdv-webgpu';
const lireReglage = () => { try { return localStorage.getItem(CLE_LS); } catch { return null; } };
const ecrireReglage = (v) => { try { if (v == null) localStorage.removeItem(CLE_LS); else localStorage.setItem(CLE_LS, v); } catch { /* stockage indisponible */ } };

const etat = {
  detection: null, // promesse de detecter()
  rapport: null, // { disponible, raison, adaptateur, fallback, limites }
  adapter: null, device: null, pipelines: null,
  perdu: null, // message de perte du périphérique
  derniereErreur: null,
  dernierCalcul: null, // { nom, mode: 'gpu'|'cpu', duree }
  ecouteurs: new Set(),
};
const notifier = () => etat.ecouteurs.forEach((f) => { try { f(); } catch (e) { console.warn(e); } });
export const surChangement = (f) => { etat.ecouteurs.add(f); return () => etat.ecouteurs.delete(f); };

// ------------------------------------------------------------------
// Détection
// ------------------------------------------------------------------
export function detecter({ forcer = false } = {}) {
  if (etat.detection && !forcer) return etat.detection;
  etat.detection = (async () => {
    const R = { disponible: false, raison: '', adaptateur: null, fallback: false, limites: null };
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        R.raison = typeof window !== 'undefined' && window.isSecureContext === false
          ? 'WebGPU exige une page sûre (http://localhost ou https) : lancer l\'atlas par serveur.py.'
          : 'WebGPU absent de ce navigateur (Chrome ou Edge récents sous Windows : activé par défaut).';
        return R;
      }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) { R.raison = 'Aucun adaptateur WebGPU (pilote graphique bloqué ou trop ancien, ou WebGPU désactivé dans chrome://flags).'; return R; }
      const i = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo().catch(() => ({})) : {});
      R.fallback = !!(adapter.isFallbackAdapter ?? i.isFallbackAdapter);
      R.adaptateur = { fabricant: i.vendor || '', architecture: i.architecture || '', peripherique: i.device || '', description: i.description || '' };
      const L = adapter.limits;
      const lim = (k) => (L && L[k] != null ? Number(L[k]) : null);
      R.limites = {
        maxStorageBufferBindingSize: lim('maxStorageBufferBindingSize'), maxBufferSize: lim('maxBufferSize'),
        maxComputeWorkgroupsPerDimension: lim('maxComputeWorkgroupsPerDimension'), maxComputeInvocationsPerWorkgroup: lim('maxComputeInvocationsPerWorkgroup'),
      };
      // limites demandées : celles de l'adaptateur (bornées), pour les grandes grilles
      const requiredLimits = {};
      if (R.limites.maxStorageBufferBindingSize) requiredLimits.maxStorageBufferBindingSize = Math.min(R.limites.maxStorageBufferBindingSize, 1 << 30);
      if (R.limites.maxBufferSize) requiredLimits.maxBufferSize = Math.min(R.limites.maxBufferSize, 1 << 30);
      let device;
      try { device = await adapter.requestDevice({ requiredLimits }); } catch { device = await adapter.requestDevice(); }
      etat.adapter = adapter; etat.device = device; etat.pipelines = null; etat.perdu = null;
      device.lost.then((info) => {
        if (etat.device !== device) return;
        etat.device = null; etat.pipelines = null;
        etat.perdu = `périphérique WebGPU perdu (${info?.reason || 'inconnu'}${info?.message ? ` : ${info.message}` : ''}) : calcul sur le processeur`;
        if (etat.rapport) { etat.rapport.disponible = false; etat.rapport.raison = etat.perdu; }
        console.warn('WebGPU :', etat.perdu);
        notifier();
      });
      device.onuncapturederror = (ev) => { etat.derniereErreur = ev.error?.message || String(ev.error); console.warn('WebGPU :', etat.derniereErreur); };
      R.disponible = true;
      R.raison = R.fallback ? 'adaptateur logiciel de secours (pas de carte graphique utilisable) : plus lent que le calcul sur le processeur' : '';
    } catch (e) {
      R.raison = `WebGPU indisponible : ${e.message || e}`;
    } finally {
      etat.rapport = R;
      notifier();
    }
    return R;
  })();
  return etat.detection;
}

// Rapport de détection (null tant que detecter() n'a pas répondu)
export function info() {
  const R = etat.rapport;
  if (!R) return null;
  const a = R.adaptateur;
  const nom = a ? [a.description, a.fabricant, a.architecture, a.peripherique].filter(Boolean).join(' · ') || 'adaptateur sans nom (le navigateur masque son nom)' : '';
  return { ...R, nom, perdu: etat.perdu, derniereErreur: etat.derniereErreur, dernierCalcul: etat.dernierCalcul, reglage: lireReglage() };
}

// Réglage : true / false, ou null = automatique
export function reglage() { const v = lireReglage(); return v === '1' ? true : v === '0' ? false : null; }
export function definirReglage(v) { ecrireReglage(v == null ? null : v ? '1' : '0'); notifier(); }

// Le calcul passe-t-il par la carte ? (réglage + disponibilité ; automatique : pas d'adaptateur logiciel, et la carte doit
// gagner l'auto-test unique ci-dessous, transferts compris)
export async function actif() {
  const r = reglage();
  if (r === false) return false;
  const R = await detecter();
  if (!R.disponible || !etat.device) return false;
  if (r === true) return true;
  if (R.fallback) return false;
  const b = await bancAuto();
  return b?.choix === 'gpu';
}
// version synchrone (case du panneau), d'après la dernière détection et le dernier auto-test connu
export function actifConnu() {
  const R = etat.rapport, r = reglage();
  if (r === false || !R?.disponible || !etat.device) return false;
  if (r === true) return true;
  if (R.fallback) return false;
  return bancConnu()?.choix === 'gpu';
}

// ------------------------------------------------------------------
// Auto-test (08/11/2026) : en réglage automatique, la carte n'est choisie que si elle est plus rapide que le processeur
// TRANSFERTS COMPRIS (une puce intégrée peut calculer aussi vite mais perdre 100 ms en envois et lectures). Une seule fois par
// adaptateur et par version du navigateur, sur une zone d'essai fixe de la taille du cercle de Confort (r 105 m, mailles de 2 m,
// 36 directions jusqu'à 160 m, 30 positions du soleil) ; résultat gardé dans localStorage atlas-hdv-webgpu-bench :
// { v, signature, cpu: { svf, ombres, total }, gpu: { svf, ombres, total (avec transfert), calcul (hors transfert) }, choix, date }.
// En cas d'erreur sur la carte : processeur. « Tester WebGPU » (diagnostic) ne change pas ce choix ; la case le force.
// ------------------------------------------------------------------
const CLE_BENCH = 'atlas-hdv-webgpu-bench', VERSION_BENCH = 1;
const signatureAdaptateur = () => {
  const a = etat.rapport?.adaptateur || {};
  const ua = typeof navigator !== 'undefined' ? (/(Chrome|Edg|Firefox|Version)\/(\d+)/.exec(navigator.userAgent) || []).slice(1).join(' ') : '';
  return [a.fabricant, a.architecture, a.peripherique, a.description, ua].join('|');
};
function bancConnu() {
  if (etat.bench) return etat.bench;
  try {
    const b = JSON.parse(localStorage.getItem(CLE_BENCH) || 'null');
    if (b && b.v === VERSION_BENCH && b.signature === signatureAdaptateur()) { etat.bench = b; return b; }
  } catch { /* stockage indisponible ou illisible : test refait */ }
  return null;
}
export const resultatBanc = () => bancConnu();
function texteBanc() {
  const b = bancConnu();
  if (!b) return '';
  if (b.erreur) return `erreur sur la carte (${b.erreur}) → processeur`;
  const m = (v) => `${Math.round(v)} ms`;
  return `processeur ${m(b.cpu.total)} (ouverture au ciel ${m(b.cpu.svf)}, ombres ${m(b.cpu.ombres)}) ; carte ${m(b.gpu.total)} avec transfert, ${m(b.gpu.calcul)} hors transfert → ${b.choix === 'gpu' ? 'carte graphique' : 'processeur'}`;
}
function bancAuto() {
  const b = bancConnu();
  if (b) return Promise.resolve(b);
  etat.banc ??= banc().catch((e) => ({ choix: 'cpu', erreur: e.message || String(e) })).then((r) => { etat.bench = r; notifier(); return r; });
  return etat.banc;
}
// auto-test refait à la demande (console : (await import('/js/gpu.js')).refaireBanc())
export async function refaireBanc() {
  try { localStorage.removeItem(CLE_BENCH); } catch { /* stockage indisponible */ }
  etat.bench = null; etat.banc = null;
  await detecter();
  return etat.device ? bancAuto() : null;
}
// zone d'essai déterministe : îlots de 6 à 24 m de haut sur 650 × 650 m, points ouverts du cercle de 105 m à 1,20 m
function zoneEssai() {
  const w = 650, h = 650, H = new Float32Array(w * h);
  let graine = 12345;
  const alea = () => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine / 0x7fffffff; };
  for (let I = 0; I < w; I += 26) for (let J = 0; J < h; J += 26) {
    const hb = 6 + 18 * alea();
    for (let j = J + 4; j < Math.min(h, J + 4 + 10 + 10 * alea()); j++) for (let i = I + 4; i < Math.min(w, I + 22); i++) H[j * w + i] = hb;
  }
  const g = { x0: -325, z0: -325, w, h, H };
  const X = [], Z = [];
  for (let z = -104; z <= 104; z += 2) for (let x = -104; x <= 104; x += 2) {
    if (x * x + z * z > 105 * 105 || H[Math.floor(z + 325) * w + Math.floor(x + 325)] > 0.5) continue;
    X.push(x + 1); Z.push(z + 1);
  }
  const pts = { n: X.length, x: Float32Array.from(X), z: Float32Array.from(Z), y0: new Float32Array(X.length).fill(1.2) };
  const soleils = Array.from({ length: 30 }, (_, k) => {
    const az = ((60 + (240 * k) / 29) * Math.PI) / 180, alt = ((3 + 62 * Math.sin((Math.PI * k) / 29)) * Math.PI) / 180;
    return { sx: Math.sin(az), sz: -Math.cos(az), tanAlt: Math.tan(alt) };
  });
  return { g, pts, soleils };
}
async function banc() {
  const { g, pts, soleils } = zoneEssai();
  const svf = { N: 36, pas: 2, dMax: 160 }, ombre = { d0: 1.5, pas: 1.5, dLim: 450 };
  let t = maintenant();
  await svfCPU(g, pts, { ...svf, sansPause: true });
  const cSvf = maintenant() - t; t = maintenant();
  await masquesCPU(g, pts, soleils, { ...ombre, sansPause: true });
  const cOmb = maintenant() - t;
  // compilation des noyaux sur une copie de la grille : l'envoi de la grille reste compté dans la mesure, comme en usage réel
  const g0 = { ...g }, sous = { n: 256, x: pts.x, z: pts.z, y0: pts.y0 };
  const sS = {}, sM = {};
  try {
    await svfGPU(g0, sous, svf); await masquesGPU(g0, sous, soleils.slice(0, 2), ombre);
    await svfGPU(g, pts, { ...svf, stats: sS });
    await masquesGPU(g, pts, soleils, { ...ombre, stats: sM });
  } finally { for (const x of [g0, g]) { grillesGPU.get(x)?.buffer.destroy(); grillesGPU.delete(x); } }
  const r = {
    v: VERSION_BENCH, signature: signatureAdaptateur(), points: pts.n, soleils: soleils.length,
    cpu: { svf: cSvf, ombres: cOmb, total: cSvf + cOmb },
    gpu: { svf: sS.total, ombres: sM.total, total: sS.total + sM.total, calcul: (sS.calcul || 0) + (sM.calcul || 0) },
    date: new Date().toISOString(),
  };
  r.choix = Number.isFinite(r.gpu.total) && r.gpu.total < r.cpu.total && r.gpu.calcul < r.cpu.total ? 'gpu' : 'cpu';
  try { localStorage.setItem(CLE_BENCH, JSON.stringify(r)); } catch { /* stockage indisponible : test refait à la prochaine session */ }
  console.info(`WebGPU, auto-test : processeur ${Math.round(r.cpu.total)} ms, carte ${Math.round(r.gpu.total)} ms avec transfert (${Math.round(r.gpu.calcul)} ms hors transfert) → ${r.choix === 'gpu' ? 'carte graphique' : 'processeur'}`);
  return r;
}

// ------------------------------------------------------------------
// Noyaux WGSL
// ------------------------------------------------------------------
// Paramètres (uniform, 16 × 4 octets) :
//  0 x0 f32, 1 z0 f32, 2 w u32, 3 h u32, 4 hm f32 (hauteur max de la grille), 5 n u32 (points du lot), 6 nb u32 (directions ou soleils),
//  7 decal u32 (premier point du lot), 8 pas f32, 9 d0 f32, 10 dLim f32, 11 plafond f32, 12 lignes u32 (invocations par ligne de dispatch),
//  13 decalS u32 (premier soleil du lot), 14-15 libres
const WGSL = /* wgsl */`
struct Params {
  x0: f32, z0: f32, w: u32, h: u32,
  hm: f32, n: u32, nb: u32, decal: u32,
  pas: f32, d0: f32, dLim: f32, plafond: f32,
  ligne: u32, decalS: u32, l0: u32, l1: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> H: array<f32>;
@group(0) @binding(2) var<storage, read> pts: array<vec4<f32>>;   // x, z, y0, 0
@group(0) @binding(3) var<storage, read> dirs: array<vec4<f32>>;  // horizon : sx, sz ; soleil : sx, sz, tan(hauteur)
@group(0) @binding(4) var<storage, read_write> sortie: array<f32>;
@group(0) @binding(5) var<storage, read_write> res: array<f32>;

// même règle que soleil.js hauteurEn : maille de 1 m, 0 hors de la grille
fn hauteur(x: f32, z: f32) -> f32 {
  let fi = floor(x - P.x0);
  let fj = floor(z - P.z0);
  if (fi < 0.0 || fj < 0.0 || fi >= f32(P.w) || fj >= f32(P.h)) { return 0.0; }
  return H[u32(fj) * P.w + u32(fi)];
}

// horizon d'un point dans une direction : max de (h - y0) / d pour d = pas, 2 pas… <= dLim ; sortie = sin²(atan t) = t² / (1 + t²)
@compute @workgroup_size(64)
fn horizon(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * P.ligne;
  if (idx >= P.n * P.nb) { return; }
  let i = idx / P.nb;
  let q = idx % P.nb;
  let p = pts[P.decal + i];
  let dir = dirs[q];
  var t = 0.0;
  var k = 1u;
  loop {
    let d = f32(k) * P.pas;
    if (d > P.dLim) { break; }
    if ((P.hm - p.z) / d <= t) { break; } // plus rien ne peut dépasser l'horizon trouvé
    let v = (hauteur(p.x + dir.x * d, p.y + dir.y * d) - p.z) / d;
    if (v > t) { t = v; }
    k = k + 1u;
  }
  sortie[idx] = t * t / (1.0 + t * t);
}

// ouverture au ciel d'un point : 1 - moyenne sur les directions
@compute @workgroup_size(64)
fn moyenne(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x + gid.y * P.ligne;
  if (i >= P.n) { return; }
  var s = 0.0;
  for (var q = 0u; q < P.nb; q = q + 1u) { s = s + sortie[i * P.nb + q]; }
  res[i] = 1.0 - s / f32(P.nb);
}

// masque d'ombre : 1 au soleil, 0 à l'ombre ; marche d = d0, d0 + pas… < dLim ; arrêt dès que le rayon dépasse le plafond
@compute @workgroup_size(64)
fn masque(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * P.ligne;
  if (idx >= P.n * P.nb) { return; }
  let s = idx / P.n;
  let i = idx % P.n;
  let p = pts[P.decal + i];
  let sol = dirs[P.decalS + s];
  var soleil = 1.0;
  var k = 0u;
  loop {
    let d = P.d0 + f32(k) * P.pas;
    if (d >= P.dLim) { break; }
    let rayon = p.z + d * sol.z;
    if (rayon > P.plafond) { break; }
    if (hauteur(p.x + sol.x * d, p.y + sol.y * d) > rayon) { soleil = 0.0; break; }
    k = k + 1u;
  }
  sortie[idx] = soleil;
}
`;

async function pipelines() {
  if (etat.pipelines) return etat.pipelines;
  const device = etat.device;
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: WGSL });
  const info = module.getCompilationInfo ? await module.getCompilationInfo() : null;
  const erreurs = info?.messages?.filter((m) => m.type === 'error') || [];
  if (erreurs.length) { await device.popErrorScope(); throw new Error(`shader : ${erreurs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' ; ')}`); }
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const creer = (entryPoint) => device.createComputePipelineAsync
    ? device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint } })
    : device.createComputePipeline({ layout: pl, compute: { module, entryPoint } });
  const [horizon, moyenne, masque] = await Promise.all([creer('horizon'), creer('moyenne'), creer('masque')]);
  const err = await device.popErrorScope();
  if (err) throw new Error(`pipeline : ${err.message}`);
  etat.pipelines = { layout, horizon, moyenne, masque };
  return etat.pipelines;
}

// ------------------------------------------------------------------
// Outils communs
// ------------------------------------------------------------------
export const hauteurMax = (g) => { if (g.hMax == null) { let m = 0; for (let i = 0; i < g.H.length; i++) if (g.H[i] > m) m = g.H[i]; g.hMax = m; } return g.hMax; };
// directions d'horizon : [sin, −cos] de q / N tours (même ordre que chaleur-modele.js et confort.js)
export const directions = (N) => Array.from({ length: N }, (_, q) => [Math.sin((q / N) * 2 * Math.PI), -Math.cos((q / N) * 2 * Math.PI)]);
const pauseUI = () => new Promise((r) => setTimeout(r, 0));
const maintenant = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// grille des hauteurs gardée sur la carte tant que le même objet g est utilisé (SVF puis masques)
const grillesGPU = new WeakMap();
function tamponGrille(device, g) {
  const t = grillesGPU.get(g);
  if (t && t.device === device) return t.buffer;
  const buffer = device.createBuffer({ size: Math.max(16, g.H.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, g.H.buffer, g.H.byteOffset, g.H.byteLength);
  grillesGPU.set(g, { device, buffer });
  return buffer;
}
function tamponDe(device, donnees, usage = GPUBufferUsage.STORAGE) {
  const b = device.createBuffer({ size: Math.max(16, Math.ceil(donnees.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(b, 0, donnees.buffer, donnees.byteOffset, donnees.byteLength);
  return b;
}
function pointsVec4(pts) {
  const a = new Float32Array(pts.n * 4);
  for (let i = 0; i < pts.n; i++) { a[i * 4] = pts.x[i]; a[i * 4 + 1] = pts.z[i]; a[i * 4 + 2] = pts.y0[i]; }
  return a;
}
// dispatch 2D : au plus 32 768 groupes de 64 par ligne
function grilleDispatch(total) {
  const groupes = Math.max(1, Math.ceil(total / 64));
  const x = Math.min(groupes, 32768);
  return { x, y: Math.ceil(groupes / x), ligne: x * 64 };
}
function params(g, o) {
  const b = new ArrayBuffer(64), f = new Float32Array(b), u = new Uint32Array(b);
  f[0] = g.x0; f[1] = g.z0; u[2] = g.w; u[3] = g.h;
  f[4] = hauteurMax(g); u[5] = o.n; u[6] = o.nb; u[7] = o.decal || 0;
  f[8] = o.pas; f[9] = o.d0 || 0; f[10] = o.dLim; f[11] = o.plafond ?? 0;
  u[12] = o.ligne; u[13] = o.decalS || 0;
  return b;
}
// invocations par lot : limite de taille du tampon de sortie et durée d'une soumission (pas de blocage du pilote)
const LOT_MAX = 1 << 21;
const tailleMaxTampon = () => Math.min(etat.device?.limits?.maxStorageBufferBindingSize || 134217728, etat.device?.limits?.maxBufferSize || 268435456);

// erreurs de validation ou de mémoire : silencieuses en WebGPU (résultat faux sans exception) → capturées et levées,
// pour que l'appelant reprenne le calcul sur le processeur
async function sousControle(device, fn) {
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let r, e1 = null;
  try { r = await fn(); } catch (e) { e1 = e; }
  const v = await device.popErrorScope().catch(() => null), m = await device.popErrorScope().catch(() => null);
  if (e1) throw e1;
  if (v || m) throw new Error(`WebGPU : ${(v || m).message}`);
  return r;
}

async function lireTampon(device, src, octets) {
  const lecture = device.createBuffer({ size: octets, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, lecture, 0, octets);
  device.queue.submit([enc.finish()]);
  await lecture.mapAsync(GPUMapMode.READ);
  const copie = new Float32Array(lecture.getMappedRange().slice(0));
  lecture.unmap(); lecture.destroy();
  return copie;
}

// ------------------------------------------------------------------
// Ouverture au ciel sur la carte : pts = { n, x, z, y0 } ; { N directions, pas (m), dMax (m) } → Float32Array(n) = 1 − moyenne sin²
// stats (facultatif) reçoit { calcul, lecture, compilation, total } en ms
// ------------------------------------------------------------------
export async function svfGPU(g, pts, o = {}) {
  const device = etat.device;
  if (!device) throw new Error('WebGPU non initialisé');
  return sousControle(device, () => svfGPU1(device, g, pts, o));
}
async function svfGPU1(device, g, pts, { N = 24, pas = 2, dMax = 120, note = null, stats = null } = {}) {
  const t0 = maintenant();
  const P = await pipelines();
  const tCompil = maintenant();
  const bufH = tamponGrille(device, g);
  const bufP = tamponDe(device, pointsVec4(pts));
  const dirs = new Float32Array(N * 4);
  directions(N).forEach(([sx, sz], q) => { dirs[q * 4] = sx; dirs[q * 4 + 1] = sz; });
  const bufD = tamponDe(device, dirs);
  const parLot = Math.max(1, Math.min(Math.floor(LOT_MAX / N), Math.floor(tailleMaxTampon() / (4 * N))));
  const bufS = device.createBuffer({ size: Math.max(16, parLot * N * 4), usage: GPUBufferUsage.STORAGE });
  const bufR = device.createBuffer({ size: Math.max(16, pts.n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const bufU = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let calcul = 0;
  try {
    for (let debut = 0; debut < pts.n; debut += parLot) {
      const n = Math.min(parLot, pts.n - debut);
      const d1 = grilleDispatch(n * N), d2 = grilleDispatch(n);
      // première passe : horizon de chaque point du lot dans chaque direction (tampon intermédiaire bufS)
      const enc = device.createCommandEncoder();
      const u1 = params(g, { n, nb: N, decal: debut, pas, dLim: dMax, ligne: d1.ligne });
      device.queue.writeBuffer(bufU, 0, u1);
      const bg = device.createBindGroup({ layout: P.layout, entries: [
        { binding: 0, resource: { buffer: bufU } }, { binding: 1, resource: { buffer: bufH } }, { binding: 2, resource: { buffer: bufP } },
        { binding: 3, resource: { buffer: bufD } }, { binding: 4, resource: { buffer: bufS } }, { binding: 5, resource: { buffer: bufR } }] });
      let pass = enc.beginComputePass();
      pass.setPipeline(P.horizon); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(d1.x, d1.y); pass.end();
      device.queue.submit([enc.finish()]);
      // deuxième passe : moyenne par point (autre largeur de dispatch), écrite dans bufLot puis recopiée à sa place dans bufR
      const bufLot = device.createBuffer({ size: Math.max(16, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const u2 = params(g, { n, nb: N, decal: debut, pas, dLim: dMax, ligne: d2.ligne });
      const bufU2 = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(bufU2, 0, u2);
      const bg2 = device.createBindGroup({ layout: P.layout, entries: [
        { binding: 0, resource: { buffer: bufU2 } }, { binding: 1, resource: { buffer: bufH } }, { binding: 2, resource: { buffer: bufP } },
        { binding: 3, resource: { buffer: bufD } }, { binding: 4, resource: { buffer: bufS } }, { binding: 5, resource: { buffer: bufLot } }] });
      const enc2 = device.createCommandEncoder();
      pass = enc2.beginComputePass();
      pass.setPipeline(P.moyenne); pass.setBindGroup(0, bg2); pass.dispatchWorkgroups(d2.x, d2.y); pass.end();
      enc2.copyBufferToBuffer(bufLot, 0, bufR, debut * 4, n * 4);
      const tc = maintenant();
      device.queue.submit([enc2.finish()]);
      await device.queue.onSubmittedWorkDone();
      calcul += maintenant() - tc;
      bufLot.destroy(); bufU2.destroy();
      if (note && pts.n > parLot) { note(`Ouverture au ciel (carte graphique) : ${Math.round((100 * (debut + n)) / pts.n)} %`); await pauseUI(); }
    }
    const tl = maintenant();
    const r = await lireTampon(device, bufR, pts.n * 4);
    if (stats) Object.assign(stats, { calcul, lecture: maintenant() - tl, compilation: tCompil - t0, total: maintenant() - t0 });
    return r;
  } finally {
    [bufP, bufD, bufS, bufR, bufU].forEach((b) => b.destroy());
  }
}

// ------------------------------------------------------------------
// Masques d'ombre sur la carte : soleils = [{ sx, sz, tanAlt }] ; { d0, pas, dLim, plafond } → Uint8Array(soleils × n) (1 = soleil)
// ------------------------------------------------------------------
export async function masquesGPU(g, pts, soleils, o = {}) {
  const device = etat.device;
  if (!device) throw new Error('WebGPU non initialisé');
  return sousControle(device, () => masquesGPU1(device, g, pts, soleils, o));
}
async function masquesGPU1(device, g, pts, soleils, { d0 = 1.5, pas = 1.5, dLim = 450, plafond = null, note = null, stats = null } = {}) {
  const t0 = maintenant();
  const P = await pipelines();
  const tCompil = maintenant();
  const nS = soleils.length, n = pts.n;
  const M = new Uint8Array(nS * n);
  if (!nS || !n) return M;
  const bufH = tamponGrille(device, g);
  const bufP = tamponDe(device, pointsVec4(pts));
  const sol = new Float32Array(nS * 4);
  soleils.forEach((s, k) => { sol[k * 4] = s.sx; sol[k * 4 + 1] = s.sz; sol[k * 4 + 2] = s.tanAlt; });
  const bufD = tamponDe(device, sol);
  const plaf = plafond ?? hauteurMax(g);
  // lot = quelques soleils sur tous les points (sinon une partie des points si un seul soleil dépasse le lot)
  const parLotInv = Math.max(64, Math.min(LOT_MAX, Math.floor(tailleMaxTampon() / 4)));
  const ptsParLot = Math.min(n, parLotInv);
  const solParLot = Math.max(1, Math.floor(parLotInv / ptsParLot));
  const bufS = device.createBuffer({ size: Math.max(16, ptsParLot * solParLot * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const bufR = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
  const bufU = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let calcul = 0, lecture = 0, fait = 0;
  const totalLots = Math.ceil(nS / solParLot) * Math.ceil(n / ptsParLot);
  try {
    for (let s0 = 0; s0 < nS; s0 += solParLot) {
      const ns = Math.min(solParLot, nS - s0);
      for (let p0 = 0; p0 < n; p0 += ptsParLot) {
        const np = Math.min(ptsParLot, n - p0);
        const d = grilleDispatch(np * ns);
        device.queue.writeBuffer(bufU, 0, params(g, { n: np, nb: ns, decal: p0, decalS: s0, pas, d0, dLim, plafond: plaf, ligne: d.ligne }));
        const bg = device.createBindGroup({ layout: P.layout, entries: [
          { binding: 0, resource: { buffer: bufU } }, { binding: 1, resource: { buffer: bufH } }, { binding: 2, resource: { buffer: bufP } },
          { binding: 3, resource: { buffer: bufD } }, { binding: 4, resource: { buffer: bufS } }, { binding: 5, resource: { buffer: bufR } }] });
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(P.masque); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(d.x, d.y); pass.end();
        const tc = maintenant();
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
        calcul += maintenant() - tc;
        const tl = maintenant();
        const r = await lireTampon(device, bufS, np * ns * 4);
        lecture += maintenant() - tl;
        for (let s = 0; s < ns; s++) {
          const base = (s0 + s) * n + p0, b = s * np;
          for (let i = 0; i < np; i++) M[base + i] = r[b + i] > 0.5 ? 1 : 0;
        }
        if (note && totalLots > 1) { note(`Ombres (carte graphique) : ${Math.round((100 * ++fait) / totalLots)} %`); await pauseUI(); }
      }
    }
    if (stats) Object.assign(stats, { calcul, lecture, compilation: tCompil - t0, total: maintenant() - t0 });
    return M;
  } finally {
    [bufP, bufD, bufS, bufR, bufU].forEach((b) => b.destroy());
  }
}

// ------------------------------------------------------------------
// Calcul de référence sur le processeur (même algorithme que les noyaux et que les boucles de chaleur-modele.js / confort.js)
// ------------------------------------------------------------------
function hauteurEn(g, x, z) {
  const i = Math.floor(x - g.x0), j = Math.floor(z - g.z0);
  if (i < 0 || j < 0 || i >= g.w || j >= g.h) return 0;
  return g.H[j * g.w + i];
}
export async function svfCPU(g, pts, { N = 24, pas = 2, dMax = 120, note = null, sansPause = false } = {}) {
  const Hm = hauteurMax(g), dirs = directions(N), r = new Float32Array(pts.n);
  let t = maintenant();
  for (let i = 0; i < pts.n; i++) {
    const x = pts.x[i], z = pts.z[i], y0 = pts.y0[i];
    let s = 0;
    for (const [sx, sz] of dirs) {
      let tm = 0;
      for (let d = pas; d <= dMax; d += pas) {
        if ((Hm - y0) / d <= tm) break;
        const v = (hauteurEn(g, x + sx * d, z + sz * d) - y0) / d; if (v > tm) tm = v;
      }
      s += Math.sin(Math.atan(tm)) ** 2;
    }
    r[i] = 1 - s / N;
    if (!sansPause && (i & 1023) === 1023 && maintenant() - t > 80) { note?.(`Ouverture au ciel (processeur) : ${Math.round((100 * i) / pts.n)} %`); await pauseUI(); t = maintenant(); }
  }
  return r;
}
export async function masquesCPU(g, pts, soleils, { d0 = 1.5, pas = 1.5, dLim = 450, plafond = null, note = null, sansPause = false } = {}) {
  const plaf = plafond ?? hauteurMax(g), n = pts.n, M = new Uint8Array(soleils.length * n);
  let t = maintenant();
  for (let s = 0; s < soleils.length; s++) {
    const p = soleils[s], base = s * n;
    for (let i = 0; i < n; i++) {
      const x = pts.x[i], z = pts.z[i], y0 = pts.y0[i];
      let soleil = 1;
      for (let d = d0; d < dLim; d += pas) {
        const rayon = y0 + d * p.tanAlt;
        if (rayon > plaf) break;
        if (hauteurEn(g, x + p.sx * d, z + p.sz * d) > rayon) { soleil = 0; break; }
      }
      M[base + i] = soleil;
      if (!sansPause && (i & 1023) === 1023 && maintenant() - t > 80) { note?.(`Ombres (processeur) : ${Math.round((100 * (s + i / n)) / soleils.length)} %`); await pauseUI(); t = maintenant(); }
    }
  }
  return M;
}

// ------------------------------------------------------------------
// Point d'entrée des modules : la carte si possible, sinon null (l'appelant fait son calcul sur le processeur)
// ------------------------------------------------------------------
export async function essayer(nom, fn) {
  try {
    if (!(await actif())) return null;
    const t0 = maintenant();
    const r = await fn();
    etat.dernierCalcul = { nom, mode: 'gpu', duree: maintenant() - t0, date: new Date() };
    notifier();
    return r;
  } catch (e) {
    etat.derniereErreur = `${nom} : ${e.message || e}`;
    console.warn('WebGPU : calcul sur le processeur après une erreur —', etat.derniereErreur);
    etat.dernierCalcul = { nom, mode: 'cpu', erreur: true, date: new Date() };
    notifier();
    return null;
  }
}
export function noterCPU(nom, duree) { etat.dernierCalcul = { nom, mode: 'cpu', duree, date: new Date() }; notifier(); }
export const ouvertureCiel = (g, pts, o) => essayer('ouverture au ciel', () => svfGPU(g, pts, o));
export const ombres = (g, pts, soleils, o) => essayer('ombres', () => masquesGPU(g, pts, soleils, o));

// ------------------------------------------------------------------
// Diagnostic « Tester WebGPU » : même calcul sur le processeur puis sur la carte, sur la zone courante
// pts / g fournis par l'appelant (grille de Confort : mailles ouvertes du cercle d'analyse) ; soleils : 49 instantanés du jour
// ------------------------------------------------------------------
export async function diagnostic({ g, pts, soleils, svf = { N: 36, pas: 2, dMax: 160 }, ombre = { d0: 1.5, pas: 1.5, dLim: 450 }, zone = '', note = () => {} }) {
  const L = [];
  const f = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d).replace('.', ','));
  const ms = (v) => `${f(v, v < 10 ? 1 : 0)} ms`;
  L.push(`Diagnostic WebGPU — atlas de l'Hôtel de Ville, ${new Date().toLocaleString('fr-FR')}`);
  L.push(`Navigateur : ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`);
  const R = await detecter({ forcer: !etat.device });
  const I = info();
  L.push(`Adaptateur : ${R.disponible ? I.nom : 'aucun'}${R.fallback ? ' (adaptateur logiciel de secours)' : ''}`);
  if (R.limites) L.push(`Limites : tampon de stockage ${f((R.limites.maxStorageBufferBindingSize || 0) / 1048576)} Mo, groupes par dimension ${R.limites.maxComputeWorkgroupsPerDimension ?? '—'}, invocations par groupe ${R.limites.maxComputeInvocationsPerWorkgroup ?? '—'}`);
  L.push(`Réglage : ${({ '1': 'carte graphique (forcé)', '0': 'processeur (forcé)' })[lireReglage()] || 'automatique'} → calculs de Confort et Chaleur sur ${actifConnu() ? 'la carte graphique' : 'le processeur'}`);
  L.push(`Auto-test : ${texteBanc() || 'pas encore fait (au premier calcul en réglage automatique)'}`);
  L.push(`Zone : ${zone} ; ${pts.n.toLocaleString('fr-FR')} points, grille des hauteurs ${g.w} × ${g.h} m, ${soleils.length} positions du soleil`);
  if (!R.disponible) {
    L.push(`Raison : ${R.raison}`);
    L.push('Verdict : WebGPU INDISPONIBLE — les calculs restent sur le processeur (résultats inchangés).');
    return { texte: L.join('\n'), verdict: 'indisponible' };
  }
  // 1. processeur
  note('Diagnostic : ouverture au ciel sur le processeur…');
  let t = maintenant();
  const svfC = await svfCPU(g, pts, { ...svf, note });
  const tSvfC = maintenant() - t;
  note('Diagnostic : ombres sur le processeur…');
  t = maintenant();
  const mC = await masquesCPU(g, pts, soleils, { ...ombre, note });
  const tMC = maintenant() - t;
  // 2. carte : une première fois (compilation des noyaux, envoi de la grille), puis mesure
  let svfG, mG; const sS = {}, sM = {};
  try {
    note('Diagnostic : compilation des noyaux et premier passage sur la carte…');
    const sous = { n: Math.min(pts.n, 256), x: pts.x, z: pts.z, y0: pts.y0 };
    await svfGPU(g, sous, svf); await masquesGPU(g, sous, soleils.slice(0, 2), ombre);
    note('Diagnostic : ouverture au ciel sur la carte…');
    svfG = await svfGPU(g, pts, { ...svf, stats: sS });
    note('Diagnostic : ombres sur la carte…');
    mG = await masquesGPU(g, pts, soleils, { ...ombre, stats: sM });
  } catch (e) {
    etat.derniereErreur = e.message || String(e);
    L.push(`Erreur sur la carte : ${etat.derniereErreur}`);
    L.push('Verdict : WebGPU INDISPONIBLE (erreur) — les calculs restent sur le processeur.');
    return { texte: L.join('\n'), verdict: 'erreur' };
  }
  // 3. comparaison
  let eMax = 0, eSom = 0, nE = 0, nSup = 0;
  for (let i = 0; i < pts.n; i++) { const e = Math.abs(svfC[i] - svfG[i]); if (e > eMax) eMax = e; eSom += e; nE++; if (e > 0.01) nSup++; }
  let diff = 0;
  for (let k = 0; k < mC.length; k++) if (mC[k] !== mG[k]) diff++;
  const partDiff = mC.length ? diff / mC.length : 0;
  const ok = eMax <= 0.01 && partDiff <= 0.005;
  const acc = (c, g2) => (g2 > 0 ? `× ${f(c / g2, c / g2 < 1 ? 2 : c / g2 < 10 ? 1 : 0)}` : '—');
  L.push('');
  L.push(`Ouverture au ciel (${svf.N} directions, ${svf.dMax} m) : processeur ${ms(tSvfC)} ; carte ${ms(sS.calcul)} hors transfert, ${ms(sS.total)} avec transfert → accélération ${acc(tSvfC, sS.calcul)} (${acc(tSvfC, sS.total)} avec transfert)`);
  L.push(`  écart maximal ${f(eMax, 4)}, moyen ${f(eSom / Math.max(1, nE), 5)} ; ${nSup} point(s) à plus de 0,01`);
  L.push(`Ombres (${soleils.length} positions, pas ${f(ombre.pas, 1)} m) : processeur ${ms(tMC)} ; carte ${ms(sM.calcul)} hors transfert, ${ms(sM.total)} avec transfert → accélération ${acc(tMC, sM.calcul)} (${acc(tMC, sM.total)} avec transfert)`);
  L.push(`  masques différents : ${diff.toLocaleString('fr-FR')} sur ${mC.length.toLocaleString('fr-FR')} (${f(partDiff * 100, 3)} %)`);
  L.push(`Verdict : ${ok ? 'OK — résultats identiques au processeur à la tolérance près (ouverture au ciel ± 0,01, masques < 0,5 % différents)' : 'ÉCART TROP GRAND — garder le calcul sur le processeur (décocher la case) et envoyer ce rapport'}`);
  if (R.fallback) L.push('Remarque : adaptateur logiciel (pas la carte graphique) : les temps ne reflètent pas une vraie carte.');
  return { texte: L.join('\n'), verdict: ok ? 'ok' : 'ecart', eMax, eMoy: eSom / Math.max(1, nE), partDiff, tSvfC, tMC, sS, sM };
}

// ------------------------------------------------------------------
// Bloc d'interface (panneaux Confort et Chaleur) : case, état, bouton « Tester WebGPU », rapport copiable
// h, info : fonctions de js/util.js ; preparer() → { g, pts, soleils, zone } (zone courante, fournie par le module)
// ------------------------------------------------------------------
let stylesAjoutes = false;
function ajouterStyles() {
  if (stylesAjoutes || typeof document === 'undefined') return;
  stylesAjoutes = true;
  const s = document.createElement('style');
  s.id = 'styles-gpu';
  s.textContent = `.bloc-gpu{margin:.6rem 0;border-top:1px solid var(--trait,#d6dade);padding-top:.4rem}
.bloc-gpu summary{cursor:pointer;font-weight:600}
.bloc-gpu .titre-info{display:flex;align-items:center;gap:.4rem;margin-top:.3rem}
.bloc-gpu .etat-gpu{margin:.3rem 0}
.bloc-gpu pre.rapport-gpu{white-space:pre-wrap;font-size:.75rem;max-height:16rem;overflow:auto;background:var(--fond-2,#f3f4f5);padding:.4rem;border-radius:4px;user-select:text}`;
  document.head.append(s);
}
export function blocGPU({ h, info: bInfo }, preparer) {
  ajouterStyles();
  const cas = h('input', { type: 'checkbox' });
  const etatTxt = h('p', { class: 'note etat-gpu', 'data-garder': '' });
  const sortie = h('pre', { class: 'rapport-gpu', hidden: true });
  const copier = h('button', { type: 'button', class: 'bouton discret', hidden: true, onclick: async () => {
    try { await navigator.clipboard.writeText(sortie.textContent); copier.textContent = 'Copié'; } catch { const r = document.createRange(); r.selectNodeContents(sortie); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copier.textContent = 'Texte sélectionné : Ctrl+C'; }
    setTimeout(() => { copier.textContent = 'Copier le rapport'; }, 2500);
  } }, 'Copier le rapport');
  const tester = h('button', { type: 'button', class: 'bouton discret', onclick: async () => {
    tester.disabled = true; sortie.hidden = false; copier.hidden = true;
    try {
      const d = await preparer();
      const r = await diagnostic({ ...d, note: (t) => { sortie.textContent = t; } });
      sortie.textContent = r.texte;
    } catch (e) { sortie.textContent = `Diagnostic impossible : ${e.message || e}`; console.warn(e); } finally { tester.disabled = false; copier.hidden = false; maj(); }
  } }, 'Tester WebGPU');
  cas.addEventListener('change', () => { definirReglage(cas.checked); maj(); });
  const maj = () => {
    const I = info();
    if (!I) { etatTxt.textContent = 'Recherche de la carte graphique…'; cas.disabled = true; return; }
    cas.disabled = !I.disponible;
    cas.checked = actifConnu();
    const der = I.dernierCalcul ? ` Dernier calcul (${I.dernierCalcul.nom}) : ${I.dernierCalcul.mode === 'gpu' ? 'carte graphique' : 'processeur'}${I.dernierCalcul.erreur ? ' après une erreur' : ''}${I.dernierCalcul.duree ? `, ${(I.dernierCalcul.duree / 1000).toFixed(1).replace('.', ',')} s` : ''}.` : '';
    etatTxt.textContent = I.disponible
      ? `Carte détectée : ${I.nom}${I.fallback ? ' (logiciel)' : ''}. Calculs d'ombres et d'ouverture au ciel sur ${actifConnu() ? 'la carte graphique' : 'le processeur'}${I.reglage == null && !I.fallback && texteBanc() ? ` (réglage automatique, auto-test : ${texteBanc()})` : ''}.${der}`
      : `${I.raison || 'WebGPU indisponible'} Calcul sur le processeur (mêmes résultats).${der}`;
  };
  const bloc = h('details', { class: 'bloc-gpu', 'data-garder': '' },
    h('summary', {}, 'Carte graphique (WebGPU) et diagnostic'),
    h('div', { class: 'titre-info' }, h('label', { class: 'case' }, cas, ' Calcul sur la carte graphique (WebGPU)'),
      bInfo ? bInfo('Ombres et ouverture au ciel calculées par la carte graphique (WebGPU, Chrome ou Edge), mêmes règles que sur le processeur : une maille par fil de calcul. Sans WebGPU (Safari, iPhone, ancien pilote, borne), ou en cas d\'erreur, le calcul se fait sur le processeur, avec les mêmes résultats.',
        'Tester WebGPU : refait sur la zone courante (cercle d\'analyse de Confort) l\'ouverture au ciel et les ombres de la journée sur le processeur puis sur la carte, et compare temps et résultats (écart toléré : 0,01 sur l\'ouverture au ciel). Le rapport se copie pour être envoyé.',
        'Réglage automatique : la carte n\'est choisie que si un auto-test unique (fait au premier calcul, quelques dixièmes de seconde) la trouve plus rapide que le processeur, envois et lectures compris ; sinon processeur. Une puce graphique intégrée est souvent plus lente, transferts compris.',
        'Réglage mémorisé dans ce navigateur (localStorage atlas-hdv-webgpu ; auto-test : atlas-hdv-webgpu-bench, à effacer pour le refaire).') : null),
    etatTxt,
    h('div', { class: 'actions' }, tester, copier),
    sortie);
  // panneau refait : l'ancien bloc, détaché, cesse d'écouter
  const off = surChangement(() => { if (bloc.isConnected) { bloc.dataset.vu = '1'; maj(); } else if (bloc.dataset.vu) off(); });
  maj();
  detecter().then(maj);
  return bloc;
}

// périphérique courant (console du navigateur, essais) : window.atlas n'en dépend pas
export const peripherique = () => etat.device;
