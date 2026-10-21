import * as THREE from 'three';
import { getPosition, getTimes } from '../lib/suncalc.js';
import { dateParis, formaterHeure, polygonesLocaux } from './geo.js';
import { h, MOIS, jourDeLAnnee, dateDepuisJour } from './util.js';
import { saisonArbres, visibiliteBatiment, COULEURS } from './maquette.js';

const RAD = Math.PI / 180;

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
    lecture: null,
    carte: null,
  };

  const groupeTrajectoire = new THREE.Group();
  groupeTrajectoire.visible = false;
  app.scene.add(groupeTrajectoire);
  const disque = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
  groupeTrajectoire.add(disque);

  const ui = {};

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

    if (ui.date) {
      ui.date.textContent = libelleDate();
      ui.heure.textContent = formaterHeure(etat.heure);
      ui.curseurJour.value = etat.jour;
      ui.curseurHeure.value = etat.heure;
      const t = horaires();
      ui.infos.textContent = pos.altitude > 0
        ? `Hauteur du soleil ${pos.altitude.toFixed(0)}°, azimut ${pos.azimuth.toFixed(0)}°. Lever ${heureLocale(t.sunrise)}, coucher ${heureLocale(t.sunset)}.`
        : `Le soleil est couché. Lever ${heureLocale(t.sunrise)}, coucher ${heureLocale(t.sunset)}.`;
      ui.ombre.textContent = '';
      const n = app.climat?.normalesDuMois(d.getMonth());
      if (n) ui.infos.append(` Normales de ce mois : ${String(n.tmin).replace('.', ',')} à ${String(n.tmax).replace('.', ',')} °C.`);
    }
    majBarre(pos);
    app.emettre('soleil', { date: d, altitude: pos.altitude, azimut: pos.azimuth });
  }

  // ---------------------------------------------------------------
  // Contrôle du soleil toujours visible (sous la bascule 3D / plan) : date et heure légale, compact,
  // utilisable pendant que Climat, Vent, Confort ou un autre outil est ouvert. Styles : css/complements.css.
  // ---------------------------------------------------------------
  const barre = {};
  function construireBarre() {
    const hote = document.getElementById('haut-droite');
    if (!hote || barre.el) return;
    if (!document.querySelector('link[href="css/complements.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/complements.css' }));
    barre.resume = h('span', { class: 'soleil-barre-resume' });
    barre.date = h('input', { type: 'date', 'aria-label': 'Date du soleil' });
    barre.heure = h('input', { type: 'range', min: 4, max: 23, step: 0.25, 'aria-label': 'Heure légale du soleil' });
    barre.texteHeure = h('output', { class: 'soleil-barre-heure' });
    const changer = () => { maj(); if (etat.trajectoire) dessinerTrajectoire(); };
    barre.date.addEventListener('change', () => {
      const [a, m, j] = barre.date.value.split('-').map(Number);
      if (!a || !m || !j) return;
      etat.annee = a; etat.jour = jourDeLAnnee(new Date(a, m - 1, j));
      effacerCarte(); changer();
    });
    barre.heure.addEventListener('input', () => { etat.heure = +barre.heure.value; changer(); });
    barre.el = h('details', { class: 'soleil-barre', open: !window.matchMedia('(max-width: 820px)').matches },
      h('summary', { title: 'Soleil : date et heure (réglage commun à tous les outils)' }, h('span', { 'aria-hidden': 'true', class: 'soleil-barre-icone' }, '☀'), barre.resume),
      h('div', { class: 'soleil-barre-corps' },
        h('label', {}, h('span', {}, 'Date'), barre.date),
        h('label', {}, h('span', {}, 'Heure'), barre.heure, barre.texteHeure)));
    hote.append(barre.el);
  }
  function majBarre(pos) {
    if (!barre.el) return;
    const d = dateDepuisJour(etat.annee, etat.jour);
    const iso = `${d.annee}-${String(d.mois + 1).padStart(2, '0')}-${String(d.jour).padStart(2, '0')}`;
    if (document.activeElement !== barre.date) barre.date.value = iso;
    if (document.activeElement !== barre.heure) barre.heure.value = etat.heure;
    barre.texteHeure.textContent = formaterHeure(etat.heure);
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
    // arbres : une couronne opaque (sauf caducs en hiver), triée avec le bâti (le plus haut l'emporte)
    for (const [lot, liste] of Object.entries(app.arbres?.lots || {})) {
      if (lot === 'caduc' && app.arbres.hiver) continue;
      for (const a of liste) obstacles.push({ cercle: [a.x, a.z, a.d / 2], hauteur: a.h });
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
    afficherCarte(zone, nx, nz, heures, max);
    ui.carteEtat.textContent = `Heures de soleil direct le ${libelleDate()}, à 1,20 m du sol${app.arbres?.hiver ? ' (arbres caducs sans feuilles)' : ''}.`;
    ui.legende.hidden = false;
    ui.legendeMax.textContent = `${max.toFixed(1).replace('.', ',')} h`;
  }

  function couleurCarte(t) {
    // de l'ombre (bleu ardoise) au plein soleil (jaune de Naples)
    const stops = [[0, [58, 76, 102]], [0.35, [120, 146, 170]], [0.65, [226, 214, 170]], [1, [242, 184, 64]]];
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
    etat.carte = null;
    if (ui.legende) ui.legende.hidden = true;
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

  function construirePanneau(conteneur) {
    ui.date = h('strong', { class: 'valeur' });
    ui.heure = h('strong', { class: 'valeur' });
    ui.curseurJour = h('input', { type: 'range', min: 1, max: 365, step: 1, 'aria-label': 'Jour de l\'année' });
    ui.curseurHeure = h('input', { type: 'range', min: 4, max: 23, step: 0.25, 'aria-label': 'Heure' });
    ui.curseurJour.addEventListener('input', () => { etat.jour = +ui.curseurJour.value; maj(); if (etat.trajectoire) dessinerTrajectoire(); effacerCarte(); });
    ui.curseurHeure.addEventListener('input', () => { etat.heure = +ui.curseurHeure.value; maj(); });
    ui.infos = h('p', { class: 'note' });
    ui.ombre = h('p', { class: 'resultat', 'aria-live': 'polite' });
    ui.carteEtat = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.legendeMax = h('span');
    ui.legende = h('div', { class: 'legende-soleil', hidden: true }, h('span', {}, '0 h'), h('i'), ui.legendeMax);

    const preset = (libelle, fn) => h('button', { type: 'button', class: 'puce', onclick: () => { fn(); maj(); if (etat.trajectoire) dessinerTrajectoire(); } }, libelle);
    const jours = { '21 mars': 80, '21 juin': 172, '21 septembre': 264, '21 décembre': 355 };

    conteneur.append(
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Date'), ui.date),
      ui.curseurJour,
      h('div', { class: 'puces' }, ...Object.entries(jours).map(([l, j]) => preset(l, () => { etat.jour = j; effacerCarte(); }))),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Heure légale'), ui.heure),
      ui.curseurHeure,
      h('div', { class: 'puces' },
        ...[9, 12, 15, 18].map((hh) => preset(`${hh} h`, () => { etat.heure = hh; })),
        preset('Maintenant', () => {
          const n = new Date();
          etat.annee = n.getFullYear(); etat.jour = jourDeLAnnee(n);
          const p = n.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric' }).split(':');
          etat.heure = +p[0] + +p[1] / 60;
          effacerCarte();
        })),
      ui.infos,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: jouerJournee }, 'Jouer la journée'),
        h('label', { class: 'case' },
          h('input', { type: 'checkbox', onchange: (e) => { etat.trajectoire = e.target.checked; groupeTrajectoire.visible = etat.trajectoire; if (etat.trajectoire) dessinerTrajectoire(); } }),
          'Course du soleil')),
      h('h3', {}, 'Ombre et ensoleillement'),
      h('p', { class: 'note' }, 'Calcul sur le plateau de la maquette (210 m de diamètre).'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: mesurerOmbre }, 'Mesurer l\'ombre à cette heure'),
        h('button', { type: 'button', class: 'bouton', onclick: calculerCarte }, 'Calculer les heures de soleil'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { effacerCarte(); ui.carteEtat.textContent = ''; } }, 'Effacer la carte')),
      ui.ombre,
      ui.carteEtat,
      ui.legende,
    );
    maj();
  }

  function jouerJournee() {
    if (etat.lecture) { cancelAnimationFrame(etat.lecture); etat.lecture = null; return; }
    const t = horaires();
    const heureDe = (dt) => {
      const p = dt.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric' }).split(':');
      return +p[0] + +p[1] / 60;
    };
    const debut = t.sunrise ? heureDe(t.sunrise) : 6, fin = t.sunset ? heureDe(t.sunset) : 21;
    const t0 = performance.now(), duree = 20000;
    const pas = (n) => {
      const u = Math.min((n - t0) / duree, 1);
      etat.heure = debut + (fin - debut) * u;
      maj();
      etat.lecture = u < 1 ? requestAnimationFrame(pas) : null;
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

  return {
    etat, maj, construirePanneau, calculerCarte, effacerCarte, date,
    grilleHauteurs, hauteurEn, zoneAnalyse,
    regler({ jour, heure } = {}) {
      if (jour != null) etat.jour = jour;
      if (heure != null) etat.heure = heure;
      maj();
      if (etat.trajectoire) dessinerTrajectoire();
    },
  };
}
