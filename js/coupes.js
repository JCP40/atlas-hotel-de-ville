import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { h, allerVers } from './util.js';
import { COULEURS, visibiliteBatiment } from './maquette.js';
import { polygonesLocaux, centroide } from './geo.js';
import { chargerJSON, enregistrerDonnees, telecharger } from './donnees.js';

// ------------------------------------------------------------------
// Outil Coupes (touche C, onglet Coupes)
// - Coupes linéaires : A et B prédéfinies (config.json > axes), coupes libres tracées en deux clics au sol.
//   Un plan de clipping (et un plan arrière si une profondeur de vue est donnée) ; sens de vue inversable.
// - Coupes de zone : rectangle tracé en trois clics (deux pour un côté, un pour la largeur) = boîte de coupe
//   (quatre plans verticaux et un plafond), seul l'intérieur reste.
// - Poché : sections calculées analytiquement sur les volumes extrudés de app.batiEffectif() (bâti existant
//   non démoli + volumes du projet) et bande de sol le long du plan ; recalculé sur l'événement « bati ».
//   Un bâtiment à toits détaillés (Hôtel de Ville, js/toits.js) fournit empreinte.hauteurEn(x, z) : le poché 3D suit
//   ses pans ; le dessin 2D garde un rectangle jusqu'au faîtage.
// - Dessin de coupe 2D (coupes linéaires) : profil du terrain, sections pochées, élévations en arrière-plan,
//   cotes, échelle graphique, sens de la vue ; export SVG et DXF R12 (mètres : X le long de la coupe, Y altitude).
// - Liste nommée enregistrée dans data/coupes.json (enregistrerDonnees, sinon téléchargement), relue au démarrage.
// - Coupes polylignes (15/10/2026) : points successifs (double-clic ou « Terminer » pour finir), points modifiables ;
//   poché le long de chaque segment, plan de clipping 3D sur le segment choisi, dessin 2D déroulé (plis marqués).
// - Vue de face : caméra orthographique parallèle au plan de coupe (élévation), retour à la vue précédente.
// - Dessin en couleurs (poché, sol, bâti, projet, élévations teintées) avec les photos de façade (data/facades/)
//   des façades vues en élévation ; l'export SVG embarque les images.
// ------------------------------------------------------------------

const BORNES_ZONE = { a: [5, 800, 120], b: [5, 800, 80], rot: [-180, 180, 0], hmax: [2, 150, 25] };
const PROF_DESSIN = 60; // profondeur des élévations du dessin 2D quand la coupe n'a pas de plan arrière (m)
const EPS = 0.06; // décalage du poché vers la partie gardée (évite qu'il soit lui-même coupé)
const ENCRE = { bati: '#2f3b45', projet: '#5e9384', sol: '#cbbd9c', solTrait: '#6b4f26', coupe: '#c8372d', trait: '#5b6770', papier: '#ffffff' };
const CALQUES = { COUPE_SOL: 34, COUPE_BATI: 250, COUPE_PROJET: 3, ELEVATION: 8, COTES: 1, PLIS: 30 };
// dessin en couleurs : poché, sol, élévations teintées (le reste reprend ENCRE)
const TEINTES = { bati: '#9e3b2c', projet: '#3f8f74', sol: '#c9a77c', solTrait: '#6b4f26', elevation: '#e6d9bd', elevationTrait: '#8a7f6a', elevationProjet: '#bfe0d2', ciel: '#f6f8fa' };

const couleurCSS = (nom, defaut) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || defaut; } catch { return defaut; }
};
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', ',');
const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const horodatage = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const borner = (v, [lo, hi, d]) => { const x = Number(v); return Number.isFinite(x) && v !== '' ? Math.max(lo, Math.min(hi, x)) : d; };

// Extrémité d'axe : [lat, lon], ou { nom: "expression" } cherché dans OpenStreetMap
// (espaces verts puis bâtiments), ou { remarquable: "mairie" }. Repli sur « repli » : [lat, lon].
function resoudre(app, v) {
  if (Array.isArray(v)) { const l = app.proj.versLocal(v[0], v[1]); return { x: l.x, z: l.z, trouve: true }; }
  const candidats = [];
  if (v?.nom) {
    const re = new RegExp(v.nom, 'i');
    for (const col of [app.donnees.osm?.surfaces, app.donnees.osm?.batiments]) {
      for (const f of col?.features || []) if (re.test(f.properties?.name || '')) candidats.push(f);
      if (candidats.length) break;
    }
  }
  // Mairie : centre du périmètre des toitures détaillées (parcelle EY 64, aire « townhall » d'OSM,
  // qui n'est pas un bâtiment et n'est donc pas chargée avec le bâti)
  if (v?.remarquable === 'mairie') {
    const c = app.toits?.centre?.();
    if (c) return { x: c[0], z: c[1], trouve: true };
  }
  if (v?.remarquable) {
    const r = (app.config.remarquables || []).find((x) => x.id === v.remarquable);
    if (r) {
      for (const f of app.donnees.batiments?.features || []) {
        const p = f.properties || {};
        if ((r.tag && p[r.tag] === r.valeur) || (r.nom && new RegExp(r.nom, 'i').test(p.name || ''))) candidats.push(f);
      }
    }
  }
  if (candidats.length) {
    let sx = 0, sz = 0, n = 0;
    for (const f of candidats) for (const [ext] of polygonesLocaux(f.geometry, app.proj)) { const [cx, cz] = centroide(ext); sx += cx; sz += cz; n++; }
    if (n) return { x: sx / n, z: sz / n, trouve: true };
  }
  const r = v?.repli ? app.proj.versLocal(v.repli[0], v.repli[1]) : { x: 0, z: 0 };
  return { x: r.x, z: r.z, trouve: false };
}

// ------------------------------------------------------------------
// Géométrie dans le plan (x est, z sud)
// ------------------------------------------------------------------

// Intervalles [t0, t1] où la droite O + t·u traverse un polygone (anneaux, trous compris : pair-impair)
function intervallesPoly(O, u, poly) {
  const wx = -u.z, wz = u.x;
  const ts = [];
  for (const anneau of poly) {
    const n = anneau.length;
    for (let i = 0; i < n; i++) {
      const a = anneau[i], b = anneau[(i + 1) % n];
      const da = (a[0] - O.x) * wx + (a[1] - O.z) * wz, db = (b[0] - O.x) * wx + (b[1] - O.z) * wz;
      if ((da > 0) === (db > 0)) continue;
      const k = da / (da - db);
      const px = a[0] + (b[0] - a[0]) * k, pz = a[1] + (b[1] - a[1]) * k;
      ts.push((px - O.x) * u.x + (pz - O.z) * u.z);
    }
  }
  ts.sort((p, q) => p - q);
  const res = [];
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > 0.01) res.push([ts[i], ts[i + 1]]);
  return res;
}
function intervalles(O, u, polys, t0, t1) {
  const res = [];
  for (const poly of polys) {
    for (const [a, b] of intervallesPoly(O, u, poly)) {
      const lo = Math.max(a, t0), hi = Math.min(b, t1);
      if (hi - lo > 0.05) res.push([lo, hi]);
    }
  }
  return res;
}

// Sutherland-Hodgman : anneau [[x, z]] gardé du côté intérieur de demi-plans { p, n, d } ((P - p)·n >= d)
function decouper(anneau, demiPlans) {
  let pts = anneau;
  for (const { p, n, d } of demiPlans) {
    if (pts.length < 3) return [];
    const s = (q) => (q[0] - p.x) * n.x + (q[1] - p.z) * n.z - d;
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const sa = s(a), sb = s(b);
      if (sa >= 0) res.push(a);
      if ((sa >= 0) !== (sb >= 0)) { const k = sa / (sa - sb); res.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]); }
    }
    pts = res;
  }
  return pts.length >= 3 ? pts : [];
}

// Coins d'une zone (rectangle centré, rotation trigonométrique, nord en haut, comme les volumes du projet)
function coinsZone(c) {
  const co = Math.cos((c.rot * Math.PI) / 180), si = Math.sin((c.rot * Math.PI) / 180);
  return [[-c.a / 2, -c.b / 2], [c.a / 2, -c.b / 2], [c.a / 2, c.b / 2], [-c.a / 2, c.b / 2]]
    .map(([u, v]) => ({ x: c.cx + u * co - v * si, z: c.cz - (u * si + v * co) }));
}

// Côtés d'une zone : origine, direction, longueur et normale intérieure
function cotesZone(c) {
  const k = coinsZone(c);
  return k.map((p, i) => {
    const q = k[(i + 1) % 4];
    const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const u = { x: (q.x - p.x) / L, z: (q.z - p.z) / L };
    let n = { x: -u.z, z: u.x };
    if ((c.cx - p.x) * n.x + (c.cz - p.z) * n.z < 0) n = { x: -n.x, z: -n.z };
    return { O: p, u, L, n };
  });
}

// Repère d'une coupe linéaire : plan décalé, direction, normale de vue (côté gardé)
function repereLigne(c) {
  const dx = c.B.x - c.A.x, dz = c.B.z - c.A.z;
  const L = Math.hypot(dx, dz) || 1;
  const u = { x: dx / L, z: dz / L };
  const normale = { x: u.z, z: -u.x }; // comme la version précédente (A et B inchangées)
  const s = c.inverse ? -1 : 1;
  const n = { x: normale.x * s, z: normale.z * s };
  const O = { x: c.A.x + normale.x * c.decalage, z: c.A.z + normale.z * c.decalage };
  return { O, u, L, n, normale };
}

// Segments d'une coupe polyligne { P: [{ x, z }…], inverse } : repère de chaque segment (côté gardé commun),
// abscisse cumulée depuis le premier point
function segmentsPoly(c) {
  const sg = c.inverse ? -1 : 1;
  const res = [];
  let cum = 0;
  for (let i = 0; i + 1 < c.P.length; i++) {
    const A = c.P[i], B = c.P[i + 1];
    const L = Math.hypot(B.x - A.x, B.z - A.z);
    if (L < 0.01) continue;
    const u = { x: (B.x - A.x) / L, z: (B.z - A.z) / L };
    const normale = { x: u.z, z: -u.x };
    res.push({ O: { x: A.x, z: A.z }, u, L, n: { x: normale.x * sg, z: normale.z * sg }, normale, cum, i });
    cum += L;
  }
  return res;
}
// Segments à dessiner : un seul pour une coupe linéaire (plan décalé), un par côté de la polyligne
function segmentsCoupe(c) {
  if (c.type === 'ligne') return [{ ...repereLigne(c), cum: 0, i: 0 }];
  return segmentsPoly(c);
}
const segmentActif = (c, segs) => segs[Math.max(0, Math.min(segs.length - 1, c.segment || 0))];

export function creerCoupes(app) {
  const etat = { actif: null, image: null, poche: true, trace: null, points: [], pret: false, signatureRelief: '', couleurs: true, face: null };
  const liste = []; // coupes (prédéfinies puis libres)
  const ui = {};

  // ------------------------------------------------------------
  // Coupes prédéfinies (config.json > axes)
  // ------------------------------------------------------------
  for (const a of app.config.axes || []) {
    const A = resoudre(app, a.de);
    const B = resoudre(app, a.a);
    if (Math.hypot(B.x - A.x, B.z - A.z) < 1) B.x = A.x + 100;
    liste.push({
      id: a.id, nom: a.nom || `Coupe ${a.id}`, type: 'ligne', predefinie: true, provisoire: !A.trouve || !B.trouve,
      visible: true, A: { x: A.x, z: A.z }, B: { x: B.x, z: B.z }, inverse: false, decalage: 0, profondeur: 0, image: a.image || null,
    });
  }
  const trouver = (id) => liste.find((c) => c.id === id) || null;
  const lignes = () => liste.filter((c) => c.type === 'ligne');
  const dessinables = () => liste.filter((c) => c.type === 'ligne' || c.type === 'polyligne');

  // ------------------------------------------------------------
  // Objets 3D : tracés, voile du plan, poché, aperçu du tracé
  // ------------------------------------------------------------
  const groupe = new THREE.Group();
  groupe.name = 'axes';
  app.scene.add(groupe);
  const groupePoche = new THREE.Group();
  groupePoche.name = 'coupes-poche';
  groupePoche.userData.pasDeRelief = true; // hauteurs calculées ici avec app.relief.dz
  app.scene.add(groupePoche);
  const matTrace = new THREE.LineDashedMaterial({ color: COULEURS.coupe, dashSize: 6, gapSize: 3, transparent: true, opacity: 0.9 });
  const matVoile = new THREE.LineBasicMaterial({ color: COULEURS.coupe, transparent: true, opacity: 0.7 });
  const matApercu = new THREE.LineDashedMaterial({ color: COULEURS.coupe, dashSize: 3, gapSize: 2 });
  const matPoche = {
    bati: new THREE.MeshBasicMaterial({ color: 0x2f3b45, side: THREE.DoubleSide }),
    projet: new THREE.MeshBasicMaterial({ color: 0x5e9384, side: THREE.DoubleSide }),
    sol: new THREE.MeshBasicMaterial({ color: 0x8c7a5b, side: THREE.DoubleSide }),
  };
  function majCouleurs() {
    matPoche.bati.color.set(couleurCSS('--ardoise', '#2f3b45'));
    matPoche.projet.color.set(couleurCSS('--projet', '#5e9384'));
    ENCRE.bati = couleurCSS('--ardoise', ENCRE.bati);
    ENCRE.projet = couleurCSS('--projet', ENCRE.projet);
    ENCRE.coupe = couleurCSS('--coupe', ENCRE.coupe);
  }
  let voile = null;
  const apercu = new THREE.Group();
  apercu.userData.pasDeRelief = true;
  app.scene.add(apercu);
  const plans = [];

  const dz = (x, z) => { const d = app.relief?.dz ? app.relief.dz(x, z) : 0; return Number.isFinite(d) ? d : 0; };
  const sansRayon = (o) => { o.raycast = () => {}; return o; };
  function vider(g) {
    for (const o of [...g.children]) { o.traverse((x) => x.geometry?.dispose()); g.remove(o); }
  }

  function dessinerTraces() {
    vider(groupe);
    app.etiquettes.retirerGroupe('axes');
    for (const c of liste) {
      const visibleSi = (a) => a.couches.axes && c.visible;
      if (c.type === 'ligne') {
        const ligne = sansRayon(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(c.A.x, 0.4, c.A.z), new THREE.Vector3(c.B.x, 0.4, c.B.z)]), matTrace));
        ligne.computeLineDistances();
        ligne.visible = c.visible;
        groupe.add(ligne);
        app.etiquettes.ajouter({ texte: c.id, position: new THREE.Vector3(c.A.x, 3, c.A.z), classe: 'etiquette-axe', groupe: 'axes', distanceMax: 4000, visibleSi });
        app.etiquettes.ajouter({ texte: `${c.id}′`, position: new THREE.Vector3(c.B.x, 3, c.B.z), classe: 'etiquette-axe', groupe: 'axes', distanceMax: 4000, visibleSi });
      } else if (c.type === 'polyligne') {
        const ligne = sansRayon(new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.P.map((p) => new THREE.Vector3(p.x, 0.4, p.z))), matTrace));
        ligne.computeLineDistances();
        ligne.visible = c.visible;
        groupe.add(ligne);
        const fin = c.P[c.P.length - 1];
        app.etiquettes.ajouter({ texte: c.id, position: new THREE.Vector3(c.P[0].x, 3, c.P[0].z), classe: 'etiquette-axe', groupe: 'axes', distanceMax: 4000, visibleSi });
        app.etiquettes.ajouter({ texte: `${c.id}′`, position: new THREE.Vector3(fin.x, 3, fin.z), classe: 'etiquette-axe', groupe: 'axes', distanceMax: 4000, visibleSi });
      } else {
        const k = coinsZone(c);
        const ligne = sansRayon(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(k.map((p) => new THREE.Vector3(p.x, 0.4, p.z))), matTrace));
        ligne.computeLineDistances();
        ligne.visible = c.visible;
        groupe.add(ligne);
        app.etiquettes.ajouter({ texte: c.id, position: new THREE.Vector3(k[0].x, 3, k[0].z), classe: 'etiquette-axe', groupe: 'axes', distanceMax: 4000, visibleSi });
      }
    }
    groupe.visible = app.couches.axes;
  }

  // ------------------------------------------------------------
  // Sections analytiques (bâti effectif)
  // ------------------------------------------------------------
  function batiVisible() {
    return (app.batiEffectif?.() || []).filter((e) => e.polys?.length && visibiliteBatiment(app, e.cle || ''));
  }

  // Poché 3D le long d'un plan vertical (O, u, n intérieure) entre t0 et t1, plafonné à yMax (repère de la scène)
  function pocherPlan(sortie, O, u, n, t0, t1, yMax = Infinity) {
    const P = (t, y) => [O.x + u.x * t + n.x * EPS, y, O.z + u.z * t + n.z * EPS];
    for (const e of batiVisible()) {
      const iv = intervalles(O, u, e.polys, t0, t1);
      if (!iv.length) continue;
      const lev = dz(e.cx, e.cz);
      const y0 = lev + (e.base || 0), y1 = Math.min(lev + e.hauteur, yMax - EPS);
      if (y1 <= y0) continue;
      const cible = e.projet ? sortie.projet : sortie.bati;
      const Q = e.projet ? P : (t, y) => { const q = P(t, y); return [q[0] + n.x * EPS, y, q[2] + n.z * EPS]; };
      for (const [a, b] of iv) {
        if (!e.hauteurEn) { quad(cible, Q(a, y0), Q(b, y0), Q(b, y1), Q(a, y1)); continue; }
        // toits détaillés (Hôtel de Ville, js/toits.js) : le poché suit les pans, par pas de 0,5 m
        const pas = Math.max(1, Math.ceil(Math.abs(b - a) / 0.5));
        const haut = (t) => e.hauteurEn(O.x + u.x * t, O.z + u.z * t);
        for (let i = 0; i < pas; i++) {
          const ta = a + ((b - a) * i) / pas, tb = a + ((b - a) * (i + 1)) / pas;
          let ha = haut(ta), hb = haut(tb);
          if (ha == null && hb == null) continue;
          ha ??= hb; hb ??= ha;
          const ya = Math.min(lev + ha, yMax - EPS), yb = Math.min(lev + hb, yMax - EPS);
          if (ya <= y0 && yb <= y0) continue;
          quad(cible, Q(ta, y0), Q(tb, y0), Q(tb, Math.max(yb, y0)), Q(ta, Math.max(ya, y0)));
        }
      }
    }
    // bande de sol (3 m sous le terrain affiché)
    const pas = 4;
    const n2 = Math.max(1, Math.ceil((t1 - t0) / pas));
    for (let i = 0; i < n2; i++) {
      const a = t0 + ((t1 - t0) * i) / n2, b = t0 + ((t1 - t0) * (i + 1)) / n2;
      const ya = dz(O.x + u.x * a, O.z + u.z * a) + 0.03, yb = dz(O.x + u.x * b, O.z + u.z * b) + 0.03;
      quad(sortie.sol, P(a, ya - 3), P(b, yb - 3), P(b, yb), P(a, ya));
    }
  }
  function quad(tab, p1, p2, p3, p4) { tab.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4); }

  function construirePoche(c) {
    vider(groupePoche);
    if (!c || !etat.poche) return;
    const sortie = { bati: [], projet: [], sol: [] };
    if (c.type === 'ligne') {
      const { O, u, n } = repereLigne(c);
      // le plan est infini : le poché couvre tout le périmètre chargé
      const R = Math.max(app.config.rayonEtude * 1.3, 300);
      const ou = O.x * u.x + O.z * u.z, disc = ou * ou - (O.x * O.x + O.z * O.z) + R * R;
      if (disc > 0) pocherPlan(sortie, O, u, n, -ou - Math.sqrt(disc), -ou + Math.sqrt(disc));
    } else if (c.type === 'polyligne') {
      // un poché par segment, limité au segment
      for (const sg of segmentsPoly(c)) pocherPlan(sortie, sg.O, sg.u, sg.n, 0, sg.L);
    } else {
      const yTop = dz(c.cx, c.cz) + c.hmax;
      for (const s of cotesZone(c)) pocherPlan(sortie, s.O, s.u, s.n, EPS, s.L - EPS, yTop);
      // plafond : sections horizontales des volumes plus hauts que la boîte
      const demi = cotesZone(c).map((s) => ({ p: s.O, n: s.n, d: EPS }));
      for (const e of batiVisible()) {
        const lev = dz(e.cx, e.cz);
        if (!(lev + (e.base || 0) < yTop && lev + e.hauteur > yTop)) continue;
        const cible = e.projet ? sortie.projet : sortie.bati;
        for (const [ext, ...trous] of e.polys) {
          const contour = decouper(ext, demi);
          if (!contour.length) continue;
          const tr = trous.map((t) => decouper(t, demi)).filter((t) => t.length);
          const v2 = (r) => r.map(([x, z]) => new THREE.Vector2(x, z));
          const cV = v2(contour), tV = tr.map(v2);
          const tous = [...cV, ...tV.flat()];
          for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(cV, tV)) {
            for (const q of [tous[i], tous[j], tous[k]]) cible.push(q.x, yTop - (e.projet ? EPS : 2 * EPS), q.y);
          }
        }
      }
    }
    for (const cle of ['sol', 'bati', 'projet']) {
      if (!sortie[cle].length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(sortie[cle], 3));
      const m = sansRayon(new THREE.Mesh(g, matPoche[cle]));
      m.renderOrder = 2;
      groupePoche.add(m);
    }
  }

  // ------------------------------------------------------------
  // Plans de clipping et voile
  // ------------------------------------------------------------
  const V3 = (p, y = 0) => new THREE.Vector3(p.x, y, p.z);
  function majPlan() {
    const c = trouver(etat.actif);
    if (!c) return;
    plans.length = 0;
    if (voile) { app.scene.remove(voile); voile.geometry.dispose(); voile = null; }
    const pts = [];
    if (c.type === 'ligne') {
      const { O, u, L, n } = repereLigne(c);
      plans.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(n.x, 0, n.z), V3(O)));
      if (c.profondeur > 0) {
        plans.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(-n.x, 0, -n.z), V3({ x: O.x + n.x * c.profondeur, z: O.z + n.z * c.profondeur })));
      }
      // voile : rectangle dans le plan, un peu au-delà des extrémités
      const a = { x: O.x - u.x * 40 + n.x * 0.3, z: O.z - u.z * 40 + n.z * 0.3 }, b = { x: O.x + u.x * (L + 40) + n.x * 0.3, z: O.z + u.z * (L + 40) + n.z * 0.3 };
      pts.push(V3(a, 0), V3(b, 0), V3(b, 0), V3(b, 160), V3(b, 160), V3(a, 160), V3(a, 160), V3(a, 0));
      if (etat.image) {
        const m = { x: (c.A.x + c.B.x) / 2 + repereLigne(c).normale.x * c.decalage + n.x * 0.5, z: (c.A.z + c.B.z) / 2 + repereLigne(c).normale.z * c.decalage + n.z * 0.5 };
        etat.image.position.set(m.x, etat.image.userData.hauteur / 2 + (etat.image.userData.bas || 0), m.z);
        etat.image.rotation.set(0, -Math.atan2(u.z, u.x), 0);
      }
    } else if (c.type === 'polyligne') {
      // plan de clipping : celui du segment choisi (une polyligne ne se coupe pas avec des plans globaux)
      const { O, u, L, n } = segmentActif(c, segmentsPoly(c));
      plans.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(n.x, 0, n.z), V3(O)));
      if (c.profondeur > 0) {
        plans.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(-n.x, 0, -n.z), V3({ x: O.x + n.x * c.profondeur, z: O.z + n.z * c.profondeur })));
      }
      const a = { x: O.x - u.x * 10 + n.x * 0.3, z: O.z - u.z * 10 + n.z * 0.3 }, b = { x: O.x + u.x * (L + 10) + n.x * 0.3, z: O.z + u.z * (L + 10) + n.z * 0.3 };
      pts.push(V3(a, 0), V3(b, 0), V3(b, 0), V3(b, 160), V3(b, 160), V3(a, 160), V3(a, 160), V3(a, 0));
    } else {
      const yTop = dz(c.cx, c.cz) + c.hmax;
      const cotes = cotesZone(c);
      for (const s of cotes) plans.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(s.n.x, 0, s.n.z), V3(s.O)));
      plans.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), yTop));
      // arêtes de la boîte, légèrement à l'intérieur
      const k = coinsZone(c).map((p) => ({ x: p.x + (c.cx - p.x) * 0.002, z: p.z + (c.cz - p.z) * 0.002 }));
      for (let i = 0; i < 4; i++) {
        const p = k[i], q = k[(i + 1) % 4];
        pts.push(V3(p, yTop - 0.1), V3(q, yTop - 0.1), V3(p, dz(p.x, p.z) - 3), V3(p, yTop - 0.1));
      }
    }
    voile = sansRayon(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), matVoile));
    voile.userData.pasDeRelief = true;
    app.scene.add(voile);
    app.renderer.clippingPlanes = plans.slice();
    // les faces intérieures des volumes coupés restent visibles là où le poché manque
    for (const m of Object.values(app.materiaux || {})) m.side = THREE.DoubleSide;
    construirePoche(c);
    groupePoche.visible = etat.poche;
    etat.signatureRelief = signatureRelief();
  }

  function activer(id, { cadrer = true } = {}) {
    const c = trouver(id);
    if (!c) return desactiver();
    if (app.vue2D) app.vue.basculer(false);
    majCouleurs();
    etat.actif = id;
    chargerImage(c);
    majPlan();
    majPanneau();
    if (cadrer) cadrerSur(c);
    app.emettre('coupe', id);
  }

  function cadrerSur(c) {
    if (c.type === 'ligne') {
      const { u, L, n, O } = repereLigne(c);
      const milieu = new THREE.Vector3(O.x + u.x * L / 2, 0, O.z + u.z * L / 2);
      const pos = milieu.clone().add(new THREE.Vector3(-n.x, 0, -n.z).multiplyScalar(Math.min(Math.max(L * 0.55, 150), 380))).setY(55);
      allerVers(app, pos.toArray(), milieu.clone().setY(18).toArray(), 1600);
    } else if (c.type === 'polyligne') {
      const xs = c.P.map((p) => p.x), zs = c.P.map((p) => p.z);
      const mx = (Math.min(...xs) + Math.max(...xs)) / 2, mz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      const { n } = segmentActif(c, segmentsPoly(c));
      const d = Math.min(Math.max(ext * 0.7, 150), 420);
      allerVers(app, [mx - n.x * d, 70, mz - n.z * d], [mx, 15, mz], 1600);
    } else {
      const D = Math.max(c.a, c.b) * 0.9 + 80;
      allerVers(app, [c.cx + D * 0.75, D * 0.75, c.cz + D * 0.75], [c.cx, Math.min(c.hmax, 20) / 2, c.cz], 1600);
    }
  }

  function desactiver() {
    quitterVueFace();
    etat.actif = null;
    plans.length = 0;
    if (voile) { app.scene.remove(voile); voile.geometry.dispose(); voile = null; }
    vider(groupePoche);
    if (etat.image) etat.image.visible = false;
    app.renderer.clippingPlanes = [];
    for (const m of Object.values(app.materiaux || {})) m.side = THREE.FrontSide;
    majPanneau();
    app.emettre('coupe', null);
  }

  // Coupe dessinée à la main, posée dans le plan de coupe (coupes prédéfinies avec « image »)
  function chargerImage(c) {
    if (etat.image) { app.scene.remove(etat.image); etat.image.geometry.dispose(); etat.image = null; }
    if (!c.image) return;
    const L = repereLigne(c).L;
    new THREE.TextureLoader().load(`data/coupes/${c.image.fichier}`, (tex) => {
      if (etat.actif !== c.id) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      const l = c.image.longueur || L;
      const hh = c.image.hauteur || (l * tex.image.height) / tex.image.width;
      const m = sansRayon(new THREE.Mesh(
        new THREE.PlaneGeometry(l, hh),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: c.image.opacite ?? 0.85, side: THREE.DoubleSide, depthWrite: false }),
      ));
      m.userData = { hauteur: hh, bas: c.image.bas || 0 };
      m.visible = ui.dessinMain ? ui.dessinMain.checked : true;
      etat.image = m;
      app.scene.add(m);
      majPlan();
    }, undefined, () => app.signaler(`Dessin de coupe introuvable : data/coupes/${c.image.fichier}`));
  }

  // ------------------------------------------------------------
  // Mises à jour : bâti, époque, relief
  // ------------------------------------------------------------
  const signatureRelief = () => `${app.relief?.etat?.actif ? 1 : 0}|${app.relief?.etat?.exageration ?? 1}`;
  function rafraichir() {
    if (etat.actif) majPlan();
    majDessin();
  }
  app.on('bati', rafraichir);
  app.on('etat', rafraichir);
  app.on('topographie', () => majDessin());
  setInterval(() => { if (etat.actif && signatureRelief() !== etat.signatureRelief) majPlan(); }, 1000);
  app.on('couches', () => { groupe.visible = app.couches.axes; });

  // ------------------------------------------------------------
  // Tracé à la souris (app.captureSol, voir interface.js)
  // ------------------------------------------------------------
  function nouvelId() {
    let n = 0;
    for (const c of liste) { const m = /^C(\d+)$/.exec(c.id); if (m) n = Math.max(n, +m[1]); }
    return `C${n + 1}`;
  }
  function zoneDepuis3Points(p1, p2, p3) {
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const u = { x: (p2[0] - p1[0]) / L, z: (p2[1] - p1[1]) / L };
    const w = { x: -u.z, z: u.x };
    const d = (p3[0] - p1[0]) * w.x + (p3[1] - p1[1]) * w.z;
    return {
      cx: p1[0] + u.x * L / 2 + w.x * d / 2, cz: p1[1] + u.z * L / 2 + w.z * d / 2,
      a: Math.round(L), b: Math.max(1, Math.round(Math.abs(d))), rot: Math.round((Math.atan2(-u.z, u.x) * 180) / Math.PI),
    };
  }
  function majApercu(p) {
    vider(apercu);
    const pts = etat.points.slice();
    if (p) pts.push(p);
    if (!pts.length) return;
    let ligne;
    if (etat.trace === 'zone' && pts.length >= 3) {
      const z = zoneDepuis3Points(...pts.slice(0, 3));
      const k = coinsZone({ ...z, a: Math.max(z.a, 1) });
      ligne = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(k.map((q) => new THREE.Vector3(q.x, dz(q.x, q.z) + 0.6, q.z))), matApercu);
    } else {
      ligne = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, dz(x, z) + 0.6, z))), matApercu);
    }
    ligne.computeLineDistances();
    apercu.add(sansRayon(ligne));
  }
  // polyligne : un point par clic ; double-clic (ou « Terminer ») pour finir
  function finirPolyligne() {
    if (etat.trace !== 'polyligne') return;
    const pts = etat.points.filter((q, i, t) => i === 0 || Math.hypot(q[0] - t[i - 1][0], q[1] - t[i - 1][1]) >= 1);
    if (pts.length < 2) { app.signaler('Polyligne : cliquez au moins deux points.'); return; }
    const id = nouvelId();
    const c = { id, nom: `Polyligne ${id}`, type: 'polyligne', visible: true, P: pts.map(([x, z]) => ({ x, z })), inverse: false, profondeur: 0, segment: 0 };
    liste.push(c);
    finirTrace();
    dessinerTraces();
    activer(id, { cadrer: false });
    app.signaler(`Polyligne ${id} tracée (${pts.length} points, ${Math.round(segmentsPoly(c).reduce((a, g) => a + g.L, 0))} m).`);
  }
  app.renderer.domElement.addEventListener('dblclick', () => { if (etat.trace === 'polyligne') finirPolyligne(); });

  function clic(p) {
    if (!p) return;
    if (etat.trace === 'polyligne') {
      const der = etat.points[etat.points.length - 1];
      // second clic d'un double-clic au même endroit : ignoré (le double-clic termine)
      if (!der || Math.hypot(p[0] - der[0], p[1] - der[1]) >= 1) etat.points.push(p);
      majApercu(null);
      consigne();
      return;
    }
    etat.points.push(p);
    const n = etat.points.length;
    if (etat.trace === 'ligne' && n === 2) {
      const [a, b] = etat.points;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 5) { etat.points.pop(); app.signaler('Coupe trop courte : cliquez plus loin.'); return; }
      const id = nouvelId();
      liste.push({ id, nom: `Coupe ${id}`, type: 'ligne', visible: true, A: { x: a[0], z: a[1] }, B: { x: b[0], z: b[1] }, inverse: false, decalage: 0, profondeur: 0 });
      finirTrace();
      dessinerTraces();
      activer(id, { cadrer: false });
      app.signaler(`Coupe ${id} tracée (${Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]))} m).`);
      return;
    }
    if (etat.trace === 'zone' && n === 3) {
      const z = zoneDepuis3Points(...etat.points);
      if (z.a < 5 || z.b < 5) { etat.points.pop(); app.signaler('Zone trop étroite : cliquez plus loin du premier côté.'); return; }
      const id = nouvelId();
      liste.push({ id, nom: `Zone ${id}`, type: 'zone', visible: true, ...z, hmax: BORNES_ZONE.hmax[2] });
      finirTrace();
      dessinerTraces();
      activer(id, { cadrer: false });
      app.signaler(`Zone de coupe ${id} tracée (${z.a} × ${z.b} m).`);
      return;
    }
    majApercu(null);
    consigne();
  }
  function survol(p) { if (p) majApercu(p); }
  function commencerTrace(type) {
    if (etat.trace === type) { finirTrace(); return; }
    if (app.vue2D) app.vue.basculer(false);
    etat.trace = type;
    etat.points = [];
    app.captureSol = clic;
    app.survolCapture = survol;
    consigne();
    majBoutonsTrace();
  }
  function finirTrace() {
    if (app.captureSol === clic) app.captureSol = null;
    if (app.survolCapture === survol) app.survolCapture = null;
    etat.trace = null;
    etat.points = [];
    vider(apercu);
    app.renderer.domElement.style.cursor = '';
    consigne();
    majBoutonsTrace();
  }
  function consigne() {
    if (!ui.consigne?.isConnected) return;
    const n = etat.points.length;
    ui.consigne.textContent = etat.trace === 'ligne' ? (n ? 'Cliquez la seconde extrémité.' : 'Cliquez la première extrémité de la coupe sur le sol.')
      : etat.trace === 'polyligne' ? (n < 2 ? `Cliquez le point ${n + 1} de la polyligne sur le sol.` : `${n} points : cliquez le suivant, double-cliquez ou « Terminer » pour finir.`)
      : etat.trace === 'zone' ? ['Cliquez le premier coin de la zone.', 'Cliquez le second coin du même côté.', 'Cliquez pour donner la largeur de la zone.'][n] || '' : '';
  }
  function majBoutonsTrace() {
    if (!ui.tracerLigne?.isConnected) return;
    ui.tracerLigne.setAttribute('aria-pressed', String(etat.trace === 'ligne'));
    ui.tracerZone.setAttribute('aria-pressed', String(etat.trace === 'zone'));
    ui.tracerPoly.setAttribute('aria-pressed', String(etat.trace === 'polyligne'));
    ui.tracerLigne.textContent = etat.trace === 'ligne' ? 'Annuler le tracé' : 'Tracer une coupe';
    ui.tracerZone.textContent = etat.trace === 'zone' ? 'Annuler le tracé' : 'Tracer une zone';
    ui.tracerPoly.textContent = etat.trace === 'polyligne' ? 'Annuler le tracé' : 'Tracer une polyligne';
    ui.terminerPoly.hidden = etat.trace !== 'polyligne';
  }
  app.on('outil', (id) => {
    if (id === 'coupes') return;
    if (etat.trace) finirTrace();
    if (app.captureSol === deplacer) app.captureSol = null;
    if (app.captureSol?.pointPoly != null) app.captureSol = null;
    quitterVueFace();
  });

  // déplacement d'une zone ou d'une coupe libre : un clic au sol donne le nouveau centre
  function deplacer(p) {
    const c = trouver(etat.actif);
    if (app.captureSol === deplacer) app.captureSol = null;
    if (ui.deplacer?.isConnected) ui.deplacer.setAttribute('aria-pressed', 'false');
    if (!c || !p) return;
    if (c.type === 'zone') { c.cx = p[0]; c.cz = p[1]; } else if (c.type === 'polyligne') {
      const mx = c.P.reduce((a, q) => a + q.x, 0) / c.P.length, mz = c.P.reduce((a, q) => a + q.z, 0) / c.P.length;
      for (const q of c.P) { q.x += p[0] - mx; q.z += p[1] - mz; }
    } else {
      const mx = (c.A.x + c.B.x) / 2, mz = (c.A.z + c.B.z) / 2;
      for (const q of [c.A, c.B]) { q.x += p[0] - mx; q.z += p[1] - mz; }
    }
    dessinerTraces();
    majPlan();
    majPanneau();
  }

  // édition des points d'une polyligne : déplacer (clic au sol), supprimer, insérer
  function editerPoint(c, k, action) {
    if (action === 'deplacer') {
      finirTrace();
      const f = (p) => {
        if (app.captureSol === f) app.captureSol = null;
        if (!p) return;
        c.P[k] = { x: p[0], z: p[1] };
        dessinerTraces(); majPlan(); majPanneau();
      };
      f.pointPoly = k;
      app.captureSol = f;
      app.signaler(`Cliquez le sol : nouvelle position du point ${k + 1}.`);
      return;
    }
    if (action === 'supprimer') {
      if (c.P.length <= 2) { app.signaler('Une polyligne garde au moins deux points.'); return; }
      c.P.splice(k, 1);
    } else if (action === 'inserer') {
      const a = c.P[k], b = c.P[k + 1];
      if (b) c.P.splice(k + 1, 0, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      else {
        const q = c.P[k - 1] || { x: a.x - 10, z: a.z };
        const L = Math.hypot(a.x - q.x, a.z - q.z) || 1;
        c.P.push({ x: a.x + ((a.x - q.x) / L) * 20, z: a.z + ((a.z - q.z) / L) * 20 });
      }
    }
    c.segment = Math.min(c.segment || 0, c.P.length - 2);
    dessinerTraces(); majPlan(); majPanneau();
  }

  // ------------------------------------------------------------
  // Vue de face : caméra orthographique parallèle au plan de coupe (élévation), retour à la vue précédente
  // ------------------------------------------------------------
  function vueFace() {
    const c = trouver(etat.actif);
    if (!c || c.type === 'zone') return;
    if (etat.face) quitterVueFace();
    if (app.vue2D) app.vue.basculer(false);
    const { O, u, L, n } = c.type === 'ligne' ? repereLigne(c) : segmentActif(c, segmentsPoly(c));
    const centre = { x: O.x + u.x * L / 2, z: O.z + u.z * L / 2 };
    const y0 = dz(centre.x, centre.z);
    // hauteur du bâti coupé ou proche du plan
    let hMax = 25;
    for (const e of batiVisible()) {
      const d = (e.cx - O.x) * n.x + (e.cz - O.z) * n.z, t = (e.cx - O.x) * u.x + (e.cz - O.z) * u.z;
      if (d > -20 && d < 120 && t > -20 && t < L + 20) hMax = Math.max(hMax, dz(e.cx, e.cz) - y0 + e.hauteur);
    }
    const largeur = Math.min(L, 900) + 30, hauteur = hMax + 12;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 5000);
    const cadrer = () => {
      const a = window.innerWidth / window.innerHeight;
      const demi = Math.max(hauteur / 2, largeur / 2 / a) * 1.04;
      Object.assign(cam, { left: -demi * a, right: demi * a, top: demi, bottom: -demi });
      cam.updateProjectionMatrix();
    };
    cadrer();
    const cible = new THREE.Vector3(centre.x, y0 + hauteur / 2 - 4, centre.z);
    cam.position.set(centre.x - n.x * 600, cible.y, centre.z - n.z * 600);
    cam.up.set(0, 1, 0);
    cam.lookAt(cible);
    const ctl = new OrbitControls(cam, app.renderer.domElement);
    ctl.enableRotate = false;
    ctl.screenSpacePanning = true;
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.1;
    ctl.minZoom = 0.2;
    ctl.maxZoom = 30;
    ctl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    ctl.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    ctl.target.copy(cible);
    ctl.update();
    app.animationCamera = null;
    etat.face = { cam, ctl, cadrer, camera: app.camera, controls: app.controls, coupe: c.id };
    app.controls.enabled = false;
    app.camera = cam;
    app.controls = ctl;
    window.addEventListener('resize', cadrer);
    document.body.classList.add('vue-face');
    majPanneau();
    app.signaler(`Vue de face de la coupe ${c.id} : projection orthographique, glisser pour se déplacer, molette pour zoomer.`);
  }
  function quitterVueFace() {
    const f = etat.face;
    if (!f) return;
    etat.face = null;
    window.removeEventListener('resize', f.cadrer);
    f.ctl.dispose();
    app.camera = f.camera;
    app.controls = f.controls;
    app.controls.enabled = true;
    app.controls.update();
    document.body.classList.remove('vue-face');
    majPanneau();
  }

  // ------------------------------------------------------------
  // Modèle du dessin 2D d'une coupe linéaire (mètres, altitudes NGF si le relief est chargé)
  // ------------------------------------------------------------
  function modele(c) {
    const segs = segmentsCoupe(c);
    const L = segs.reduce((acc, g) => acc + g.L, 0);
    const topo = app.topo?.disponible ? app.topo : null;
    const h0 = topo && Number.isFinite(topo.etat?.h0) ? topo.etat.h0 : 0;
    const alt = (x, z) => { const a = topo ? topo.altitude(x, z) : NaN; return Number.isFinite(a) ? a : h0; };
    // abscisse s de gauche à droite pour l'observateur (regard selon n) : droite = n × haut ;
    // polyligne : le même côté pour tous les segments, déroulés bout à bout
    const n = segs[0].n;
    const r = { x: -n.z, z: n.x };
    const sens = r.x * segs[0].u.x + r.z * segs[0].u.z > 0 ? 1 : -1;
    const profil = [], sections = [], elevations = [], facades = [], plis = [];
    const D = c.profondeur > 0 ? c.profondeur : PROF_DESSIN;
    const bati = batiVisible();
    const listeFacades = (app.toits?.ensembles || []).flatMap((ens) => (ens.facades?.facades || []).map((f) => ({ f, href: `data/facades/${ens.id}/${f.image}` })));
    for (const sg of segs) {
      const { O, u, n: ns, cum } = sg;
      const Ls = sg.L;
      const S = (t) => (sens > 0 ? cum + t : L - cum - t);
      const nP = Math.max(2, Math.ceil(Ls / 2));
      for (let i = 0; i <= nP; i++) { const t = (Ls * i) / nP; profil.push([S(t), alt(O.x + u.x * t, O.z + u.z * t)]); }
      if (cum > 0) plis.push({ s: S(0), label: String(sg.i + 1) });
      for (const e of bati) {
        const g = alt(e.cx, e.cz);
        const z0 = g + (e.base || 0), z1 = g + e.hauteur;
        const iv = intervalles(O, u, e.polys, 0, Ls);
        if (iv.length) {
          for (const [a2, b2] of iv) sections.push({ s0: Math.min(S(a2), S(b2)), s1: Math.max(S(a2), S(b2)), z0, z1, sol: g, h: e.hauteur, projet: !!e.projet, nom: e.nom || null });
          continue;
        }
        // élévation : volume situé derrière le plan, à moins de D mètres
        let dMin = Infinity, dMax = -Infinity, tMin = Infinity, tMax = -Infinity;
        for (const [x, z] of e.polys[0][0]) {
          const d = (x - O.x) * ns.x + (z - O.z) * ns.z, t = (x - O.x) * u.x + (z - O.z) * u.z;
          dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
        }
        if (dMax <= 0 || dMin > D) continue;
        const a2 = Math.max(tMin, 0), b2 = Math.min(tMax, Ls);
        if (b2 - a2 < 0.3) continue;
        elevations.push({ s0: Math.min(S(a2), S(b2)), s1: Math.max(S(a2), S(b2)), z0, z1, d: Math.max(dMin, 0), projet: !!e.projet });
      }
      // photos de façade (data/facades/) tournées vers l'observateur, derrière le plan, à moins de D mètres
      for (const { f, href } of listeFacades) {
        if (!f.image || !(f.hauteur_m > 0) || !f.gauche || !f.droite) continue;
        const az = (f.normale_az * Math.PI) / 180;
        if (Math.sin(az) * ns.x - Math.cos(az) * ns.z > -0.5) continue;
        const d0 = (f.gauche[0] - O.x) * ns.x + (f.gauche[1] - O.z) * ns.z, d1 = (f.droite[0] - O.x) * ns.x + (f.droite[1] - O.z) * ns.z;
        if (Math.max(d0, d1) <= 0 || Math.min(d0, d1) > D) continue;
        const t0 = (f.gauche[0] - O.x) * u.x + (f.gauche[1] - O.z) * u.z, t1 = (f.droite[0] - O.x) * u.x + (f.droite[1] - O.z) * u.z;
        if (Math.max(t0, t1) < 0 || Math.min(t0, t1) > Ls) continue;
        const g = alt((f.gauche[0] + f.droite[0]) / 2, (f.gauche[1] + f.droite[1]) / 2);
        facades.push({ sG: S(t0), sD: S(t1), z0: g, z1: g + f.hauteur_m, d: Math.max((d0 + d1) / 2, 0), href, id: f.id });
      }
    }
    profil.sort((a2, b2) => a2[0] - b2[0]);
    elevations.sort((p2, q) => q.d - p2.d); // du plus loin au plus proche
    const zs = [...profil.map((p2) => p2[1]), ...sections.map((x) => x.z1), ...elevations.map((x) => x.z1)];
    const zSol = Math.min(...profil.map((p2) => p2[1]));
    // cotes : les volumes coupés les plus hauts (un par bâtiment, largeur d'au moins 3 m)
    const parBat = new Map();
    for (const x of sections) { const k = `${x.z0}|${x.z1}|${x.projet}`; const p2 = parBat.get(k); if (!p2 || x.s1 - x.s0 > p2.s1 - p2.s0) parBat.set(k, x); }
    const cotes = [...parBat.values()].filter((x) => x.s1 - x.s0 >= 3).sort((p2, q) => q.h - p2.h).slice(0, 8);
    const azimut = ((Math.atan2(n.x, -n.z) * 180) / Math.PI + 360) % 360;
    return {
      id: c.id, nom: c.nom, L, sens, profil, sections, elevations, facades, plis, cotes, D, azimut, n,
      polyligne: c.type === 'polyligne', segments: segs.length,
      zMin: Math.floor(zSol) - 4, zMax: Math.ceil(Math.max(...zs, zSol + 10)) + 6, ngf: !!topo,
      gauche: sens > 0 ? c.id : `${c.id}′`, droite: sens > 0 ? `${c.id}′` : c.id,
    };
  }

  const POINTS_CARDINAUX = ['nord', 'nord-nord-est', 'nord-est', 'est-nord-est', 'est', 'est-sud-est', 'sud-est', 'sud-sud-est', 'sud', 'sud-sud-ouest', 'sud-ouest', 'ouest-sud-ouest', 'ouest', 'ouest-nord-ouest', 'nord-ouest', 'nord-nord-ouest'];
  const direction = (az) => POINTS_CARDINAUX[Math.round(az / 22.5) % 16];
  const vers = (az) => { const d = direction(az); return /^[eo]/.test(d) ? `vers l'${d}` : `vers le ${d}`; };
  function pasEchelle(L) { return [2, 5, 10, 20, 25, 50, 100, 200].find((p) => p * 4 >= L / 5) || 200; }

  // SVG autonome (couleurs explicites, pour l'export comme pour le panneau)
  // grand : largeur adaptée pour que la hauteur dessinée fasse au moins 380 px (agrandissement, export)
  // opts : { couleurs (défaut etat.couleurs), images (href -> data: URI pour l'export) }
  function svgCoupe(M, grand = false, opts = {}) {
    const couleurs = opts.couleurs ?? etat.couleurs;
    const images = opts.images || null;
    const C = couleurs
      ? { bati: TEINTES.bati, projet: TEINTES.projet, sol: TEINTES.sol, solTrait: TEINTES.solTrait, fond: TEINTES.ciel }
      : { bati: ENCRE.bati, projet: ENCRE.projet, sol: ENCRE.sol, solTrait: ENCRE.solTrait, fond: ENCRE.papier };
    // teinte d'une élévation : plus claire avec la distance au plan
    const melange = (hex, k) => { const v = parseInt(hex.slice(1), 16); const m = (c2) => Math.round(c2 + (255 - c2) * k); return `rgb(${m(v >> 16)},${m((v >> 8) & 255)},${m(v & 255)})`; };
    const ml = 64, mr = 24, mt = 54, mb = 74;
    const W = grand ? Math.round(Math.max(1000, Math.min(3000, ml + mr + (M.L * 380) / (M.zMax - M.zMin)))) : 1000;
    const k = Math.min((W - ml - mr) / M.L, 700 / (M.zMax - M.zMin));
    const H = Math.round(mt + mb + (M.zMax - M.zMin) * k);
    const X = (s) => (ml + s * k).toFixed(1), Y = (z) => (mt + (M.zMax - z) * k).toFixed(1);
    const police = 'font-family="Plex Cond, Arial Narrow, Roboto Condensed, sans-serif"';
    const o = [];
    o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Coupe ${echapper(M.id)}">`);
    o.push(`<rect width="${W}" height="${H}" fill="${ENCRE.papier}"/>`);
    if (couleurs) o.push(`<rect x="${ml}" y="${mt}" width="${(M.L * k).toFixed(1)}" height="${((M.zMax - M.zMin) * k).toFixed(1)}" fill="${C.fond}"/>`);
    o.push(`<g ${police} font-size="13" fill="${ENCRE.bati}"><text x="${ml}" y="22" font-size="17" font-weight="600">Coupe ${echapper(M.gauche)}–${echapper(M.droite)} · ${echapper(M.nom)}${M.polyligne ? ` (polyligne, ${M.segments} segments déroulés)` : ''}</text>`);
    o.push(`<text x="${ml}" y="40" fill="${ENCRE.trait}">Altitudes ${M.ngf ? 'NGF' : 'relatives (relief non chargé)'} en mètres, hauteurs vraies · élévations jusqu'à ${Math.round(M.D)} m derrière le plan${couleurs && M.facades.length ? ' · photos de façade' : ''}</text></g>`);
    // élévations et photos de façade (du plus loin au plus proche), découpées au cadre du dessin
    const idCadre = `cadre-${String(M.id).replace(/[^\w-]/g, '')}-${W}-${H}`;
    o.push(`<defs><clipPath id="${idCadre}"><rect x="${ml}" y="0" width="${(M.L * k).toFixed(1)}" height="${H}"/></clipPath></defs>`);
    o.push(`<g stroke-width="0.7" clip-path="url(#${idCadre})">`);
    const vues = [...M.elevations.map((e) => ({ ...e, type: 'elev' })), ...(couleurs ? M.facades.map((f) => ({ ...f, type: 'photo' })) : [])].sort((p, q) => q.d - p.d);
    for (const e of vues) {
      if (e.type === 'elev') {
        const fill = couleurs ? melange(e.projet ? TEINTES.elevationProjet : TEINTES.elevation, Math.min(0.75, e.d / (M.D * 1.3))) : ENCRE.papier;
        o.push(`<rect x="${X(e.s0)}" y="${Y(e.z1)}" width="${((e.s1 - e.s0) * k).toFixed(1)}" height="${((e.z1 - e.z0) * k).toFixed(1)}" fill="${fill}" stroke="${e.projet ? ENCRE.projet : couleurs ? TEINTES.elevationTrait : ENCRE.trait}"/>`);
      } else {
        const s0 = Math.min(e.sG, e.sD), w = Math.abs(e.sD - e.sG) * k, hgt = (e.z1 - e.z0) * k;
        const href = images?.get(e.href) || e.href;
        const miroir = e.sG > e.sD ? ` transform="translate(${(2 * +X(s0) + w).toFixed(1)} 0) scale(-1 1)"` : '';
        o.push(`<image href="${echapper(href)}" x="${X(s0)}" y="${Y(e.z1)}" width="${w.toFixed(1)}" height="${hgt.toFixed(1)}" preserveAspectRatio="none" opacity="${(1 - Math.min(0.4, e.d / (M.D * 2))).toFixed(2)}"${miroir}><title>Façade ${echapper(e.id)}</title></image>`);
      }
    }
    o.push('</g>');
    // sol coupé
    const bas = M.zMin;
    o.push(`<path d="M${X(M.profil[0][0])},${Y(bas)} ${M.profil.map(([s, z]) => `L${X(s)},${Y(z)}`).join(' ')} L${X(M.profil[M.profil.length - 1][0])},${Y(bas)} Z" fill="${C.sol}" stroke="none"/>`);
    o.push(`<path d="M${M.profil.map(([s, z]) => `${X(s)},${Y(z)}`).join(' L')}" fill="none" stroke="${C.solTrait}" stroke-width="1.6"/>`);
    // sections pochées
    for (const x of M.sections) o.push(`<rect x="${X(x.s0)}" y="${Y(x.z1)}" width="${((x.s1 - x.s0) * k).toFixed(1)}" height="${((x.z1 - x.z0) * k).toFixed(1)}" fill="${x.projet ? C.projet : C.bati}"/>`);
    // plis de la polyligne (sommets intérieurs), numérotés
    for (const pl of M.plis) {
      o.push(`<g ${police}><line x1="${X(pl.s)}" y1="${Y(M.zMax)}" x2="${X(pl.s)}" y2="${Y(M.zMin)}" stroke="${ENCRE.coupe}" stroke-width="0.7" stroke-dasharray="2 4"/><text x="${X(pl.s)}" y="${(+Y(M.zMax) - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="${ENCRE.coupe}">${echapper(pl.label)}</text></g>`);
    }
    // règle des niveaux à gauche
    const pasN = M.zMax - M.zMin > 60 ? 10 : 5;
    o.push(`<g ${police} font-size="10" fill="${ENCRE.trait}" stroke="${ENCRE.trait}" stroke-width="0.6"><line x1="${ml - 8}" y1="${Y(M.zMax)}" x2="${ml - 8}" y2="${Y(M.zMin)}"/>`);
    for (let z = Math.ceil(M.zMin / pasN) * pasN; z <= M.zMax; z += pasN) o.push(`<line x1="${ml - 12}" y1="${Y(z)}" x2="${ml - 8}" y2="${Y(z)}"/><text x="${ml - 14}" y="${(+Y(z) + 3).toFixed(1)}" text-anchor="end" stroke="none">${z}</text>`);
    o.push('</g>');
    // cotes de hauteur
    o.push(`<g ${police} font-size="11" fill="${ENCRE.bati}" stroke="${ENCRE.bati}" stroke-width="0.7">`);
    const poses = [];
    for (const x of M.cotes) {
      const cx = Math.max(ml + 24, (+X(x.s0) + +X(x.s1)) / 2).toFixed(1);
      // pas de cote qui en chevauche une autre
      if (poses.some(([a, b]) => Math.abs(a - cx) < 64 && Math.abs(b - +Y(x.z1)) < 30)) continue;
      poses.push([+cx, +Y(x.z1)]);
      o.push(`<text x="${cx}" y="${(+Y(x.z1) - 6).toFixed(1)}" text-anchor="middle" stroke="none">${fmt(x.h)} m</text>`);
      o.push(`<text x="${cx}" y="${(+Y(x.z1) - 19).toFixed(1)}" text-anchor="middle" stroke="none" font-size="9" fill="${ENCRE.trait}">▽ ${fmt(x.z1)}</text>`);
    }
    // terrain aux extrémités
    const [sa, za] = M.profil[0], [sb, zb] = M.profil[M.profil.length - 1];
    o.push(`<text x="${(+X(sa) + 4).toFixed(1)}" y="${(+Y(za) + 16).toFixed(1)}" stroke="none" font-size="10">TN ${fmt(za)}</text><text x="${(+X(sb) - 4).toFixed(1)}" y="${(+Y(zb) + 16).toFixed(1)}" text-anchor="end" stroke="none" font-size="10">TN ${fmt(zb)}</text>`);
    o.push('</g>');
    // repères des extrémités
    const yRep = H - mb + 18;
    for (const [s, t] of [[0, M.gauche], [M.L, M.droite]]) {
      o.push(`<g ${police}><line x1="${X(s)}" y1="${Y(M.zMax)}" x2="${X(s)}" y2="${yRep - 10}" stroke="${ENCRE.coupe}" stroke-width="0.8" stroke-dasharray="4 3"/><circle cx="${X(s)}" cy="${yRep}" r="10" fill="${ENCRE.coupe}"/><text x="${X(s)}" y="${yRep + 4}" text-anchor="middle" font-size="12" fill="#fff">${echapper(t)}</text></g>`);
    }
    // échelle graphique
    const p = pasEchelle(M.L);
    const ye = H - 22;
    o.push(`<g ${police} font-size="10" fill="${ENCRE.bati}">`);
    for (let i = 0; i < 4; i++) o.push(`<rect x="${(ml + 30 + i * p * k).toFixed(1)}" y="${ye - 6}" width="${(p * k).toFixed(1)}" height="5" fill="${i % 2 ? ENCRE.papier : ENCRE.bati}" stroke="${ENCRE.bati}" stroke-width="0.7"/>`);
    for (let i = 0; i <= 4; i++) o.push(`<text x="${(ml + 30 + i * p * k).toFixed(1)}" y="${ye + 10}" text-anchor="middle">${i * p}${i === 4 ? ' m' : ''}</text>`);
    // sens de la vue : petit plan, nord en haut
    const ox = W - mr - 220, oy = ye - 6;
    const fx = (M.n.x * 12).toFixed(1), fy = (M.n.z * 12).toFixed(1);
    o.push(`<circle cx="${ox}" cy="${oy}" r="13" fill="none" stroke="${ENCRE.trait}" stroke-width="0.7"/><text x="${ox}" y="${oy - 16}" text-anchor="middle" font-size="9">N</text>`);
    o.push(`<line x1="${ox}" y1="${oy}" x2="${(ox + +fx).toFixed(1)}" y2="${(oy + +fy).toFixed(1)}" stroke="${ENCRE.coupe}" stroke-width="2"/><circle cx="${(ox + +fx).toFixed(1)}" cy="${(oy + +fy).toFixed(1)}" r="2.5" fill="${ENCRE.coupe}"/>`);
    o.push(`<text x="${ox + 20}" y="${oy + 4}">regard ${vers(M.azimut)} (${Math.round(M.azimut)}°)</text></g>`);
    // légende
    const lg = [[C.bati, 'bâti coupé'], [C.projet, 'projet'], [C.sol, 'sol']];
    o.push(`<g ${police} font-size="10" fill="${ENCRE.bati}">`);
    lg.forEach(([coul, t], i) => o.push(`<rect x="${ox - 250 + i * 72}" y="${ye - 10}" width="10" height="10" fill="${coul}"/><text x="${ox - 236 + i * 72}" y="${ye - 1}">${t}</text>`));
    o.push('</g></svg>');
    return o.join('');
  }

  // DXF R12 : X = abscisse le long de la coupe, Y = altitude, en mètres
  function dxfCoupe(M) {
    const out = [];
    const g = (code, val) => out.push(String(code), String(val));
    const t = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
    const f = (v) => v.toFixed(3);
    const E = [];
    const poly = (calque, pts, ferme = false) => E.push({ type: 'poly', calque, pts, ferme });
    const solide = (calque, p1, p2, p3, p4) => E.push({ type: 'solid', calque, pts: [p1, p2, p3, p4] });
    const texte = (calque, x, y, txt, hauteur = 1.2, centre = true) => E.push({ type: 'texte', calque, x, y, texte: txt, hauteur, centre });
    const ligne = (calque, a, b) => E.push({ type: 'ligne', calque, pts: [a, b] });
    // sol : profil, contour et remplissage (trapèzes)
    const bas = M.zMin;
    poly('COUPE_SOL', M.profil);
    poly('COUPE_SOL', [[M.profil[0][0], bas], ...M.profil, [M.profil[M.profil.length - 1][0], bas]], true);
    for (let i = 0; i + 1 < M.profil.length; i++) {
      const [s0, z0] = M.profil[i], [s1, z1] = M.profil[i + 1];
      solide('COUPE_SOL', [s0, bas], [s1, bas], [s0, z0], [s1, z1]);
    }
    for (const x of M.sections) {
      const c = x.projet ? 'COUPE_PROJET' : 'COUPE_BATI';
      poly(c, [[x.s0, x.z0], [x.s1, x.z0], [x.s1, x.z1], [x.s0, x.z1]], true);
      solide(c, [x.s0, x.z0], [x.s1, x.z0], [x.s0, x.z1], [x.s1, x.z1]);
    }
    for (const e of M.elevations) poly('ELEVATION', [[e.s0, e.z0], [e.s1, e.z0], [e.s1, e.z1], [e.s0, e.z1]], true);
    for (const pl of M.plis || []) { ligne('PLIS', [pl.s, M.zMin], [pl.s, M.zMax]); texte('PLIS', pl.s, M.zMax + 1.5, `pli ${pl.label}`, 1.2); }
    for (const x of M.cotes) {
      const s = (x.s0 + x.s1) / 2;
      ligne('COTES', [s, x.sol], [s, x.z1]);
      ligne('COTES', [s - 0.8, x.z1], [s + 0.8, x.z1]);
      ligne('COTES', [s - 0.8, x.sol], [s + 0.8, x.sol]);
      texte('COTES', s, x.z1 + 1.5, `h ${fmt(x.h)} m / ${fmt(x.z1)} NGF`, 1.2);
    }
    const [sa, za] = M.profil[0], [sb, zb] = M.profil[M.profil.length - 1];
    texte('COTES', sa, za - 2.5, `TN ${fmt(za)}`, 1.2);
    texte('COTES', sb, zb - 2.5, `TN ${fmt(zb)}`, 1.2);
    texte('COTES', 0, M.zMin - 4, M.gauche, 3);
    texte('COTES', M.L, M.zMin - 4, M.droite, 3);
    texte('COTES', 0, M.zMax + 4, `Coupe ${M.gauche}-${M.droite} : ${M.nom} (regard ${Math.round(M.azimut)} deg depuis le nord)`, 2.5, false);
    // échelle graphique
    const p = pasEchelle(M.L), ye = M.zMin - 9;
    for (let i = 0; i < 4; i++) {
      poly('COTES', [[i * p, ye], [(i + 1) * p, ye], [(i + 1) * p, ye + 1], [i * p, ye + 1]], true);
      if (i % 2 === 0) solide('COTES', [i * p, ye], [(i + 1) * p, ye], [i * p, ye + 1], [(i + 1) * p, ye + 1]);
    }
    for (let i = 0; i <= 4; i++) texte('COTES', i * p, ye - 2, `${i * p}`, 1.2);

    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const e of E) for (const [x, y] of e.pts || [[e.x, e.y]]) { xmin = Math.min(xmin, x); ymin = Math.min(ymin, y); xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); }
    g(999, t(`Atlas HDV - coupe ${M.id} - unites : metres - X le long de la coupe depuis ${M.gauche}, Y altitude ${M.ngf ? 'NGF' : 'relative'}`));
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$EXTMIN'); g(10, f(xmin)); g(20, f(ymin)); g(30, 0);
    g(9, '$EXTMAX'); g(10, f(xmax)); g(20, f(ymax)); g(30, 0);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, Object.keys(CALQUES).length);
    for (const [nom, coul] of Object.entries(CALQUES)) { g(0, 'LAYER'); g(2, nom); g(70, 0); g(62, coul); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const e of E) {
      if (e.type === 'poly') {
        g(0, 'POLYLINE'); g(8, e.calque); g(66, 1); g(70, e.ferme ? 1 : 0); g(10, 0); g(20, 0); g(30, 0);
        for (const [x, y] of e.pts) { g(0, 'VERTEX'); g(8, e.calque); g(10, f(x)); g(20, f(y)); g(30, 0); }
        g(0, 'SEQEND'); g(8, e.calque);
      } else if (e.type === 'solid') {
        g(0, 'SOLID'); g(8, e.calque);
        e.pts.forEach(([x, y], i) => { g(10 + i, f(x)); g(20 + i, f(y)); g(30 + i, 0); });
      } else if (e.type === 'ligne') {
        g(0, 'LINE'); g(8, e.calque); g(10, f(e.pts[0][0])); g(20, f(e.pts[0][1])); g(30, 0); g(11, f(e.pts[1][0])); g(21, f(e.pts[1][1])); g(31, 0);
      } else if (e.type === 'texte') {
        g(0, 'TEXT'); g(8, e.calque); g(10, f(e.x)); g(20, f(e.y)); g(30, 0); g(40, e.hauteur); g(1, t(e.texte));
        if (e.centre) { g(72, 1); g(11, f(e.x)); g(21, f(e.y)); g(31, 0); }
      }
    }
    g(0, 'ENDSEC');
    g(0, 'EOF');
    return out.join('\r\n');
  }

  // coupe linéaire ou polyligne (les seules qui ont un dessin 2D)
  const coupeLigne = (id) => { const c = trouver(id ?? etat.actif); return c?.type === 'ligne' || c?.type === 'polyligne' ? c : null; };
  // images des façades embarquées dans le SVG exporté (data: URI), sinon le fichier perdrait ses photos
  async function imagesEmbarquees(M) {
    const res = new Map();
    if (!etat.couleurs) return res;
    for (const href of new Set(M.facades.map((f) => f.href))) {
      try {
        const r2 = await fetch(href);
        if (!r2.ok) continue;
        const blob = await r2.blob();
        res.set(href, await new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ko; fr.readAsDataURL(blob); }));
      } catch { /* image absente : la façade reste en teinte */ }
    }
    return res;
  }
  async function exporterSVG(id) {
    const c = coupeLigne(id);
    if (!c) { app.signaler('Choisissez une coupe linéaire ou une polyligne.'); return null; }
    majCouleurs();
    const M = modele(c);
    const svg = svgCoupe(M, true, { images: await imagesEmbarquees(M) });
    telecharger(`atlas-hdv-coupe-${c.id}-${horodatage()}.svg`, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, 'image/svg+xml');
    app.signaler(`Coupe ${c.id} exportée en SVG.`);
    return svg;
  }
  function exporterDXF(id) {
    const c = coupeLigne(id);
    if (!c) { app.signaler('Choisissez une coupe linéaire ou une polyligne.'); return null; }
    const M = modele(c);
    const dxf = dxfCoupe(M);
    telecharger(`atlas-hdv-coupe-${c.id}-${horodatage()}.dxf`, dxf, 'application/dxf');
    app.signaler(`Coupe ${c.id} exportée en DXF (${M.sections.length} sections, ${M.elevations.length} élévations).`);
    return dxf;
  }

  // ------------------------------------------------------------
  // Enregistrement (data/coupes.json)
  // ------------------------------------------------------------
  const geo = (p) => { const g = app.proj.versGeo(p.x, p.z); return [+g.lat.toFixed(7), +g.lon.toFixed(7)]; };
  function serialiser() {
    return {
      description: 'Coupes de l\'atlas (outil Coupes). Prédéfinies (config.json > axes) : réglages seulement. Libres : extrémités ou centre en WGS84 [lat, lon], dimensions en mètres, rotation en degrés (sens trigonométrique, nord en haut), hmax = hauteur de la boîte au-dessus du sol. Polylignes : points en WGS84, segment = segment du plan de coupe 3D.',
      coupes: liste.map((c) => {
        const base = { id: c.id, nom: c.nom, type: c.type, visible: c.visible };
        if (c.predefinie) return { ...base, predefinie: true, inverse: c.inverse, decalage: c.decalage, profondeur: c.profondeur };
        if (c.type === 'ligne') return { ...base, de: geo(c.A), a: geo(c.B), inverse: c.inverse, decalage: c.decalage, profondeur: c.profondeur };
        if (c.type === 'polyligne') return { ...base, points: c.P.map(geo), inverse: c.inverse, profondeur: c.profondeur, segment: c.segment || 0 };
        return { ...base, centre: geo({ x: c.cx, z: c.cz }), longueur: c.a, largeur: c.b, rot: c.rot, hmax: c.hmax };
      }),
    };
  }
  function lire(d) {
    if (!d || !Array.isArray(d.coupes)) return;
    for (const x of d.coupes) {
      if (!x?.id) continue;
      const commun = { nom: String(x.nom || x.id), visible: x.visible !== false };
      const reglages = { inverse: !!x.inverse, decalage: Math.max(-200, Math.min(200, +x.decalage || 0)), profondeur: Math.max(0, Math.min(500, +x.profondeur || 0)) };
      const ex = trouver(String(x.id));
      if (ex?.predefinie) { Object.assign(ex, commun, reglages); continue; }
      if (ex) continue;
      if (x.type === 'ligne' && Array.isArray(x.de) && Array.isArray(x.a)) {
        const A = app.proj.versLocal(x.de[0], x.de[1]), B = app.proj.versLocal(x.a[0], x.a[1]);
        if (Math.hypot(B.x - A.x, B.z - A.z) < 1) continue;
        liste.push({ id: String(x.id), type: 'ligne', ...commun, ...reglages, A: { x: A.x, z: A.z }, B: { x: B.x, z: B.z } });
      } else if (x.type === 'polyligne' && Array.isArray(x.points) && x.points.length >= 2) {
        const P = x.points.filter((q) => Array.isArray(q)).map((q) => { const l = app.proj.versLocal(q[0], q[1]); return { x: l.x, z: l.z }; });
        if (P.length < 2) continue;
        liste.push({ id: String(x.id), type: 'polyligne', ...commun, inverse: reglages.inverse, profondeur: reglages.profondeur, P, segment: Math.max(0, Math.min(P.length - 2, +x.segment || 0)) });
      } else if (x.type === 'zone' && Array.isArray(x.centre)) {
        const p = app.proj.versLocal(x.centre[0], x.centre[1]);
        liste.push({ id: String(x.id), type: 'zone', ...commun, cx: p.x, cz: p.z, a: borner(x.longueur, BORNES_ZONE.a), b: borner(x.largeur, BORNES_ZONE.b), rot: borner(x.rot, BORNES_ZONE.rot), hmax: borner(x.hmax, BORNES_ZONE.hmax) });
      }
    }
  }
  async function charger() {
    lire(await chargerJSON('data/coupes.json', null));
    etat.pret = true;
    dessinerTraces();
    majPanneau();
  }
  function enregistrer() {
    return enregistrerDonnees('coupes.json', JSON.stringify(serialiser(), null, 2), { apres: 'relu à la prochaine ouverture' });
  }

  function supprimer(id) {
    const i = liste.findIndex((c) => c.id === id);
    if (i < 0 || liste[i].predefinie) return;
    if (etat.actif === id) desactiver();
    liste.splice(i, 1);
    dessinerTraces();
    majPanneau();
  }
  function renommer(id, nom) {
    const c = trouver(id);
    if (!c || !nom.trim()) return;
    c.nom = nom.trim().slice(0, 80);
    majPanneau();
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function ligneListe(c) {
    const actif = etat.actif === c.id;
    const nom = h('span', {}, c.nom);
    const choisir = h('button', { type: 'button', class: 'choisir', 'aria-pressed': String(actif), title: actif ? 'Refermer la coupe' : 'Activer la coupe', onclick: () => (actif ? desactiver() : activer(c.id)) },
      h('b', {}, c.id), nom, c.provisoire ? h('em', {}, 'extrémités à vérifier') : null);
    const li = h('li', { class: actif ? 'actif' : '', 'data-coupe': c.id },
      h('input', { type: 'checkbox', checked: c.visible, title: 'Afficher le tracé', 'aria-label': `Afficher le tracé de ${c.id}`, onchange: (e) => { c.visible = e.target.checked; dessinerTraces(); } }),
      choisir,
      h('span', { class: 'type' }, { ligne: 'coupe', polyligne: 'polyligne', zone: 'zone' }[c.type] || c.type),
      h('button', { type: 'button', class: 'bouton discret petit', title: 'Renommer', 'aria-label': `Renommer ${c.id}`, onclick: () => {
        const champ = h('input', { type: 'text', value: c.nom, 'aria-label': `Nom de ${c.id}`, class: 'nom-coupe' });
        let fait = false;
        const valider = () => { if (fait) return; fait = true; renommer(c.id, champ.value); if (!champ.value.trim()) majPanneau(); };
        champ.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') valider(); if (e.key === 'Escape') { fait = true; majPanneau(); } });
        champ.addEventListener('blur', valider);
        choisir.replaceWith(champ);
        champ.focus();
        champ.select();
      } }, '✎'),
      h('button', { type: 'button', class: 'bouton discret petit', title: c.predefinie ? 'Coupe prédéfinie (config.json)' : 'Supprimer', 'aria-label': `Supprimer ${c.id}`, disabled: !!c.predefinie, onclick: () => supprimer(c.id) }, '×'),
    );
    return li;
  }

  function champNombre(libelle, valeur, attrs, maj) {
    const inp = h('input', { type: 'number', value: valeur, inputmode: 'decimal', ...attrs });
    const f = () => maj(inp.value);
    inp.addEventListener('change', f);
    inp.addEventListener('input', f);
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return h('label', {}, h('span', {}, libelle), inp);
  }

  function reglagesLigne(c) {
    const curseur = h('input', { type: 'range', min: -80, max: 80, step: 1, value: c.decalage, 'aria-label': 'Déplacer le plan de coupe' });
    const val = h('strong', { class: 'valeur' }, `${c.decalage > 0 ? '+' : ''}${c.decalage} m`);
    curseur.addEventListener('input', () => {
      c.decalage = +curseur.value;
      val.textContent = `${c.decalage > 0 ? '+' : ''}${c.decalage} m`;
      majPlan();
      majDessinDiffere();
    });
    ui.dessinMain = h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (etat.image) etat.image.visible = e.target.checked; } });
    return [
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Position du plan'), val),
      curseur,
      h('div', { class: 'champs-coupe' },
        champNombre('Profondeur de vue (m, 0 = sans limite)', c.profondeur, { min: 0, max: 500, step: 5, class: 'profondeur-coupe' }, (v) => { c.profondeur = Math.max(0, Math.min(500, +v || 0)); majPlan(); majDessinDiffere(); })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: () => { const face = !!etat.face; c.inverse = !c.inverse; majPlan(); majDessin(); if (face) vueFace(); else cadrerSur(c); } }, 'Regarder de l\'autre côté'),
        boutonFace(),
        c.predefinie ? null : (ui.deplacer = h('button', { type: 'button', class: 'bouton discret', 'aria-pressed': 'false', onclick: (e) => { finirTrace(); app.captureSol = deplacer; e.target.setAttribute('aria-pressed', 'true'); app.signaler('Cliquez le sol : nouveau milieu de la coupe.'); } }, 'Déplacer')),
        h('button', { type: 'button', class: 'bouton discret', onclick: desactiver }, 'Refermer la coupe')),
      c.image ? h('label', { class: 'case' }, ui.dessinMain, 'Superposer mon dessin de coupe') : null,
    ];
  }

  // vue de face orthographique (élévation) et retour
  function boutonFace() {
    return etat.face
      ? h('button', { type: 'button', class: 'bouton principal bouton-face', 'aria-pressed': 'true', onclick: quitterVueFace }, 'Revenir à la vue précédente')
      : h('button', { type: 'button', class: 'bouton bouton-face', 'aria-pressed': 'false', title: 'Caméra orthographique parallèle au plan de coupe, face à la coupe', onclick: vueFace }, 'Vue de face (élévation)');
  }

  function reglagesPoly(c) {
    const segs = segmentsPoly(c);
    const total = segs.reduce((a, g) => a + g.L, 0);
    const sel = h('select', { 'aria-label': 'Segment du plan de coupe 3D', onchange: (e) => { c.segment = +e.target.value; majPlan(); if (etat.face) vueFace(); } },
      ...segs.map((g, k) => h('option', { value: k, selected: k === (c.segment || 0) }, `Segment ${g.i + 1}-${g.i + 2} (${Math.round(g.L)} m)`)));
    const points = h('ol', { class: 'points-polyligne' }, ...c.P.map((q, k) => h('li', {},
      h('span', {}, `Point ${k + 1}`),
      h('button', { type: 'button', class: 'bouton discret petit', title: 'Déplacer : cliquer le sol', onclick: () => editerPoint(c, k, 'deplacer') }, 'Déplacer'),
      h('button', { type: 'button', class: 'bouton discret petit', title: k + 1 < c.P.length ? 'Insérer un point au milieu du segment suivant' : 'Ajouter un point après le dernier', onclick: () => editerPoint(c, k, 'inserer') }, '+'),
      h('button', { type: 'button', class: 'bouton discret petit', title: 'Supprimer le point', disabled: c.P.length <= 2, onclick: () => editerPoint(c, k, 'supprimer') }, '×'))));
    return [
      h('p', { class: 'resultat' }, `${c.P.length} points, ${segs.length} segments, ${Math.round(total)} m déroulés.`),
      h('label', { class: 'champ' }, h('span', {}, 'Plan de coupe 3D'), sel),
      h('div', { class: 'champs-coupe' },
        champNombre('Profondeur de vue (m, 0 = sans limite)', c.profondeur, { min: 0, max: 500, step: 5, class: 'profondeur-coupe' }, (v) => { c.profondeur = Math.max(0, Math.min(500, +v || 0)); majPlan(); majDessinDiffere(); })),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: () => { const face = !!etat.face; c.inverse = !c.inverse; majPlan(); majDessin(); if (face) vueFace(); else cadrerSur(c); } }, 'Regarder de l\'autre côté'),
        boutonFace(),
        (ui.deplacer = h('button', { type: 'button', class: 'bouton discret', 'aria-pressed': 'false', onclick: (e) => { finirTrace(); app.captureSol = deplacer; e.target.setAttribute('aria-pressed', 'true'); app.signaler('Cliquez le sol : nouveau centre de la polyligne.'); } }, 'Déplacer')),
        h('button', { type: 'button', class: 'bouton discret', onclick: desactiver }, 'Refermer la coupe')),
      h('h3', {}, 'Points'),
      points,
      h('p', { class: 'note', 'data-garder': '' }, 'Le poché suit chaque segment ; la maquette est tranchée par le plan du segment choisi. Le dessin 2D déroule les segments bout à bout (plis numérotés).'),
    ];
  }

  function reglagesZone(c) {
    const maj = (cle) => (v) => { c[cle] = borner(v, BORNES_ZONE[cle]); majPlan(); dessinerTraces(); };
    return [
      h('div', { class: 'champs-coupe' },
        champNombre('Longueur (m)', c.a, { min: 5, max: 800, step: 1, 'data-champ': 'a' }, maj('a')),
        champNombre('Largeur (m)', c.b, { min: 5, max: 800, step: 1, 'data-champ': 'b' }, maj('b')),
        champNombre('Rotation (°)', c.rot, { min: -180, max: 180, step: 5, 'data-champ': 'rot' }, maj('rot')),
        champNombre('Hauteur max (m)', c.hmax, { min: 2, max: 150, step: 1, 'data-champ': 'hmax' }, maj('hmax'))),
      h('div', { class: 'actions' },
        (ui.deplacer = h('button', { type: 'button', class: 'bouton', 'aria-pressed': 'false', onclick: (e) => { finirTrace(); app.captureSol = deplacer; e.target.setAttribute('aria-pressed', 'true'); app.signaler('Cliquez le sol : nouveau centre de la zone.'); } }, 'Déplacer')),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => cadrerSur(c) }, 'Cadrer'),
        h('button', { type: 'button', class: 'bouton discret', onclick: desactiver }, 'Refermer la coupe')),
      h('p', { class: 'note' }, 'Seul l\'intérieur de la boîte reste : quatre faces verticales et un plafond à la hauteur max au-dessus du sol (au centre).'),
    ];
  }

  function majPanneau() {
    if (!ui.liste?.isConnected) return;
    ui.liste.replaceChildren(...liste.map(ligneListe));
    const c = trouver(etat.actif);
    ui.reglages.hidden = !c;
    ui.reglages.replaceChildren(...(c ? [
      h('h3', {}, `${{ ligne: 'Coupe', polyligne: 'Polyligne', zone: 'Zone' }[c.type]} ${c.id} : ${c.nom}`),
      ...(c.type === 'ligne' ? reglagesLigne(c) : c.type === 'polyligne' ? reglagesPoly(c) : reglagesZone(c)),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.poche, class: 'case-poche', onchange: (e) => { etat.poche = e.target.checked; majPlan(); } }), 'Poché des sections (bâti, projet, sol)'),
    ] : []).filter(Boolean));
    majBoutonsTrace();
    consigne();
    majDessin();
  }

  let minuterieDessin = 0;
  function majDessinDiffere() { clearTimeout(minuterieDessin); minuterieDessin = setTimeout(majDessin, 150); }
  function majDessin() {
    const c = coupeLigne();
    const pret = !!c;
    let svg = '', M = null;
    if (pret) { majCouleurs(); M = modele(c); svg = svgCoupe(M); }
    if (ui.dessin?.isConnected) {
      ui.blocDessin.hidden = !etat.actif;
      ui.dessin.innerHTML = pret ? svg : '';
      ui.noteDessin.textContent = pret ? `Sections du bâti effectif (existant non démoli et projet), élévations jusqu'à ${Math.round(c.profondeur > 0 ? c.profondeur : PROF_DESSIN)} m derrière le plan${etat.couleurs ? ', photos de façade quand elles existent' : ''}. Export pour Rhino : DXF en mètres, calques COUPE_SOL, COUPE_BATI, COUPE_PROJET, ELEVATION, COTES, PLIS (polyligne) ; le SVG garde les couleurs et embarque les photos.`
        : 'Le dessin 2D est fait pour les coupes linéaires et les polylignes.';
      ui.boutonsDessin.hidden = !pret;
    }
    if (ui.dialogue?.open) {
      if (pret) ui.grand.innerHTML = svgCoupe(M, true); else ui.dialogue.close();
    }
  }

  function agrandir() {
    const c = coupeLigne();
    if (!c) return;
    if (!ui.dialogue) {
      ui.grand = h('div', { class: 'contenu' });
      ui.titreDialogue = h('strong', {});
      ui.dialogue = h('dialog', { class: 'dialogue-coupe', 'aria-label': 'Dessin de coupe' },
        h('header', {}, ui.titreDialogue,
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'bouton', onclick: () => exporterSVG() }, 'SVG'),
            h('button', { type: 'button', class: 'bouton', onclick: () => exporterDXF() }, 'DXF'),
            h('button', { type: 'button', class: 'fermer', 'aria-label': 'Fermer', onclick: () => ui.dialogue.close() }, '×'))),
        ui.grand);
      document.body.append(ui.dialogue);
    }
    ui.titreDialogue.textContent = `Coupe ${c.id} : ${c.nom}`;
    ui.dialogue.showModal();
    majDessin();
  }

  function construirePanneau(conteneur) {
    if (!document.querySelector('link[href="css/coupes.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/coupes.css' }));
    ui.liste = h('ul', { class: 'liste-coupes' });
    ui.reglages = h('div', { class: 'reglages-coupe', hidden: true });
    ui.consigne = h('p', { class: 'note consigne-coupe', 'aria-live': 'polite' });
    ui.tracerLigne = h('button', { type: 'button', class: 'bouton principal', 'aria-pressed': 'false', onclick: () => commencerTrace('ligne') }, 'Tracer une coupe');
    ui.tracerZone = h('button', { type: 'button', class: 'bouton', 'aria-pressed': 'false', onclick: () => commencerTrace('zone') }, 'Tracer une zone');
    ui.tracerPoly = h('button', { type: 'button', class: 'bouton', 'aria-pressed': 'false', title: 'Clics successifs le long de la rue, double-clic pour finir', onclick: () => commencerTrace('polyligne') }, 'Tracer une polyligne');
    ui.terminerPoly = h('button', { type: 'button', class: 'bouton principal', hidden: true, onclick: finirPolyligne }, 'Terminer la polyligne');
    ui.dessin = h('div', { class: 'dessin-coupe' });
    ui.noteDessin = h('p', { class: 'note' });
    ui.boutonsDessin = h('div', { class: 'actions' },
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.couleurs, class: 'case-couleurs', onchange: (e) => { etat.couleurs = e.target.checked; majDessin(); } }), 'En couleurs (avec photos de façade)'),
      h('button', { type: 'button', class: 'bouton', onclick: agrandir }, 'Agrandir'),
      h('button', { type: 'button', class: 'bouton', onclick: () => exporterSVG() }, 'Exporter en SVG'),
      h('button', { type: 'button', class: 'bouton', onclick: () => exporterDXF() }, 'Exporter en DXF'));
    ui.blocDessin = h('div', { class: 'bloc-dessin-coupe', hidden: true }, h('h3', {}, 'Dessin de coupe'), ui.dessin, ui.boutonsDessin, ui.noteDessin);
    conteneur.append(
      h('p', { class: 'note' }, 'A et B sont les coupes de rendu. Tracez une coupe (deux clics au sol), une polyligne qui suit une rue (clics successifs, double-clic pour finir) ou une zone (trois clics : un côté puis la largeur) ; cliquez une coupe de la liste pour trancher la maquette. « Vue de face » place une caméra orthographique face au plan de coupe.'),
      ui.liste,
      h('div', { class: 'actions' }, ui.tracerLigne, ui.tracerPoly, ui.tracerZone, ui.terminerPoly),
      ui.consigne,
      ui.reglages,
      ui.blocDessin,
      h('h3', {}, 'Enregistrer'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer coupes.json')),
      h('p', { class: 'note' }, 'Les coupes (noms, réglages, tracés libres) sont relues au démarrage depuis data/coupes.json. Sans serveur local, le fichier est téléchargé : le placer dans data/.'),
    );
    majPanneau();
  }

  // bloc de l'onglet Export
  function blocExport() {
    const sel = h('select', { 'aria-label': 'Coupe à exporter' }, ...dessinables().map((c) => h('option', { value: c.id, selected: c.id === etat.actif }, `${c.id} : ${c.nom}${c.type === 'polyligne' ? ' (polyligne)' : ''}`)));
    return h('div', {},
      h('h3', {}, 'Coupe pour Rhino'),
      h('p', { class: 'note' }, 'Dessin 2D d\'une coupe linéaire ou d\'une polyligne déroulée : DXF en mètres (X le long de la coupe, Y altitude NGF), calques COUPE_SOL, COUPE_BATI, COUPE_PROJET, ELEVATION, COTES, PLIS ; ou SVG en couleurs avec les photos de façade.'),
      h('label', { class: 'champ-export-coupe' }, sel),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton principal', onclick: () => exporterDXF(sel.value) }, 'Exporter la coupe DXF'),
        h('button', { type: 'button', class: 'bouton', onclick: () => exporterSVG(sel.value) }, 'SVG')));
  }

  majCouleurs();
  dessinerTraces();
  charger();

  return {
    get axes() { return lignes(); },
    liste, etat, activer, desactiver, construirePanneau, blocExport, charger, enregistrer, serialiser, lire, supprimer, renommer,
    modele: (id) => { const c = coupeLigne(id); return c ? modele(c) : null; },
    svg: (id, grand = true) => { const c = coupeLigne(id); return c ? svgCoupe(modele(c), grand) : null; },
    dxf: (id) => { const c = coupeLigne(id); return c ? dxfCoupe(modele(c)) : null; },
    exporterSVG, exporterDXF, commencerTrace, finirTrace, finirPolyligne, vueFace, quitterVueFace, editerPoint,
    get vueDeFace() { return !!etat.face; },
  };
}
