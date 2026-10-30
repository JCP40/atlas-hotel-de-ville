import * as THREE from 'three';
import { getPosition, getTimes } from '../lib/suncalc.js';
import { dateParis, formaterHeure, polygonesLocaux } from './geo.js';
import { h, info, MOIS, jourDeLAnnee, dateDepuisJour } from './util.js';
import { saisonArbres, visibiliteBatiment, COULEURS } from './maquette.js';
import { creerDiagrammeSolaire } from './diagramme-solaire.js';

const RAD = Math.PI / 180;
const HEURES_RAPIDES = [10, 13, 16]; // boutons de la barre Soleil (heure légale)
// jours rapides de la barre Soleil (mois 0-11, jour) : solstices et équinoxes
const JOURS_RAPIDES = [
  { id: 'ete', libelle: 'Solstice d\'été', mois: 5, jour: 21, note: 'jour le plus long' },
  { id: 'hiver', libelle: 'Solstice d\'hiver', mois: 11, jour: 21, note: 'jour le plus court' },
  { id: 'printemps', libelle: 'Équinoxe 20 mars', mois: 2, jour: 20, note: 'jour et nuit égaux' },
  { id: 'automne', libelle: 'Équinoxe 22 sept.', mois: 8, jour: 22, note: 'jour et nuit égaux' },
];
const MODES = { aucun: 'Aucun', trajectoire: 'Trajectoire simple', diagramme: 'Diagramme solaire' };
const CLE_MODE = 'atlas-hdv-soleil-mode'; // mode d'affichage préféré (outil Soleil)

// Direction (vecteur unitaire) vers le soleil dans le repère local : x = est, z = sud.
// SunCalc 2 donne l'azimut en degrés depuis le nord, dans le sens horaire.
export function directionSoleil(az, alt) {
  const a = az * RAD, e = alt * RAD;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

export function creerSoleil(app) {
  const { lat, lon } = app.config.soleil;
  const maintenant = new Date();
  const etat = {
    annee: maintenant.getFullYear(),
    jour: jourDeLAnnee(maintenant),
    heure: 15,
    trajectoire: false,
    mode: (() => { try { const m = localStorage.getItem(CLE_MODE); if (MODES[m]) return m; } catch { /* stockage indisponible */ } return 'trajectoire'; })(),
    lecture: null,
    carte: null,
  };

  const groupeTrajectoire = new THREE.Group();
  groupeTrajectoire.visible = false;
  app.scene.add(groupeTrajectoire);
  const disque = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
  groupeTrajectoire.add(disque);

  const ui = { carteEtat: h('p'), ombre: h('p') }; // remplacés par ceux du panneau quand il est ouvert

  function date() {
    const d = dateDepuisJour(etat.annee, etat.jour);
    return dateParis(d.annee, d.mois, d.jour, etat.heure);
  }

  function libelleDate() {
    const d = dateDepuisJour(etat.annee, etat.jour);
    return `${d.jour} ${MOIS[d.mois]}`;
  }

  function horaires() {
    const d = dateDepuisJour(etat.annee, etat.jour);
    return getTimes(dateParis(d.annee, d.mois, d.jour, 12), lat, lon);
  }

  function heureLocale(dt) {
    if (!dt) return null;
    const s = dt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    return s.replace(':', ' h ');
  }

  function maj() {
    const d = date();
    const pos = getPosition(d, lat, lon);
    const dir = directionSoleil(pos.azimuth, pos.altitude);
    const lumiere = app.lumieres.soleil;
    lumiere.position.copy(dir).multiplyScalar(1500);
    lumiere.target.position.set(0, 0, 0);
    const jour = Math.min(Math.max(pos.altitude / 12, 0), 1);
    lumiere.intensity = 2.6 * jour;
    lumiere.color.setHSL(0.1, 0.6 * (1 - jour) + 0.15, 0.62 + 0.3 * jour);
    app.lumieres.hemi.intensity = 0.45 + 0.9 * Math.min(Math.max((pos.altitude + 6) / 18, 0), 1);
    const ciel = new THREE.Color(COULEURS.ciel).lerp(new THREE.Color(0x46525c), 1 - Math.min(Math.max((pos.altitude + 4) / 10, 0), 1));
    app.scene.background.copy(ciel);
    app.scene.fog.color.copy(ciel);
    saisonArbres(app, d);

    const rTraj = app.config.rayonPlateau * 1.6;
    disque.position.copy(dir).multiplyScalar(rTraj);
    disque.visible = pos.altitude > 0;

    if (ui.infos?.isConnected) {
      const t = horaires();
      ui.infos.textContent = `Le ${libelleDate()} à ${formaterHeure(etat.heure)} (barre Soleil en haut à droite). ` + (pos.altitude > 0
        ? `Hauteur du soleil ${pos.altitude.toFixed(0)}°, azimut ${pos.azimuth.toFixed(0)}°. Lever ${heureLocale(t.sunrise)}, coucher ${heureLocale(t.sunset)}.`
        : `Le soleil est couché. Lever ${heureLocale(t.sunrise)}, coucher ${heureLocale(t.sunset)}.`);
      ui.ombre.textContent = '';
      const n = app.climat?.normalesDuMois(d.getMonth());
      if (n) ui.infos.append(` Normales de ce mois : ${String(n.tmin).replace('.', ',')} à ${String(n.tmax).replace('.', ',')} °C.`);
    }
    etat.altitude = pos.altitude;
    etat.azimut = pos.azimuth;
    majBarre(pos);
    app.emettre('soleil', { date: d, altitude: pos.altitude, azimut: pos.azimuth });
  }

  // ---------------------------------------------------------------
  // Barre du temps (en haut à droite, toujours visible) : SEUL réglage de la date et de l'heure de l'atlas (23/10/2026).
  // Curseur « jour de l'année » (molette dessus : ± 1 jour) avec la date, curseur d'heure légale (molette : ± 15 min),
  // heures rapides 10 h / 13 h / 16 h, lecture de la journée, jours rapides (solstices, équinoxes), lever, coucher et
  // durée du jour. Styles : css/complements.css et css/etudes.css.
  // ---------------------------------------------------------------
  const barre = {};
  const joursAnnee = () => ((etat.annee % 4 === 0 && etat.annee % 100 !== 0) || etat.annee % 400 === 0 ? 366 : 365);
  const heureDe = (dt) => {
    const p = dt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric' }).split(':');
    return +p[0] + +p[1] / 60;
  };
  // durée du jour (lever → coucher) en heures, pour un jour de l'année
  function dureeJour(jour = etat.jour) {
    const d = dateDepuisJour(etat.annee, jour);
    const t = getTimes(dateParis(d.annee, d.mois, d.jour, 12), lat, lon);
    return t.sunrise && t.sunset ? (t.sunset - t.sunrise) / 3600e3 : null;
  }
  const texteDuree = (hh) => (hh == null ? '–' : `${Math.floor(hh)} h ${String(Math.round((hh % 1) * 60)).padStart(2, '0')}`.replace(' h 60', ' h 00'));
  function changerJour(j, { effacer = true } = {}) {
    const n = joursAnnee();
    etat.jour = ((Math.round(j) - 1 + n) % n) + 1;
    if (effacer) effacerCarte();
    maj();
    if (etat.trajectoire) dessinerTrajectoire();
  }
  function changerHeure(hh) {
    etat.heure = Math.min(23.75, Math.max(0, Math.round(hh * 4) / 4));
    maj();
  }
  function molette(el, pas, fn) {
    el.addEventListener('wheel', (e) => { e.preventDefault(); fn(e.deltaY < 0 ? pas : -pas); }, { passive: false });
  }
  function construireBarre() {
    const hote = document.getElementById('haut-droite');
    if (!hote || barre.el) return;
    if (!document.querySelector('link[href="css/complements.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/complements.css' }));
    if (!document.querySelector('link[href="css/etudes.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/etudes.css' }));
    barre.resume = h('span', { class: 'soleil-barre-resume' });
    barre.jour = h('input', { type: 'range', min: 1, max: joursAnnee(), step: 1, 'aria-label': 'Jour de l\'année (molette : un jour de plus ou de moins)', title: 'Jour de l\'année : glisser, ou molette de la souris (± 1 jour)' });
    barre.texteJour = h('output', { class: 'soleil-barre-heure' });
    barre.heure = h('input', { type: 'range', min: 0, max: 23.75, step: 0.25, 'aria-label': 'Heure légale du soleil', title: 'Heure légale : glisser, ou molette (± 15 min)' });
    barre.texteHeure = h('output', { class: 'soleil-barre-heure' });
    barre.jour.addEventListener('input', () => changerJour(+barre.jour.value));
    barre.heure.addEventListener('input', () => changerHeure(+barre.heure.value));
    molette(barre.jour, 1, (d) => changerJour(etat.jour + d));
    molette(barre.heure, 0.25, (d) => changerHeure(etat.heure + d));
    // heures rapides (heure légale) : 10 h, 13 h, 16 h ; l'heure active est surlignée par majBarre ; ▶ : lecture de la journée
    barre.rapides = HEURES_RAPIDES.map((hh) => h('button', { type: 'button', class: 'soleil-heure-rapide', 'aria-pressed': 'false', title: `Soleil à ${hh} h (heure légale)`,
      onclick: () => changerHeure(hh) }, `${hh} h`));
    barre.lecture = h('button', { type: 'button', class: 'soleil-heure-rapide soleil-lecture', title: 'Jouer la journée (du lever au coucher, 20 s) ; recliquer pour arrêter', 'aria-pressed': 'false', onclick: jouerJournee }, '▶');
    barre.joursRapides = JOURS_RAPIDES.map((J) => h('button', { type: 'button', class: 'soleil-jour-rapide', 'aria-pressed': 'false', 'data-jour': J.id,
      onclick: () => changerJour(jourDeLAnnee(new Date(etat.annee, J.mois, J.jour))) }, J.libelle));
    barre.duree = h('p', { class: 'soleil-barre-duree', 'aria-live': 'polite' });
    barre.el = h('details', { class: 'soleil-barre', open: !window.matchMedia('(max-width: 820px)').matches },
      h('summary', { title: 'Soleil : date et heure (seul réglage, commun à tous les outils)' }, h('span', { 'aria-hidden': 'true', class: 'soleil-barre-icone' }, '☀'), barre.resume),
      h('div', { class: 'soleil-barre-corps' },
        h('label', {}, h('span', {}, 'Jour'), barre.jour, barre.texteJour),
        h('div', { class: 'soleil-barre-jours', role: 'group', 'aria-label': 'Jours rapides' }, ...barre.joursRapides),
        h('label', {}, h('span', {}, 'Heure'), barre.heure, barre.texteHeure),
        h('div', { class: 'soleil-barre-rapides', role: 'group', 'aria-label': 'Heures rapides' }, ...barre.rapides, barre.lecture),
        barre.duree));
    hote.append(barre.el);
  }
  function majBarre(pos) {
    if (!barre.el) return;
    barre.jour.max = joursAnnee();
    if (document.activeElement !== barre.jour) barre.jour.value = etat.jour;
    if (document.activeElement !== barre.heure) barre.heure.value = etat.heure;
    barre.texteJour.textContent = libelleDate();
    barre.texteHeure.textContent = formaterHeure(etat.heure);
    for (const [k, b] of barre.rapides.entries()) { const on = Math.abs(etat.heure - HEURES_RAPIDES[k]) < 0.01; b.classList.toggle('actif', on); b.setAttribute('aria-pressed', String(on)); }
    const d = dateDepuisJour(etat.annee, etat.jour);
    let note = '';
    for (const [k, b] of barre.joursRapides.entries()) {
      const J = JOURS_RAPIDES[k], on = d.mois === J.mois && d.jour === J.jour;
      if (on) note = J.note;
      b.classList.toggle('actif', on); b.setAttribute('aria-pressed', String(on));
      const dj = dureeJour(jourDeLAnnee(new Date(etat.annee, J.mois, J.jour)));
      b.title = `${J.libelle} : ${J.jour} ${MOIS[J.mois]}, ${J.note} (${texteDuree(dj)} de jour)`;
    }
    barre.lecture.classList.toggle('actif', !!etat.lecture);
    barre.lecture.textContent = etat.lecture ? '❚❚' : '▶';
    const t = horaires();
    barre.duree.textContent = t.sunrise && t.sunset
      ? `Lever ${heureLocale(t.sunrise)} · coucher ${heureLocale(t.sunset)} · jour ${texteDuree(dureeJour())}${note ? ` (${note})` : ''}`
      : '';
    barre.resume.textContent = `${libelleDate()}, ${formaterHeure(etat.heure)}${pos && pos.altitude <= 0 ? ' (nuit)' : ''}`;
  }

  function dessinerTrajectoire() {
    for (let i = groupeTrajectoire.children.length - 1; i >= 0; i--) {
      const c = groupeTrajectoire.children[i];
      if (c !== disque) { groupeTrajectoire.remove(c); c.geometry?.dispose(); }
    }
    app.etiquettes.retirerGroupe('trajectoire');
    const d = dateDepuisJour(etat.annee, etat.jour);
    const rTraj = app.config.rayonPlateau * 1.6;
    const pts = [];
    for (let hh = 0; hh <= 24; hh += 0.25) {
      const p = getPosition(dateParis(d.annee, d.mois, d.jour, hh), lat, lon);
      if (p.altitude > 0) pts.push(directionSoleil(p.azimuth, p.altitude).multiplyScalar(rTraj));
      if (Number.isInteger(hh) && hh % 3 === 0 && p.altitude > 2) {
        app.etiquettes.ajouter({
          texte: `${hh} h`,
          position: directionSoleil(p.azimuth, p.altitude).multiplyScalar(rTraj),
          classe: 'etiquette-heure',
          groupe: 'trajectoire',
          visibleSi: () => etat.trajectoire,
          distanceMax: 3000,
        });
      }
    }
    if (pts.length > 1) {
      const ligne = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0xc9912b, dashSize: 4, gapSize: 3 })
      );
      ligne.computeLineDistances();
      groupeTrajectoire.add(ligne);
    }
  }

  // ------------------------------------------------------------
  // Carte des heures d'ensoleillement cumulées
  // Méthode : on « tamponne » les hauteurs des obstacles dans une grille (1 px = 1 m),
  // puis, pour chaque point du sol et chaque position du soleil, on remonte le rayon vers le soleil.
  // ------------------------------------------------------------

  function zoneAnalyse(r = app.config.rayonPlateau) {
    return { x0: -r, z0: -r, x1: r, z1: r };
  }

  function grilleHauteurs(zone) {
    const marge = 220;
    const g = { x0: Math.floor(zone.x0 - marge), z0: Math.floor(zone.z0 - marge) };
    g.w = Math.ceil(zone.x1 + marge) - g.x0;
    g.h = Math.ceil(zone.z1 + marge) - g.z0;
    const c = document.createElement('canvas');
    c.width = g.w; c.height = g.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, g.w, g.h);
    const obstacles = [];
    // bâti effectif : existant non démoli + volumes du projet (js/projet.js)
    for (const e of app.batiEffectif?.() ?? app.empreintes ?? []) {
      if (!visibiliteBatiment({ ...app, vueMaquette: false }, e.cle)) continue;
      obstacles.push({ polys: e.polys, hauteur: e.hauteur });
    }
    const ajouterGroupe = (nom, test) => {
      const grp = app.groupes[nom];
      if (!grp) return;
      grp.traverse((o) => {
        if (!o.isMesh || !o.visible || !test(o)) return;
        const f = o.userData.feature;
        if (!f) return;
        const p = f.properties || {};
        const hh = parseFloat(p.hauteur) || (parseFloat(p.niveaux) || 4) * app.config.hauteurNiveau;
        if (f.geometry.type.includes('Polygon')) obstacles.push({ polys: polygonesLocaux(f.geometry, app.proj), hauteur: hh });
      });
    };
    ajouterGroupe('fantomes', () => app.etat === 'avant');
    // arbres : une couronne opaque, triée avec le bâti (le plus haut l'emporte) ; caducs comptés
    // seulement s'ils ont au moins la moitié de leur feuillage (feuillage() de maquette.js, date de la barre), couronne réduite comme à l'écran
    for (const [lot, liste] of Object.entries(app.arbres?.lots || {})) {
      const caduc = lot === 'caduc';
      if (caduc && (app.arbres.f ?? 1) < 0.5) continue;
      const e = caduc ? app.arbres.echelle ?? 1 : 1;
      for (const a of liste) obstacles.push({ cercle: [a.x, a.z, (a.d / 2) * e], hauteur: a.h });
    }
    obstacles.sort((a, b) => a.hauteur - b.hauteur);
    for (const o of obstacles) {
      const v = Math.min(255, Math.round(o.hauteur / 0.6));
      ctx.fillStyle = `rgb(${v},0,0)`;
      ctx.beginPath();
      if (o.cercle) { ctx.arc(o.cercle[0] - g.x0, o.cercle[1] - g.z0, o.cercle[2], 0, Math.PI * 2); ctx.fill(); continue; }
      for (const [ext, ...trous] of o.polys) {
        for (const anneau of [ext, ...trous]) {
          anneau.forEach(([x, z], i) => (i ? ctx.lineTo(x - g.x0, z - g.z0) : ctx.moveTo(x - g.x0, z - g.z0)));
          ctx.closePath();
        }
      }
      ctx.fill('evenodd');
    }
    const data = ctx.getImageData(0, 0, g.w, g.h).data;
    g.H = new Float32Array(g.w * g.h);
    for (let i = 0; i < g.H.length; i++) g.H[i] = data[i * 4] * 0.6;
    return g;
  }

  function hauteurEn(g, x, z) {
    const i = Math.floor(x - g.x0), j = Math.floor(z - g.z0);
    if (i < 0 || j < 0 || i >= g.w || j >= g.h) return 0;
    return g.H[j * g.w + i];
  }

  function estAuSoleil(g, x, z, sx, sz, tanAlt) {
    const hauteurOeil = 1.2;
    for (let s = 1; s < 450; s += 1) {
      const rayon = hauteurOeil + s * tanAlt;
      if (rayon > 150) return true;
      if (hauteurEn(g, x + sx * s, z + sz * s) > rayon) return false;
    }
    return true;
  }

  async function calculerCarte() {
    const zone = zoneAnalyse();
    const g = grilleHauteurs(zone);
    const d = dateDepuisJour(etat.annee, etat.jour);
    const pas = 2;
    const nx = Math.ceil((zone.x1 - zone.x0) / pas), nz = Math.ceil((zone.z1 - zone.z0) / pas);
    const soleils = [];
    const intervalle = 1 / 3; // toutes les 20 minutes
    for (let hh = 4; hh <= 23; hh += intervalle) {
      const p = getPosition(dateParis(d.annee, d.mois, d.jour, hh), lat, lon);
      if (p.altitude < 2) continue;
      const a = p.azimuth * RAD;
      soleils.push({ sx: Math.sin(a), sz: -Math.cos(a), tanAlt: Math.tan(p.altitude * RAD) });
    }
    const heures = new Float32Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        if (hauteurEn(g, x, z) > 0.5) continue; // sous un bâtiment ou un arbre
        let n = 0;
        for (const s of soleils) if (estAuSoleil(g, x, z, s.sx, s.sz, s.tanAlt)) n++;
        heures[j * nx + i] = n * intervalle;
      }
      if (j % 8 === 0) {
        ui.carteEtat.textContent = `Calcul en cours… ${Math.round((j / nz) * 100)} %`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const max = Math.max(1, ...heures);
    etat.carteMax = max;
    etat.carteDate = libelleDate();
    afficherCarte(zone, nx, nz, heures, max);
    ui.carteEtat.textContent = `Heures de soleil direct le ${libelleDate()}, à 1,20 m du sol${app.arbres?.hiver ? ' (arbres caducs sans feuilles)' : (app.arbres?.f ?? 1) < 0.97 ? ` (arbres caducs feuillés à ${Math.round(app.arbres.f * 100)} %)` : ''}.`;
    app.emettre('legende');
  }

  // de l'ombre (bleu ardoise) au plein soleil (jaune de Naples) ; aussi pour la légende automatique (js/legende.js)
  const STOPS_CARTE = [[0, [58, 76, 102]], [0.35, [120, 146, 170]], [0.65, [226, 214, 170]], [1, [242, 184, 64]]];
  function couleurCarte(t) {
    const stops = STOPS_CARTE;
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) {
        const [t0, c0] = stops[k - 1], [t1, c1] = stops[k];
        const u = (t - t0) / (t1 - t0);
        return c0.map((c, i) => Math.round(c + (c1[i] - c) * u));
      }
    }
    return stops[stops.length - 1][1];
  }

  function afficherCarte(zone, nx, nz, heures, max) {
    effacerCarte();
    const px = new Uint8Array(nx * nz * 4);
    for (let k = 0; k < heures.length; k++) {
      if (heures[k] < 0) continue;
      const c = couleurCarte(heures[k] / max);
      px.set([...c, 205], k * 4);
    }
    const tex = new THREE.DataTexture(px, nx, nz, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(zone.x1 - zone.x0, zone.z1 - zone.z0).rotateX(-Math.PI / 2);
    // la ligne 0 de la texture est au nord (z minimal)
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10 }));
    m.position.set((zone.x0 + zone.x1) / 2, 0.3, (zone.z0 + zone.z1) / 2);
    m.renderOrder = 5;
    m.raycast = () => {};
    app.scene.add(m);
    etat.carte = m;
  }

  function effacerCarte() {
    if (!etat.carte) return;
    app.scene.remove(etat.carte);
    etat.carte.geometry.dispose();
    etat.carte.material.map.dispose();
    etat.carte.material.dispose();
    etat.carte = null;
    app.emettre('legende');
  }

  // Part de la zone à l'ombre à l'instant choisi
  function mesurerOmbre() {
    const zone = zoneAnalyse();
    const g = grilleHauteurs(zone);
    const p = getPosition(date(), lat, lon);
    if (p.altitude <= 0) { ui.ombre.textContent = 'Nuit : toute la zone est dans l\'ombre.'; return; }
    const a = p.azimuth * RAD, tanAlt = Math.tan(p.altitude * RAD);
    let total = 0, ombre = 0;
    for (let z = zone.z0; z < zone.z1; z += 2) {
      for (let x = zone.x0; x < zone.x1; x += 2) {
        if (hauteurEn(g, x, z) > 0.5) continue;
        total++;
        if (!estAuSoleil(g, x, z, Math.sin(a), -Math.cos(a), tanAlt)) ombre++;
      }
    }
    const zoneNom = 'de la surface du plateau';
    ui.ombre.textContent = `Le ${libelleDate()} à ${formaterHeure(etat.heure)}, ${Math.round((ombre / Math.max(total, 1)) * 100)} % ${zoneNom} est à l'ombre.`;
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------

  // Modes d'affichage (23/10/2026) : « Trajectoire simple » (course du jour choisi, pointillés et heures) ou
  // « Diagramme solaire » (demi-sphère sans surface : trajectoires du 21 de chaque mois, analemmes, graduations, soleil courant).
  // etat.mode = préférence (localStorage atlas-hdv-soleil-mode), appliquée à l'ouverture de l'outil Soleil ;
  // masquerTrajectoires() (autre analyse d'Ambiance, js/ambiances.js) cache sans changer la préférence.
  function afficherMode(m) {
    etat.trajectoire = m === 'trajectoire';
    groupeTrajectoire.visible = etat.trajectoire;
    if (etat.trajectoire) dessinerTrajectoire();
    else app.etiquettes.retirerGroupe('trajectoire');
    app.diagrammeSolaire?.afficher?.(m === 'diagramme');
    app.emettre('legende');
  }
  function definirMode(m) {
    if (!MODES[m]) return;
    etat.mode = m;
    try { localStorage.setItem(CLE_MODE, m); } catch { /* stockage indisponible */ }
    afficherMode(m);
    ui.modes?.forEach((r) => { r.checked = r.value === m; });
  }

  function construirePanneau(conteneur) {
    ui.infos = h('p', { class: 'note' });
    ui.ombre = h('p', { class: 'resultat', 'aria-live': 'polite' });
    ui.carteEtat = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.modes = Object.keys(MODES).map((m) => h('input', { type: 'radio', name: 'soleil-mode', value: m, checked: etat.mode === m || undefined, onchange: () => definirMode(m) }));
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Affichage du soleil'),
        info('Date et heure : barre Soleil en haut à droite (curseur du jour, molette ± 1 jour, solstices, équinoxes, 10 h, 13 h, 16 h).',
          'Trajectoire simple : course du soleil le jour choisi, avec les heures. Diagramme solaire : demi-sphère du rayon du plateau, sans surface (trajectoires du 21 de chaque mois, analemmes, graduations, soleil courant), et diagramme polaire 2D ci-dessous.')),
      h('div', { class: 'choix choix-soleil', role: 'radiogroup', 'aria-label': 'Affichage du soleil' },
        ...Object.entries(MODES).map(([m, l], i) => h('label', {}, ui.modes[i], l))),
      ui.infos,
      h('h3', {}, 'Ombre et ensoleillement'),
      h('p', { class: 'note' }, `Calcul sur le plateau de la maquette (${Math.round(app.config.rayonPlateau * 2)} m de diamètre).`),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: mesurerOmbre }, 'Mesurer l\'ombre à cette heure'),
        h('button', { type: 'button', class: 'bouton', onclick: calculerCarte }, 'Calculer les heures de soleil'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { effacerCarte(); ui.carteEtat.textContent = ''; } }, 'Effacer la carte')),
      ui.ombre,
      ui.carteEtat,
      app.diagrammeSolaire?.bloc(), // diagramme solaire 2D, variable, exports (js/diagramme-solaire.js)
    );
    maj();
  }

  function jouerJournee() {
    if (etat.lecture) { cancelAnimationFrame(etat.lecture); etat.lecture = null; maj(); return; }
    const t = horaires();
    const debut = t.sunrise ? heureDe(t.sunrise) : 6, fin = t.sunset ? heureDe(t.sunset) : 21;
    const t0 = performance.now(), duree = 20000;
    const pas = (n) => {
      const u = Math.min((n - t0) / duree, 1);
      etat.heure = debut + (fin - debut) * u;
      etat.lecture = u < 1 ? requestAnimationFrame(pas) : null;
      maj();
    };
    etat.lecture = requestAnimationFrame(pas);
  }

  app.on('etat', () => { effacerCarte(); if (ui.carteEtat) ui.carteEtat.textContent = ''; });
  // bâti modifié par le projet : la carte affichée est recalculée si le panneau est ouvert
  app.on('bati', () => {
    const avait = !!etat.carte;
    effacerCarte();
    if (avait && ui.carteEtat?.isConnected) calculerCarte();
    else if (ui.carteEtat) ui.carteEtat.textContent = '';
  });

  construireBarre();
  // outil Soleil ouvert : mode d'affichage préféré rétabli (une autre ambiance a pu le masquer)
  app.on('outil', (id) => { if (id === 'soleil') afficherMode(etat.mode); });
  // diagramme solaire (demi-sphère 3D + SVG en fin de panneau) : créé ici pour ne pas toucher à app.js
  app.diagrammeSolaire = creerDiagrammeSolaire(app);

  // légende automatique (js/legende.js) : carte des heures de soleil affichée
  function legendeAuto() {
    const diag = app.diagrammeSolaire?.legendeAuto?.() ?? null; // diagramme solaire sur la maquette
    const carte = legendeCarte();
    return [carte, diag].filter(Boolean);
  }
  function legendeCarte() {
    if (!etat.carte) return null;
    const max = etat.carteMax || 1, f = (v) => `${v.toFixed(v % 1 ? 1 : 0).replace('.', ',')} h`;
    const grad = [0, max / 2, max];
    return { id: 'soleil', titre: `Heures de soleil direct le ${etat.carteDate || libelleDate()} (à 1,20 m du sol)`,
      degrade: { stops: STOPS_CARTE, graduations: grad.map((v) => ({ u: v / max, texte: f(Math.round(v * 10) / 10) })), gauche: 'à l\'ombre', droite: 'au soleil' } };
  }

  return {
    etat, maj, construirePanneau, calculerCarte, effacerCarte, date, legendeAuto, libelleDate,
    // trajectoire et diagramme masqués (une autre analyse d'Ambiance s'ouvre, js/ambiances.js)
    masquerTrajectoires() { afficherMode('aucun'); },
    definirMode, MODES, dureeJour, changerJour, changerHeure, jouerJournee,
    get mode() { return etat.mode; },
    hauteur: () => etat.altitude,
    grilleHauteurs, hauteurEn, zoneAnalyse,
    regler({ jour, heure } = {}) {
      if (jour != null) etat.jour = jour;
      if (heure != null) etat.heure = heure;
      maj();
      if (etat.trajectoire) dessinerTrajectoire();
    },
  };
}
