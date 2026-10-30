// Diagramme solaire (« Sun path chart » de CBE Clima, vue sphérique) — outil Soleil.
// 3D : demi-sphère de rayon config.rayonPlateau centrée sur le plateau (groupe « diagramme-solaire », jamais coupé par la
// vue maquette : userData.horsDecoupe, lu par decoupe.js), posée à app.relief.dz(0, 0) ; trajectoires du 21 de chaque mois (orange),
// analemmes horaires (une boucle par heure entière en heure normale UTC+1, toute l'année), graduations (hauteur 0-75°,
// azimut tous les 15°), position du soleil de la barre Soleil. Lancers de rayons neutralisés (clics sur le bâti intacts) ;
// info-bulle au survol par projection des points à l'écran.
// 2D : même diagramme en projection polaire équidistante (N en haut, SVG) dans le panneau Soleil, info-bulle, point de l'heure.
// Variable : couleur des points horaires selon la source météo active (js/meteo.js valeurHoraire : EPW heure par heure,
// sinon moyenne du mois à cette heure) : température, rayonnement global, nébulosité (EPW).
// Affiché quand le mode « Diagramme solaire » de l'outil Soleil est choisi (app.soleil.definirMode, afficher(v)) ; masqué au démarrage.
// Mois et heures : toujours toute l'année et toutes les heures (filtres retirés le 23/10/2026 : date et heure dans la barre Soleil).
// Exports : 2D en SVG et PNG (svgAutonome), vue 3D en PNG (export.exporterImage), et cadre de la planche à l'échelle (svgPlanche).
// Réglages { visible, variable, mode } (variable dans localStorage atlas-hdv-diagramme-solaire), repris par les points de vue
// (js/vues.js reglagesOutils / appliquerReglages ; mode = mode de l'outil Soleil). Créé par js/soleil.js (app.diagrammeSolaire).
import * as THREE from 'three';
import { getPosition } from '../lib/suncalc.js';
import { dateParis } from './geo.js';
import { h, info, MOIS } from './util.js';
import { valeurHoraire, sourceEPW, mention } from './meteo.js';
import { telecharger } from './donnees.js';
import { directionSoleil } from './soleil.js';

const CLE = 'atlas-hdv-diagramme-solaire';
const ORANGE = '#f5a300';
const SOLEIL = '#ffd400';
export const VARIABLES = {
  aucune: { libelle: 'Aucune' },
  ta: { libelle: 'Température de l\'air', unite: '°C', dec: 1, stops: [[0, [44, 123, 182]], [0.5, [255, 255, 191]], [1, [215, 25, 28]]], gauche: 'froid', droite: 'chaud' },
  ghi: { libelle: 'Rayonnement global horizontal', unite: 'W/m²', dec: 0, stops: [[0, [52, 48, 92]], [0.5, [214, 120, 46]], [1, [255, 232, 92]]], gauche: 'faible', droite: 'fort' },
  neb: { libelle: 'Nébulosité (EPW)', unite: '/10', dec: 0, stops: [[0, [110, 186, 238]], [1, [105, 105, 110]]], gauche: 'ciel clair', droite: 'couvert' },
};
const nombre = (v, d = 1) => v.toFixed(d).replace('.', ',').replace('-', '−');

function lireLS() { try { return JSON.parse(localStorage.getItem(CLE)) || {}; } catch { return {}; } }
function ecrireLS(o) { try { localStorage.setItem(CLE, JSON.stringify(o)); } catch { /* stockage indisponible */ } }

export function couleurDegrade(stops, t) {
  t = Math.min(Math.max(t, 0), 1);
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, c0] = stops[k - 1], [t1, c1] = stops[k];
      const u = (t - t0) / ((t1 - t0) || 1);
      return c0.map((c, i) => Math.round(c + (c1[i] - c) * u));
    }
  }
  return stops[stops.length - 1][1];
}

export function creerDiagrammeSolaire(app) {
  const { lat, lon } = app.config.soleil;
  const memo = lireLS();
  const etat = {
    visible: false, // affiché par le mode « Diagramme solaire » de l'outil Soleil
    variable: VARIABLES[memo.variable] ? memo.variable : 'aucune',
    mois: [1, 12], // toute l'année (filtres retirés)
    heures: [0, 23], // toutes les heures
  };
  let donnees = null; // { annee, analemmes: [[pt]], jours: [[pt]] } ; pt = { az, alt, mois, jour, hn, hl, type, v }
  let groupe = null, rayon = 0, survolables = [], echelle = null;
  const ui = {};

  const memoriser = () => ecrireLS({ variable: etat.variable });
  const dansMois = (m) => { const [a, b] = etat.mois; return a <= b ? m + 1 >= a && m + 1 <= b : m + 1 >= a || m + 1 <= b; };
  const dansHeures = (hn) => { const [a, b] = etat.heures; return a <= b ? hn >= a && hn <= b : hn >= a || hn <= b; };

  // ---------------------------------------------------------------
  // Positions du soleil (SunCalc local). Heure normale hn = UTC+1 (heure d'hiver) : analemmes continus ;
  // heure légale hl (Europe/Paris, heure d'été) pour la météo et l'info-bulle.
  // ---------------------------------------------------------------
  function point(annee, mois, jour, hn, type) {
    const t = Date.UTC(annee, mois, jour, 0) + (hn - 1) * 3600e3;
    const p = getPosition(new Date(t), lat, lon);
    const decal = Math.round((Date.UTC(annee, mois, jour) + hn * 3600e3 - dateParis(annee, mois, jour, hn).getTime()) / 3600e3); // 1 ou 2
    return { az: p.azimuth, alt: p.altitude, mois, jour, hn, hl: (hn + decal - 1 + 24) % 24, type };
  }
  function calculer() {
    const annee = app.soleil?.etat?.annee ?? new Date().getFullYear();
    if (donnees?.annee === annee) return donnees;
    const analemmes = [];
    for (let hn = 0; hn < 24; hn++) {
      const L = [];
      for (let k = 0; k < 365; k += 2) { const d = new Date(Date.UTC(annee, 0, 1 + k)); L.push(point(annee, d.getUTCMonth(), d.getUTCDate(), hn, 'a')); }
      if (L.some((p) => p.alt > 0)) analemmes.push(L);
    }
    const jours = [];
    for (let m = 0; m < 12; m++) {
      const L = [];
      for (let mn = 0; mn <= 24 * 60; mn += 10) L.push(point(annee, m, 21, mn / 60, 'j'));
      jours.push(L);
    }
    donnees = { annee, analemmes, jours };
    return donnees;
  }

  // valeurs météo des points horaires et bornes de l'échelle (variable active)
  function colorier() {
    const D = calculer(), V = VARIABLES[etat.variable];
    echelle = null;
    let min = Infinity, max = -Infinity;
    for (const L of D.analemmes) for (const p of L) {
      p.v = V.stops ? valeurHoraire(etat.variable, p.mois, p.jour, p.hl) : null;
      if (p.v != null && p.alt > 0) { min = Math.min(min, p.v); max = Math.max(max, p.v); }
    }
    if (V.stops && min <= max) {
      if (etat.variable === 'neb') { min = 0; max = 10; }
      else if (etat.variable === 'ghi') { min = 0; max = Math.max(100, Math.ceil(max / 100) * 100); }
      else { min = Math.floor(min); max = Math.ceil(max); }
      echelle = { min, max, stops: V.stops };
    }
  }
  const couleurPoint = (p) => (echelle && p.v != null ? couleurDegrade(echelle.stops, (p.v - echelle.min) / ((echelle.max - echelle.min) || 1)) : null);

  // ---------------------------------------------------------------
  // 3D
  // ---------------------------------------------------------------
  const sans = () => {};
  const matGrille = new THREE.LineBasicMaterial({ color: 0x5c6873, transparent: true, opacity: 0.45, depthWrite: false });
  const matHorizon = new THREE.LineBasicMaterial({ color: 0x3d4750, transparent: true, opacity: 0.8, depthWrite: false });
  const matJour = new THREE.LineBasicMaterial({ color: ORANGE });
  const matAnalemme = new THREE.LineBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.85 });
  const matPoints = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true });
  const soleil = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: SOLEIL }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.7, 32), new THREE.MeshBasicMaterial({ color: 0x8a5a00, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
  soleil.raycast = sans; halo.raycast = sans;

  const vers3D = (az, alt, r = rayon) => directionSoleil(az, alt).multiplyScalar(r);
  function ligne(pts, mat) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    l.raycast = sans;
    return l;
  }
  // morceaux continus d'une suite de points (au-dessus de l'horizon et dans le filtre)
  function morceaux(L, garder, boucle = false) {
    const M = [];
    let cur = [];
    for (const p of L) { if (garder(p)) cur.push(p); else { if (cur.length) M.push(cur); cur = []; } }
    if (cur.length) {
      if (boucle && cur.length === L.length) { cur.push(L[0]); M.push(cur); } // boucle complète : refermée
      else if (boucle && M.length && garder(L[0])) M[0] = cur.concat(M[0]); // fin d'année raccordée au début
      else M.push(cur);
    }
    return M.filter((m) => m.length > 1);
  }

  function construire3D() {
    if (!app.scene) return;
    detruire3D();
    colorier();
    rayon = app.config.rayonPlateau;
    groupe = new THREE.Group();
    groupe.name = 'diagramme-solaire';
    groupe.userData.pasDeRelief = true;
    groupe.userData.horsDecoupe = true;
    groupe.renderOrder = 8;
    // graduations : cercles de hauteur et méridiens d'azimut
    for (let a = 0; a <= 75; a += 15) {
      const pts = [];
      for (let z = 0; z <= 360; z += 3) pts.push(vers3D(z, a));
      groupe.add(ligne(pts, a === 0 ? matHorizon : matGrille));
    }
    for (let z = 0; z < 360; z += 15) {
      const pts = [];
      for (let a = 0; a <= 90; a += 3) pts.push(vers3D(z, a));
      groupe.add(ligne(pts, matGrille));
    }
    const D = calculer();
    survolables = [];
    // trajectoires du 21 de chaque mois (filtre des mois et des heures)
    D.jours.forEach((L, m) => {
      if (!dansMois(m)) return;
      for (const s of morceaux(L, (p) => p.alt > 0 && dansHeures(Math.floor(p.hn)))) groupe.add(ligne(s.map((p) => vers3D(p.az, p.alt)), matJour));
      for (const p of L) if (p.alt > 0 && Number.isInteger(p.hn * 2) && dansHeures(Math.floor(p.hn))) survolables.push(p);
    });
    // analemmes
    const pos = [], col = [];
    for (const L of D.analemmes) {
      if (!dansHeures(L[0].hn)) continue;
      for (const s of morceaux(L, (p) => p.alt > 0 && dansMois(p.mois), true)) groupe.add(ligne(s.map((p) => vers3D(p.az, p.alt)), matAnalemme));
      for (const p of L) {
        if (p.alt <= 0 || !dansMois(p.mois)) continue;
        survolables.push(p);
        const c = couleurPoint(p);
        if (c) { const v = vers3D(p.az, p.alt); pos.push(v.x, v.y, v.z); col.push(c[0] / 255, c[1] / 255, c[2] / 255); }
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      // couleurs déjà en sRGB : pas de conversion
      matPoints.vertexColors = true;
      const P = new THREE.Points(g, matPoints);
      P.raycast = sans;
      groupe.add(P);
    }
    const r = rayon * 0.022;
    soleil.scale.setScalar(r); halo.scale.setScalar(r);
    groupe.add(soleil, halo);
    poser();
    app.scene.add(groupe);
    etiquettes();
    majSoleil();
  }
  function detruire3D() {
    app.etiquettes?.retirerGroupe('diagramme-solaire');
    if (!groupe) return;
    app.scene.remove(groupe);
    groupe.traverse((o) => { if (o !== soleil && o !== halo) o.geometry?.dispose(); });
    groupe = null;
  }
  const dz0 = () => (app.relief?.dz ? app.relief.dz(0, 0) : 0);
  function poser() { if (groupe) groupe.position.set(0, dz0() + 0.3, 0); }

  function etiquettes() {
    const E = app.etiquettes;
    if (!E) return;
    E.retirerGroupe('diagramme-solaire');
    const y0 = dz0() + 0.3;
    // les étiquettes ajoutent dz(x, z) quand le relief est actif : on le retranche ici
    const place = (v) => { v.y += y0 - (app.relief?.actif ? app.relief.dz(v.x, v.z) : 0); return v; };
    const ajouter = (texte, v, classe = 'etiquette-diagramme') => E.ajouter({ texte, position: place(v), classe, groupe: 'diagramme-solaire', toujours: true, centre: true, distanceMax: 6000, visibleSi: () => etat.visible });
    const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
    for (let z = 0; z < 360; z += 30) ajouter(CARD[z] != null ? `${CARD[z]} ${z}°` : `${z}°`, vers3D(z, 0, rayon * 1.07), CARD[z] != null ? 'etiquette-diagramme fort' : 'etiquette-diagramme');
    for (let a = 15; a <= 75; a += 15) ajouter(`${a}°`, vers3D(0, a, rayon * 1.01));
    // heure de chaque analemme, au point le plus haut (21 juin)
    for (const L of calculer().analemmes) {
      if (!dansHeures(L[0].hn)) continue;
      const p = L.reduce((a, b) => (b.alt > a.alt ? b : a));
      if (p.alt > 4) ajouter(`${p.hn} h`, vers3D(p.az, p.alt + 2.5), 'etiquette-diagramme heure');
    }
  }

  function majSoleil() {
    const s = app.soleil?.etat;
    if (!groupe || !s || s.altitude == null) return;
    const v = vers3D(s.azimut, s.altitude);
    soleil.position.copy(v); halo.position.copy(v);
    halo.lookAt(groupe.position.clone().add(v.clone().multiplyScalar(2)));
    soleil.visible = halo.visible = s.altitude > 0;
  }

  // ---------------------------------------------------------------
  // Info-bulle (3D et 2D)
  // ---------------------------------------------------------------
  function texteBulle(p) {
    const V = VARIABLES[etat.variable];
    const hm = (x) => { const H = Math.floor(x) % 24, m = Math.round((x % 1) * 60); return `${H} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`; };
    const L = [
      `${p.jour} ${MOIS[p.mois]}`,
      `${hm(p.hn)} heure d'hiver (UTC+1) · ${hm(p.hl + (p.hn % 1))} heure légale`,
      `Hauteur ${nombre(p.alt, 1)}° · azimut ${nombre(p.az, 1)}°`,
    ];
    if (p.type === 'a' && V.stops && p.v != null) L.push(`${V.libelle} : ${nombre(p.v, V.dec)} ${V.unite}${sourceEPW() ? '' : ' (moyenne du mois)'}`);
    return L;
  }
  const bulle = h('div', { class: 'bulle-diagramme', hidden: true, role: 'tooltip' });
  document.body.append(bulle);
  function montrerBulle(p, x, y) {
    bulle.replaceChildren(...texteBulle(p).map((t) => h('div', {}, t)));
    bulle.hidden = false;
    const w = bulle.offsetWidth, hh = bulle.offsetHeight;
    bulle.style.left = `${Math.min(x + 14, window.innerWidth - w - 6)}px`;
    bulle.style.top = `${Math.max(6, y - hh - 10)}px`;
  }
  const cacherBulle = () => { bulle.hidden = true; };

  let rafSurvol = 0, dernier = null;
  const tmp = new THREE.Vector3();
  function survol3D() {
    rafSurvol = 0;
    const e = dernier;
    if (!e || !groupe || !etat.visible || app.pieton?.actif) { cacherBulle(); return; }
    const cv = app.renderer.domElement, R = cv.getBoundingClientRect();
    let best = null, dmin = 100; // 10 px
    for (const p of survolables) {
      tmp.copy(vers3D(p.az, p.alt)).add(groupe.position).project(app.camera);
      if (tmp.z > 1 || tmp.z < -1) continue;
      const x = R.left + ((tmp.x + 1) / 2) * R.width, y = R.top + ((1 - tmp.y) / 2) * R.height;
      const d = (x - e.clientX) ** 2 + (y - e.clientY) ** 2;
      if (d < dmin) { dmin = d; best = p; }
    }
    if (best) montrerBulle(best, e.clientX, e.clientY); else cacherBulle();
  }
  function brancherSurvol() {
    const cv = app.renderer?.domElement;
    if (!cv || cv.dataset.diagramme) return;
    cv.dataset.diagramme = '1';
    cv.addEventListener('pointermove', (e) => {
      if (!etat.visible || e.buttons) { if (!bulle.hidden) cacherBulle(); return; }
      dernier = e;
      if (!rafSurvol) rafSurvol = requestAnimationFrame(survol3D);
    }, { passive: true });
    cv.addEventListener('pointerleave', cacherBulle, { passive: true });
  }

  // ---------------------------------------------------------------
  // 2D : projection polaire équidistante (r = (90 - h) / 90), N en haut
  // ---------------------------------------------------------------
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const R2 = 100;
  const vers2D = (az, alt) => { const r = ((90 - alt) / 90) * R2, a = az * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };
  const chemin = (L) => L.map((p, i) => { const [x, y] = vers2D(p.az, p.alt); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join('');
  let points2D = [];
  const ARDOISE = '#2f3b45';
  // contenu SVG du diagramme 2D (repère : centre (0, 0), horizon à R2 = 100, textes jusqu'à ± 124), attributs en ligne
  // (même dessin dans le panneau, les exports SVG / PNG et la planche à l'échelle)
  function contenuSVG() {
    colorier();
    const D = calculer();
    const o = [];
    const f1 = (v) => v.toFixed(1);
    const texte = (x, y, t, { taille = 6.5, couleur = '#55616b', ancre = 'middle', gras = false } = {}) => `<text x="${f1(x)}" y="${f1(y)}" font-size="${taille}" fill="${couleur}" text-anchor="${ancre}"${gras ? ' font-weight="700"' : ''}>${t}</text>`;
    o.push('<g id="grille" fill="none" stroke="#b9c1c7" stroke-width="0.5">');
    for (let a = 0; a <= 75; a += 15) o.push(`<circle cx="0" cy="0" r="${f1(((90 - a) / 90) * R2)}"${a ? '' : ' stroke="#6b7680" stroke-width="0.9"'}/>`);
    for (let z = 0; z < 360; z += 30) { const [x, y] = vers2D(z, 0); o.push(`<line x1="0" y1="0" x2="${f1(x)}" y2="${f1(y)}"/>`); }
    o.push('</g>');
    points2D = [];
    o.push(`<g id="courbes" fill="none" stroke="${ORANGE}" stroke-linejoin="round">`);
    D.jours.forEach((L, m) => {
      if (!dansMois(m)) return;
      for (const sm of morceaux(L, (p) => p.alt > 0 && dansHeures(Math.floor(p.hn)))) o.push(`<path d="${chemin(sm)}" stroke-width="1.1"/>`);
      for (const p of L) if (p.alt > 0 && Number.isInteger(p.hn * 2) && dansHeures(Math.floor(p.hn))) points2D.push(p);
    });
    const pts = [], heures = [];
    for (const L of D.analemmes) {
      if (!dansHeures(L[0].hn)) continue;
      for (const sm of morceaux(L, (p) => p.alt > 0 && dansMois(p.mois), true)) o.push(`<path d="${chemin(sm)}" stroke-width="0.9" opacity="0.85"/>`);
      for (const p of L) {
        if (p.alt <= 0 || !dansMois(p.mois)) continue;
        points2D.push(p);
        const c = couleurPoint(p);
        if (c) { const [x, y] = vers2D(p.az, p.alt); pts.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="1.5" fill="rgb(${c.join(',')})"/>`); }
      }
      const p = L.reduce((a, b2) => (b2.alt > a.alt ? b2 : a));
      if (p.alt > 4) { const [x, y] = vers2D(p.az, p.alt + 3); heures.push(texte(x, y, `${p.hn}`, { taille: 5, couleur: '#9a6200' })); }
    }
    o.push('</g>', `<g id="points">${pts.join('')}</g>`);
    o.push('<g id="textes">');
    const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
    for (let z = 0; z < 360; z += 30) {
      const r = R2 + (z % 180 ? 5 : 8), a = z * Math.PI / 180;
      if (CARD[z] != null && z % 180) { // E et O : lettre au-dessus des degrés
        const x = (z < 180 ? 1 : -1) * (R2 + 11);
        o.push(texte(x, -1.5, CARD[z], { gras: true, couleur: ARDOISE }), texte(x, 6.5, `${z}°`));
      } else o.push(texte(r * Math.sin(a), -r * Math.cos(a) + 2.5, CARD[z] ? `${CARD[z]} ${z}°` : `${z}°`, { ancre: z % 180 ? (z < 180 ? 'start' : 'end') : 'middle', gras: !!CARD[z], couleur: CARD[z] ? ARDOISE : '#55616b' }));
    }
    for (let a = 15; a <= 75; a += 15) o.push(texte(2, -((90 - a) / 90) * R2 - 1.5, `${a}°`, { taille: 5, couleur: '#8a949c', ancre: 'start' }));
    o.push(...heures, '</g>');
    const s0 = app.soleil?.etat;
    if (s0?.altitude > 0) { const [x, y] = vers2D(s0.azimut, s0.altitude); o.push(`<circle id="soleil-courant" class="soleil" cx="${f1(x)}" cy="${f1(y)}" r="4.2" fill="${SOLEIL}" stroke="#8a5a00" stroke-width="1.4"/>`); }
    return o.join('');
  }
  function dessiner2D() {
    if (!ui.svg) return;
    ui.svg.innerHTML = contenuSVG();
    ui.point = ui.svg.querySelector('#soleil-courant') || el('circle', { r: 4.2, class: 'soleil', fill: SOLEIL, stroke: '#8a5a00', 'stroke-width': 1.4 });
    if (!ui.point.isConnected) ui.svg.append(ui.point);
    majPoint2D();
  }
  // titre et échelle de couleurs sous le diagramme (exports)
  function titreExport() {
    const d = app.soleil?.libelleDate?.() || '';
    return `Diagramme solaire — Nantes (${nombre(lat, 2)}° N), soleil du ${d} à ${String(app.soleil?.etat?.heure ?? '').replace('.', ',')} h`;
  }
  function legendeSVG(x, y, w, p) {
    const L = legendeAuto(true);
    if (!L?.degrade) return '';
    const D = L.degrade, id = `dgs${Math.round(Math.random() * 1e6)}`;
    const stops = D.stops.map(([u, c]) => `<stop offset="${u}" stop-color="rgb(${c.join(',')})"/>`).join('');
    return `<g id="echelle-couleurs"><defs><linearGradient id="${id}">${stops}</linearGradient></defs>`
      + `<text x="${x}" y="${y}" font-size="${p}" fill="${ARDOISE}">${L.degradeTitre}</text>`
      + `<rect x="${x}" y="${y + p * 0.5}" width="${w}" height="${p * 1.1}" fill="url(#${id})" stroke="#c9cfd3" stroke-width="0.3"/>`
      + D.graduations.map((g, i) => `<text x="${x + g.u * w}" y="${y + p * 2.9}" font-size="${p * 0.9}" fill="#55616b" text-anchor="${i ? (i === D.graduations.length - 1 ? 'end' : 'middle') : 'start'}">${g.texte}</text>`).join('') + '</g>';
  }
  // SVG autonome (export) : diagramme, titre, échelle des couleurs
  function svgAutonome() {
    const T = R2 + 24, bas = echelle ? 22 : 6;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${(2 * T) * 4}" height="${(2 * T + 14 + bas) * 4}" viewBox="${-T} ${-T - 14} ${2 * T} ${2 * T + 14 + bas}" font-family="'IBM Plex Sans Condensed', 'Arial Narrow', Arial, sans-serif">`
      + `<rect x="${-T}" y="${-T - 14}" width="${2 * T}" height="${2 * T + 14 + bas}" fill="#ffffff"/>`
      + `<text x="${-T + 4}" y="${-T - 5}" font-size="6.5" font-weight="700" fill="${ARDOISE}">${titreExport()}</text>`
      + contenuSVG() + legendeSVG(-T + 6, T + 2, 2 * T - 12, 5) + '</svg>';
  }
  // cadre de la planche à l'échelle (js/planche.js) : boîte en mm
  function svgPlanche(b) {
    const T = R2 + 24, cote = Math.min(b.w, b.h - (echelle ? 10 : 4));
    const k = cote / (2 * T);
    return `<g id="diagramme-solaire"><g transform="translate(${(b.x + b.w / 2).toFixed(2)} ${(b.y + cote / 2).toFixed(2)}) scale(${k.toFixed(4)})">${contenuSVG()}</g>`
      + (echelle ? legendeSVG(b.x + 2, b.y + cote + 2.5, b.w - 4, 2.2) : '')
      + `<text x="${b.x}" y="${(b.y - 1).toFixed(2)}" font-size="2" fill="#5b6770">Diagramme solaire (vue du centre du plateau, nord en haut ; orange : 21 de chaque mois et analemmes UTC+1 ; jaune : soleil de la planche).</text></g>`;
  }
  async function exporterSVG() {
    telecharger(`atlas-diagramme-solaire-${horodatage()}.svg`, svgAutonome(), 'image/svg+xml');
  }
  async function exporterPNG(largeur = 1600) {
    const svg = svgAutonome();
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('SVG illisible')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = largeur; c.height = Math.round((largeur * img.height) / img.width);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const b = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    telecharger(`atlas-diagramme-solaire-${horodatage()}.png`, b, 'image/png');
    return { largeur: c.width, hauteur: c.height };
  }
  // vue 3D en PNG : le diagramme est affiché (mode « Diagramme solaire »), puis image de la vue (onglet Export, réglages de l'image)
  function exporter3D() {
    if (!etat.visible) app.soleil?.definirMode?.('diagramme');
    requestAnimationFrame(() => requestAnimationFrame(() => app.export?.exporterImage()));
  }
  const horodatage = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  function majPoint2D() {
    const s = app.soleil?.etat;
    if (!ui.point || !s || s.altitude == null) return;
    const [x, y] = vers2D(s.azimut, Math.max(s.altitude, 0));
    ui.point.setAttribute('cx', x.toFixed(1)); ui.point.setAttribute('cy', y.toFixed(1));
    ui.point.style.display = s.altitude > 0 ? '' : 'none';
    if (ui.position) ui.position.textContent = s.altitude > 0 ? `Soleil (barre Soleil) : hauteur ${nombre(s.altitude, 1)}°, azimut ${nombre(s.azimut, 1)}°.` : 'Soleil couché à l\'heure choisie.';
  }
  function survol2D(e) {
    const svg = ui.svg, R = svg.getBoundingClientRect();
    const k = (2 * (R2 + 24)) / Math.min(R.width, R.height); // unités SVG par pixel
    const x = (e.clientX - R.left - R.width / 2) * k, y = (e.clientY - R.top - R.height / 2) * k;
    let best = null, dmin = (6 * k) ** 2;
    for (const p of points2D) { const [px, py] = vers2D(p.az, p.alt); const d = (px - x) ** 2 + (py - y) ** 2; if (d < dmin) { dmin = d; best = p; } }
    if (best) montrerBulle(best, e.clientX, e.clientY); else cacherBulle();
  }

  // ---------------------------------------------------------------
  // Panneau (bloc inséré à la fin du panneau Soleil)
  // ---------------------------------------------------------------
  function bloc() {
    const opt = (v, l, sel, dis = false) => h('option', { value: v, selected: sel || undefined, disabled: dis || undefined }, l);
    ui.variable = h('select', { 'aria-label': 'Variable', onchange: (e) => regler({ variable: e.target.value }) },
      ...Object.entries(VARIABLES).map(([k, V]) => opt(k, V.libelle, k === etat.variable, k === 'neb' && !sourceEPW())));
    ui.svg = el('svg', { viewBox: `${-R2 - 24} ${-R2 - 24} ${2 * (R2 + 24)} ${2 * (R2 + 24)}`, class: 'diagramme-svg', role: 'img', 'aria-label': 'Diagramme solaire en projection polaire, nord en haut' });
    ui.svg.addEventListener('pointermove', survol2D);
    ui.svg.addEventListener('pointerleave', cacherBulle);
    ui.position = h('p', { class: 'diagramme-position', 'data-garder': '' });
    ui.source = h('p', { class: 'note' });
    const bouton = (t, titre, fn) => h('button', { type: 'button', class: 'bouton discret petit', title: titre, onclick: () => Promise.resolve(fn()).catch((e) => app.signaler(`Export impossible : ${e.message}`)) }, t);
    const div = h('div', { class: 'bloc-diagramme' },
      h('div', { class: 'titre-info' }, h('h3', {}, 'Diagramme solaire'),
        info('Diagramme de la course du soleil vu depuis le centre du plateau (comme le « Sun path chart » de CBE Clima, vue sphérique) : en orange, les trajectoires du 21 de chaque mois et les analemmes, une boucle « en 8 » par heure entière sur toute l\'année.',
          'Heures des analemmes en heure normale (UTC+1, heure d\'hiver) pour que chaque boucle soit continue ; l\'info-bulle donne aussi l\'heure légale.',
          'Sur la maquette (mode « Diagramme solaire » ci-dessus) : demi-sphère du rayon du plateau, sans surface, graduée tous les 15° de hauteur et d\'azimut ; le point jaune est la position du soleil de la barre Soleil.',
          'Variable : couleur des points horaires selon la source météo active (Climat). Météo-France : moyenne du mois à cette heure (2016-2025) ; fichier EPW : valeur de l\'heure du fichier (année type). La nébulosité n\'existe que dans un EPW.',
          'Exports : diagramme 2D en SVG (vecteurs) ou PNG ; vue 3D en PNG (image de la vue, réglages de l\'onglet Export) ; case « Diagramme solaire » de la planche à l\'échelle.',
          'Positions calculées par SunCalc (local), sans réfraction ni relief de l\'horizon.')),
      h('label', { class: 'ligne-diagramme' }, h('span', {}, 'Variable'), ui.variable),
      ui.svg, ui.position,
      h('div', { class: 'actions serrees' },
        bouton('SVG', 'Diagramme 2D en SVG (vecteurs)', exporterSVG),
        bouton('PNG', 'Diagramme 2D en image PNG', () => exporterPNG()),
        bouton('Vue 3D (PNG)', 'Image de la vue avec la demi-sphère', exporter3D)),
      ui.source); // dégradé des couleurs : légende automatique (js/legende.js)
    majSource();
    dessiner2D();
    return div;
  }
  function majSource() {
    if (ui.variable) for (const o of ui.variable.options) if (o.value === 'neb') o.disabled = !sourceEPW();
    if (etat.variable === 'neb' && !sourceEPW()) etat.variable = 'aucune';
    if (ui.variable) ui.variable.value = etat.variable;
    if (ui.source) ui.source.textContent = etat.variable === 'aucune' ? '' : `Couleurs : ${mention({ court: true })}`;
  }

  // ---------------------------------------------------------------
  // Réglages (case, variable, filtres) : panneau, points de vue
  // ---------------------------------------------------------------
  // demi-sphère affichée ou masquée (mode « Diagramme solaire » de l'outil Soleil)
  function afficher(v) {
    etat.visible = !!v;
    if (etat.visible) { brancherSurvol(); construire3D(); } else { detruire3D(); cacherBulle(); }
    app.emettre('legende');
  }
  // r.mode : mode de l'outil Soleil (points de vue) ; r.visible seul (vues plus anciennes) : diagramme ou rien
  function regler(r = {}) {
    if (r.variable && VARIABLES[r.variable]) etat.variable = r.variable;
    memoriser();
    majSource();
    const mode = r.mode ?? (r.visible != null ? (r.visible ? 'diagramme' : null) : null);
    if (mode && app.soleil?.definirMode) app.soleil.definirMode(mode);
    else if (r.visible != null && !r.visible && etat.visible) afficher(false);
    else if (etat.visible) construire3D();
    dessiner2D();
    app.emettre('legende');
  }
  const reglages = () => ({ visible: etat.visible, variable: etat.variable, mode: app.soleil?.mode });

  // légende automatique (js/legende.js) : diagramme affiché sur la maquette
  function legendeAuto(pourPanneau = false) {
    if (!etat.visible && !pourPanneau) return null;
    colorier();
    const V = VARIABLES[etat.variable];
    const S = {
      id: 'diagramme-solaire', titre: 'Diagramme solaire',
      items: [
        { libelle: 'Trajectoire du 21 de chaque mois', couleur: ORANGE, forme: 'trait' },
        { libelle: 'Analemme (même heure toute l\'année, UTC+1)', couleur: ORANGE, forme: 'trait' },
        { libelle: 'Position du soleil (barre Soleil)', couleur: SOLEIL, forme: 'cercle' },
        { libelle: 'Graduations : hauteur et azimut tous les 15°', couleur: '#5c6873', forme: 'trait' },
      ],
    };
    if (echelle) {
      const { min, max } = echelle, f = (v) => `${nombre(v, 0)} ${V.unite}`;
      S.degrade = { stops: echelle.stops, graduations: [min, (min + max) / 2, max].map((v) => ({ u: (v - min) / ((max - min) || 1), texte: f(v) })), gauche: V.gauche, droite: V.droite };
      S.degradeTitre = `${V.libelle}${sourceEPW() ? ' (EPW)' : ' (moyenne du mois, Météo-France)'}`;
      S.note = `Points horaires : ${V.libelle.toLowerCase()}${sourceEPW() ? ' (EPW, heure par heure)' : ' (moyenne du mois à cette heure, Météo-France)'}.`;
    }
    return S;
  }

  // ---------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------
  app.on('soleil', () => {
    if (groupe && app.config.rayonPlateau !== rayon) construire3D(); // rayon du plateau changé (outil Centre)
    if (donnees && app.soleil?.etat?.annee !== donnees.annee) { donnees = null; if (etat.visible) construire3D(); dessiner2D(); }
    majSoleil(); majPoint2D();
  });
  app.on('relief', () => { poser(); if (groupe) etiquettes(); });
  app.on('meteoSource', () => { majSource(); if (etat.visible) construire3D(); dessiner2D(); app.emettre('legende'); });
  if (!document.querySelector('link[href="css/complements.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/complements.css' }));

  return { etat, bloc, regler, reglages, afficher, legendeAuto, construire3D, texteBulle, points: () => survolables, contenuSVG, svgAutonome, svgPlanche, exporterSVG, exporterPNG, exporter3D };
}
