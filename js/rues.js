import * as THREE from 'three';
import { lignesLocales } from './geo.js';

// Noms des rues écrits à plat sur la chaussée, comme sur une carte (3D et plan) :
// - source : noms OpenStreetMap de la voirie déjà chargée (app.donnees.osm.voirie, clé « name ») ;
// - vue étendue : une ou deux occurrences par nom, sur une portion assez droite de la voie, au milieu de la plus longue ;
// - vue maquette : chaque voie qui traverse le plateau porte son nom sur sa partie intérieure (milieu du tronçon intérieur,
//   1,2 m du bord au moins) ; deux noms ne se recouvrent pas ; aucun nom sur un bâtiment ni sous un arbre ;
// - même taille pour toutes les rues (plan de 2,6 m de haut) ; nom abrégé puis réduit s'il ne tient pas ;
// - texte dessiné sur un canvas, plaqué sur un plan découpé qui suit le relief (10 cm au-dessus du sol, polygonOffset) ;
// - toujours lisible : texture tournée de 180° quand la caméra regarde la rue « à l'envers » ;
// - vue étendue : masqué sous 7 pixels de haut à l'écran ; couche « rues » de Couches (app.couches.rues).

const PX = 64; // hauteur des lettres sur le canvas (pixels)
const POLICE = (px) => `600 ${px}px "Plex Cond", "Arial Narrow", "Roboto Condensed", sans-serif`;
const PIXELS_MIN = 7;

export function creerRues(app) {
  const groupe = new THREE.Group();
  groupe.name = 'rues';
  groupe.userData.pasDeRelief = true; // hauteur gérée ici (app.relief.dz)
  app.scene.add(groupe);
  const etiquettes = []; // { mesh, x, z, angle, h, retourne }
  let derniereVue = '';
  let compteur = 0;

  // ---------------------------------------------------------------
  // Chaînes de voies par nom (tronçons OSM raboutés par leurs extrémités)
  // ---------------------------------------------------------------
  function chaines(lignes) {
    const cle = ([x, z]) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
    const restes = lignes.map((l) => l.slice());
    const res = [];
    while (restes.length) {
      let c = restes.shift();
      let prolonge = true;
      while (prolonge) {
        prolonge = false;
        for (let i = 0; i < restes.length; i++) {
          const l = restes[i];
          const [d, f] = [cle(c[0]), cle(c[c.length - 1])];
          const [a, b] = [cle(l[0]), cle(l[l.length - 1])];
          if (f === a) c = c.concat(l.slice(1));
          else if (f === b) c = c.concat(l.slice(0, -1).reverse());
          else if (d === b) c = l.concat(c.slice(1));
          else if (d === a) c = l.slice().reverse().concat(c.slice(1));
          else continue;
          restes.splice(i, 1);
          prolonge = true;
          break;
        }
      }
      res.push(c);
    }
    return res;
  }

  // abscisses cumulées d'une polyligne
  const abscisses = (pts) => { const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return s; };
  function pointA(pts, s, t) {
    let i = 1;
    while (i < pts.length - 1 && s[i] < t) i++;
    const u = (t - s[i - 1]) / Math.max(s[i] - s[i - 1], 1e-9);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  }
  // portion [t0, t1] assez droite ? écart maximal des sommets à la corde
  function ecartCorde(pts, s, t0, t1) {
    const A = pointA(pts, s, t0), B = pointA(pts, s, t1);
    const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1;
    let e = 0;
    for (let i = 0; i < pts.length; i++) if (s[i] > t0 && s[i] < t1) e = Math.max(e, Math.abs((pts[i][0] - A[0]) * dz - (pts[i][1] - A[1]) * dx) / L);
    return { e, A, B, L };
  }

  // ---------------------------------------------------------------
  // Texture d'un nom (canvas)
  // ---------------------------------------------------------------
  const mesure = document.createElement('canvas').getContext('2d');
  function texture(nom) {
    mesure.font = POLICE(PX);
    const w = Math.ceil(mesure.measureText(nom).width) + PX * 0.5;
    const c = document.createElement('canvas');
    c.width = Math.min(2048, w); c.height = Math.round(PX * 1.4);
    const x = c.getContext('2d');
    x.font = POLICE(PX);
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.strokeStyle = 'rgba(246, 248, 247, 0.85)'; x.lineWidth = PX * 0.16;
    x.strokeText(nom, c.width / 2, c.height / 2);
    x.fillStyle = '#2f3b45';
    x.fillText(nom, c.width / 2, c.height / 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return { t, ratio: c.width / c.height };
  }

  // ---------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------
  function vider() {
    for (const e of etiquettes) { e.mesh.geometry.dispose(); e.mesh.material.map.dispose(); e.mesh.material.dispose(); }
    etiquettes.length = 0;
    groupe.clear();
  }

  // Taille unique (21/10/2026) : même hauteur de texte pour toutes les rues (plan de H_TEXTE m, lettres d'environ 1,9 m) ;
  // si le nom ne tient pas sur la portion droite disponible : nom abrégé, puis réduit (au plus de 30 %), sinon pas posé.
  const H_TEXTE = 2.6;
  const ABREV = [[/^Rue /, 'R. '], [/^Place /, 'Pl. '], [/^Boulevard /, 'Bd '], [/^Avenue /, 'Av. '], [/^Allée /, 'All. '], [/^Impasse /, 'Imp. '],
    [/^Passage /, 'Pass. '], [/^Quai /, 'Q. '], [/^Square /, 'Sq. '], [/^Cours /, 'Crs '], [/Général/g, 'Gal'], [/Sainte-/g, 'Ste-'], [/Saint-/g, 'St-']];
  const abreger = (nom) => ABREV.reduce((t, [re, r]) => t.replace(re, r), nom);
  function variantes(nom) {
    const a = abreger(nom);
    const v = [{ texte: nom, k: 1 }];
    if (a !== nom) v.push({ texte: a, k: 1 });
    v.push({ texte: a, k: 0.85 }, { texte: a, k: 0.7 });
    return v;
  }

  // emprises du bâti et couronnes des arbres (pour ne pas écrire dessous) : anneaux extérieurs avec boîte englobante
  let bati = [], arbres = [];
  function preparerBati() {
    bati = [];
    arbres = Object.values(app.arbres?.lots || {}).flat().map((a) => ({ x: a.x, z: a.z, r2: (a.d * 0.6) ** 2 }));
    for (const e of app.empreintes || []) {
      for (const poly of e.polys || []) {
        const r = poly[0];
        if (!r || r.length < 3) continue;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        bati.push({ r, x0, x1, z0, z1 });
      }
    }
  }
  function dansBati(x, z) {
    for (const b of bati) {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      let d = false;
      for (let i = 0, j = b.r.length - 1; i < b.r.length; j = i++) {
        const [xi, zi] = b.r[i], [xj, zj] = b.r[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) d = !d;
      }
      if (d) return true;
    }
    // couronnes des arbres (elles cacheraient le nom vu d'en haut)
    for (const a of arbres) if ((x - a.x) ** 2 + (z - a.z) ** 2 < a.r2) return true;
    return false;
  }
  // points du rectangle du nom (centre, angle, longueur, hauteur) : bords, coins et milieu
  function pointsRect(q) {
    const c = Math.cos(q.angle), sn = Math.sin(q.angle), pts = [];
    const nx = Math.max(2, Math.ceil(q.L / 2));
    for (let i = 0; i <= nx; i++) {
      for (const v of [-0.45, 0, 0.45]) {
        const u = (i / nx - 0.5) * q.L, w = v * q.h;
        pts.push([q.x + u * c - w * sn, q.z + u * sn + w * c]);
      }
    }
    return pts;
  }
  function chevauche(q, poses) {
    for (const o of poses) {
      if (Math.hypot(o.x - q.x, o.z - q.z) > (o.L + q.L) / 2 + 2) continue;
      const c = Math.cos(o.angle), sn = Math.sin(o.angle);
      for (const [x, z] of pointsRect(q)) {
        const dx = x - o.x, dz = z - o.z;
        if (Math.abs(dx * c + dz * sn) < o.L / 2 + 0.5 && Math.abs(-dx * sn + dz * c) < o.h / 2 + 0.3) return true;
      }
    }
    return false;
  }

  function construire() {
    vider();
    preparerBati();
    const parNom = new Map();
    const limite = app.config.rayonEtude * 1.05;
    for (const f of app.donnees.osm?.voirie?.features || []) {
      const p = f.properties || {};
      const nom = p.name;
      if (!nom || !p.highway || p.tunnel === 'yes' || p.layer < 0) continue;
      for (const pts of lignesLocales(f.geometry, app.proj)) {
        if (pts.length < 2 || !pts.some(([x, z]) => Math.hypot(x, z) < limite)) continue;
        if (!parNom.has(nom)) parNom.set(nom, { lignes: [] });
        parNom.get(nom).lignes.push(pts);
      }
    }
    const textures = new Map(); // texte → { t, ratio, n }
    const tex = (texte) => { if (!textures.has(texte)) textures.set(texte, { ...texture(texte), n: 0 }); return textures.get(texte); };
    const posesEtendue = [], posesMaquette = [];
    const R = app.config.rayonPlateau, marge = 1.2;
    const valide = (q, poses, dansPlateau) => {
      const pts = pointsRect(q);
      if (dansPlateau && pts.some(([x, z]) => Math.hypot(x, z) > R - marge)) return false;
      if (pts.some(([x, z]) => dansBati(x, z))) return false;
      return !chevauche(q, poses);
    };
    const essayer = (c, nom, t, v, poses, dansPlateau) => {
      const T = tex(v.texte);
      const h = H_TEXTE * v.k, L = h * T.ratio;
      const { e, A, B } = ecartCorde(c.pts, c.s, t - L / 2, t + L / 2);
      if (e > h * 0.35) return null;
      const q = { x: (A[0] + B[0]) / 2, z: (A[1] + B[1]) / 2, angle: Math.atan2(B[1] - A[1], B[0] - A[0]), h, L, texte: v.texte, nom };
      return valide(q, poses, dansPlateau) ? q : null;
    };

    const noms = [...parNom.keys()];
    const chainesPar = new Map(noms.map((nom) => [nom, chaines(parNom.get(nom).lignes).map((pts) => ({ pts, s: abscisses(pts) }))]));

    // vue étendue : une ou deux occurrences par nom, au milieu des portions droites les plus longues
    for (const nom of noms) {
      const liste = chainesPar.get(nom).slice().sort((a, b) => b.s[b.s.length - 1] - a.s[a.s.length - 1]);
      const total = liste.reduce((m, c) => m + c.s[c.s.length - 1], 0);
      const nbVoulu = total > 220 ? 2 : 1;
      const miennes = [];
      for (const v of variantes(nom)) {
        if (miennes.length >= nbVoulu) break;
        const Lv = H_TEXTE * v.k * tex(v.texte).ratio;
        for (const c of liste) {
          if (miennes.length >= nbVoulu) break;
          const Lc = c.s[c.s.length - 1];
          if (Lc < Lv + 2) continue;
          const cand = [];
          for (let t = Lv / 2 + 1; t <= Lc - Lv / 2 - 1; t += 3) cand.push(t);
          cand.sort((a, b) => Math.abs(a - Lc / 2) - Math.abs(b - Lc / 2));
          for (const t of cand) {
            const q = essayer(c, nom, t, v, posesEtendue, false);
            if (!q || Math.hypot(q.x, q.z) > limite) continue;
            if (miennes.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < Math.max(120, total / 3))) continue;
            miennes.push(q); posesEtendue.push(q);
            break;
          }
        }
      }
    }

    // vue maquette : chaque voie qui traverse le plateau a son nom sur sa partie intérieure, au plus près du milieu
    // de ce tronçon intérieur, à distance du bord ; voies les plus longues sur le plateau servies d'abord
    const interieurs = [];
    for (const nom of noms) {
      for (const c of chainesPar.get(nom)) {
        const Lc = c.s[c.s.length - 1];
        let debut = null;
        for (let t = 0; t <= Lc + 0.25; t += 0.5) {
          const [x, z] = pointA(c.pts, c.s, Math.min(t, Lc));
          const dedans = Math.hypot(x, z) <= R - marge && t <= Lc;
          if (dedans && debut == null) debut = t;
          if ((!dedans || t > Lc - 0.5) && debut != null) { interieurs.push({ nom, c, a: debut, b: Math.min(t, Lc) }); debut = null; }
        }
      }
    }
    const longueurNom = new Map();
    for (const it of interieurs) longueurNom.set(it.nom, Math.max(longueurNom.get(it.nom) || 0, it.b - it.a));
    const ordre = [...longueurNom.keys()].sort((x, y) => longueurNom.get(y) - longueurNom.get(x));
    for (const nom of ordre) {
      const morceaux = interieurs.filter((it) => it.nom === nom).sort((x, y) => (y.b - y.a) - (x.b - x.a));
      let pose = null;
      for (const v of variantes(nom)) {
        const Lv = H_TEXTE * v.k * tex(v.texte).ratio;
        for (const it of morceaux) {
          if (it.b - it.a < Lv + 0.5) continue;
          const mil = (it.a + it.b) / 2;
          const cand = [];
          for (let t = it.a + Lv / 2 + 0.25; t <= it.b - Lv / 2 - 0.25; t += 0.5) cand.push(t);
          cand.sort((x, y) => Math.abs(x - mil) - Math.abs(y - mil));
          for (const t of cand) { pose = essayer(it.c, nom, t, v, posesMaquette, true); if (pose) break; }
          if (pose) break;
        }
        if (pose) break;
      }
      if (pose) posesMaquette.push(pose);
    }

    const creerMesh = (q, mode) => {
      const T = tex(q.texte);
      const nx = Math.max(1, Math.ceil(q.L / 2));
      const geo = new THREE.PlaneGeometry(q.L, q.h, nx, 2).rotateX(-Math.PI / 2);
      const map = T.n++ === 0 ? T.t : T.t.clone();
      map.center.set(0.5, 0.5);
      if (map !== T.t) map.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({
        map, transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `rue-${q.nom}`;
      mesh.renderOrder = 3;
      mesh.raycast = () => {};
      mesh.userData.pasDeRelief = true;
      mesh.userData.nomRue = q.nom;
      mesh.userData.base = geo.getAttribute('position').array.slice();
      mesh.rotation.y = -q.angle; // sens de la voie ; la lecture est rétablie en tournant la texture (orienter)
      groupe.add(mesh);
      etiquettes.push({ mesh, x: q.x, z: q.z, angle: q.angle, h: q.h, mode, retourne: null });
    };
    posesEtendue.forEach((q) => creerMesh(q, 'etendue'));
    posesMaquette.forEach((q) => creerMesh(q, 'maquette'));
    for (const T of textures.values()) if (!T.n) T.t.dispose();
    derniereVue = '';
    poser();
    majVisibilite();
  }

  // hauteur : 10 cm au-dessus du sol, chaque sommet du plan suit le relief (pas de lettres enfouies dans la pente)
  const droite = new THREE.Vector3();
  function poser() {
    const relief = app.relief?.actif;
    for (const e of etiquettes) {
      e.mesh.position.set(e.x, 0, e.z);
      const p = e.mesh.geometry.getAttribute('position');
      const b = e.mesh.userData.base;
      const c = Math.cos(e.angle), sn = Math.sin(e.angle);
      for (let i = 0; i < p.count; i++) {
        const lx = b[i * 3], lz = b[i * 3 + 2];
        const wx = e.x + lx * c - lz * sn, wz = e.z + lx * sn + lz * c;
        p.setY(i, 0.1 + (relief ? app.relief.dz(wx, wz) : 0));
      }
      p.needsUpdate = true;
      e.mesh.geometry.computeBoundingSphere();
    }
  }
  // jamais à l'envers : texture tournée de 180° quand le sens de la voie s'oppose à la droite de l'écran
  function orienter() {
    droite.set(1, 0, 0).applyQuaternion(app.camera.quaternion);
    const rx = droite.x, rz = droite.z;
    const cleVue = `${Math.round(Math.atan2(rz, rx) * 30)}`;
    if (cleVue === derniereVue) return;
    derniereVue = cleVue;
    for (const e of etiquettes) {
      const ret = Math.cos(e.angle) * rx + Math.sin(e.angle) * rz < 0;
      if (ret !== e.retourne) { e.retourne = ret; e.mesh.material.map.rotation = ret ? Math.PI : 0; }
    }
  }
  const pos = new THREE.Vector3();
  function majVisibilite() {
    const actif = app.couches.rues !== false;
    groupe.visible = actif;
    if (!actif) return;
    const H = window.innerHeight;
    const persp = app.camera.isPerspectiveCamera;
    const k = persp ? H / (2 * Math.tan(THREE.MathUtils.degToRad(app.camera.fov / 2))) : 1 / app.vue.metresParPixel();
    // vue maquette coupée : noms posés sur le plateau ; sinon (vue étendue, ou ancienne vue maquette) : noms de la vue étendue
    const mode = app.vueMaquette && app.decoupe?.disponible ? 'maquette' : 'etendue';
    for (const e of etiquettes) {
      if (e.mode !== mode || (app.vueMaquette && Math.hypot(e.x, e.z) > app.config.rayonPlateau)) { e.mesh.visible = false; continue; }
      let px;
      if (persp) {
        pos.set(e.x, e.mesh.position.y, e.z);
        px = (e.h * k) / Math.max(pos.distanceTo(app.camera.position), 1);
      } else px = e.h * k;
      e.mesh.visible = mode === 'maquette' || px >= PIXELS_MIN;
    }
  }

  function maj() {
    if (!etiquettes.length || app.couches.rues === false) { groupe.visible = app.couches.rues !== false; return; }
    orienter();
    if (++compteur % 6 === 0) majVisibilite();
    if (compteur % 30 === 0) poser();
  }

  app.on('couches', majVisibilite);
  app.on('vue', () => { derniereVue = ''; });
  app.on('relief', poser);
  app.on('vueMaquette', majVisibilite);
  app.on('bati', construire); // emprises changées (projet, hauteurs) : noms reposés hors du bâti

  // la police de l'atlas (Plex Cond) est chargée avant de dessiner les noms
  async function demarrer() {
    try { await document.fonts?.load?.(POLICE(PX)); } catch { /* police par défaut */ }
    construire();
  }

  return { demarrer, construire, maj, groupe, get nombre() { return etiquettes.length; }, get noms() { return [...new Set(etiquettes.map((e) => e.mesh.userData.nomRue))]; } };
}
