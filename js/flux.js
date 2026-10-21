import * as THREE from 'three';
import { h } from './util.js';
import { lignesLocales } from './geo.js';
import { chargerJSON, lireParkings, enregistrerDonnees } from './donnees.js';
import { COULEURS } from './maquette.js';

// Couleurs des modes (lignes, arrêts, véhicules, légende du panneau)
export const COULEURS_FLUX = { bus: '#d9822b', tram: '#2a7f9e' };

// Flux autour de la mairie, pour appuyer l'argument de piétonnisation :
// - bus et tram : tracés OSM, fréquences théoriques réglables dans data/config.json (à reprendre du GTFS Naolib) ;
// - parkings : disponibilité en temps réel (Open Data Nantes Métropole) ou instantané enregistré.
export function creerFlux(app) {
  const cfg = app.config.flux || {};
  const acceleration = cfg.bus?.acceleration ?? 8;
  const groupe = new THREE.Group();
  groupe.name = 'flux';
  groupe.visible = false;
  app.scene.add(groupe);

  const etat = { modes: new Map(), chaines: [], vehicules: [], parkings: [], source: null, maj: null, rues: [], minuterie: null };
  const ui = {};
  const nomsVoies = new Map();
  for (const f of app.donnees.osm.voirie.features) {
    const id = String(f.properties?.osm || '').split('/')[1];
    if (id && f.properties?.name) nomsVoies.set(id, f.properties.name);
  }

  const frequence = (ref) => cfg.bus?.frequences?.[ref] ?? cfg.bus?.frequenceParDefaut ?? 6;

  // ---------------------------------------------------------------
  // Lignes : largeur du ruban proportionnelle au nombre de bus par heure
  // ---------------------------------------------------------------
  function construireLignes() {
    const parLigne = new Map();
    const rues = new Map();
    const pos = { bus: [], tram: [] };
    for (const f of app.donnees.osm.lignes.features) {
      const p = f.properties;
      const busParHeure = p.lignes.reduce((s, r) => s + 2 * frequence(r), 0); // deux sens
      const largeur = 0.6 + Math.min(busParHeure / 10, 6);
      for (const pts of lignesLocales(f.geometry, app.proj)) {
        for (let i = 1; i < pts.length; i++) {
          const [x1, z1] = pts[i - 1], [x2, z2] = pts[i];
          const l = Math.hypot(x2 - x1, z2 - z1);
          if (l < 0.05) continue;
          const nx = (-(z2 - z1) / l) * largeur / 2, nz = ((x2 - x1) / l) * largeur / 2;
          const y = 0.25;
          pos[p.mode === 'tram' ? 'tram' : 'bus'].push(x1 + nx, y, z1 + nz, x2 + nx, y, z2 + nz, x1 - nx, y, z1 - nz, x1 - nx, y, z1 - nz, x2 + nx, y, z2 + nz, x2 - nx, y, z2 - nz);
        }
        for (const r of p.lignes) {
          etat.modes.set(r, p.mode === 'tram' ? 'tram' : 'bus');
          if (!parLigne.has(r)) parLigne.set(r, { mode: p.mode, morceaux: [] });
          parLigne.get(r).morceaux.push(pts);
        }
        const dansPlateau = pts.some((q, k) => k > 0 && distanceOrigineSegment(pts[k - 1], q) < app.config.rayonPlateau);
        const nom = nomsVoies.get(String(p.voie).split('-')[0]);
        if (dansPlateau && nom) {
          const r = rues.get(nom) || { nom, lignes: new Set(), bus: 0 };
          p.lignes.forEach((x) => r.lignes.add(x));
          r.bus = [...r.lignes].reduce((s, x) => s + 2 * frequence(x), 0);
          rues.set(nom, r);
        }
      }
    }
    for (const mode of ['bus', 'tram']) {
      if (!pos[mode].length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos[mode], 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COULEURS_FLUX[mode], transparent: true, opacity: mode === 'tram' ? 0.6 : 0.5, depthWrite: false, side: THREE.DoubleSide }));
      m.name = `lignes-${mode}`;
      m.renderOrder = mode === 'tram' ? 2 : 1;
      m.raycast = () => {};
      groupe.add(m);
    }
    etat.rues = [...rues.values()].sort((a, b) => b.bus - a.bus);
    etat.chaines = [];
    for (const [ref, { mode, morceaux }] of parLigne) {
      for (const ch of chainer(morceaux)) {
        if (ch.length < 2) continue;
        const cumul = [0];
        for (let i = 1; i < ch.length; i++) cumul.push(cumul[i - 1] + Math.hypot(ch[i][0] - ch[i - 1][0], ch[i][1] - ch[i - 1][1]));
        if (cumul[cumul.length - 1] < 40) continue;
        etat.chaines.push({ ref, mode, pts: ch, cumul, longueur: cumul[cumul.length - 1], prochain: Math.random() * 20, sens: 1 });
      }
    }
  }

  // Assemble les morceaux de voies d'une même ligne en itinéraires continus
  function chainer(morceaux) {
    const reste = morceaux.map((m) => m.slice());
    const res = [];
    const proche = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
    while (reste.length) {
      let c = reste.shift();
      let ok = true;
      while (ok) {
        ok = false;
        for (let i = 0; i < reste.length; i++) {
          const m = reste[i];
          if (proche(c[c.length - 1], m[0])) c = c.concat(m.slice(1));
          else if (proche(c[c.length - 1], m[m.length - 1])) c = c.concat(m.slice(0, -1).reverse());
          else if (proche(c[0], m[m.length - 1])) c = m.slice(0, -1).concat(c);
          else if (proche(c[0], m[0])) c = m.slice(1).reverse().concat(c);
          else continue;
          reste.splice(i, 1); ok = true; break;
        }
      }
      res.push(c);
    }
    return res;
  }

  // Véhicules animés (temps accéléré)
  const MAX = 160;
  const geoBus = new THREE.BoxGeometry(12, 3.1, 2.55).translate(0, 1.55, 0);
  const geoTram = new THREE.BoxGeometry(32, 3.3, 2.65).translate(0, 1.65, 0);
  const bus = new THREE.InstancedMesh(geoBus, new THREE.MeshStandardMaterial({ color: COULEURS_FLUX.bus, roughness: 0.6 }), MAX);
  const trams = new THREE.InstancedMesh(geoTram, new THREE.MeshStandardMaterial({ color: COULEURS_FLUX.tram, roughness: 0.6 }), 40);
  bus.castShadow = trams.castShadow = true;
  bus.frustumCulled = trams.frustumCulled = false;
  bus.userData.pasDeRelief = trams.userData.pasDeRelief = true; // posés sur le relief à chaque image
  groupe.add(bus, trams);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), un = new THREE.Vector3(1, 1, 1), axeY = new THREE.Vector3(0, 1, 0);

  function positionSur(ch, d) {
    let i = 1;
    while (i < ch.cumul.length - 1 && ch.cumul[i] < d) i++;
    const a = ch.pts[i - 1], b = ch.pts[i];
    const t = (d - ch.cumul[i - 1]) / Math.max(ch.cumul[i] - ch.cumul[i - 1], 0.001);
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, angle: -Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }

  function majVehicules(dt) {
    const vitesse = 5.5 * acceleration;
    for (const ch of etat.chaines) {
      ch.prochain -= dt * acceleration;
      if (ch.prochain <= 0) {
        ch.prochain += 3600 / (2 * frequence(ch.ref));
        etat.vehicules.push({ ch, d: 0, sens: ch.sens });
        ch.sens *= -1;
      }
    }
    let nb = 0, nt = 0;
    etat.vehicules = etat.vehicules.filter((v) => {
      v.d += dt * vitesse;
      if (v.d > v.ch.longueur) return false;
      const p = positionSur(v.ch, v.sens > 0 ? v.d : v.ch.longueur - v.d);
      q.setFromAxisAngle(axeY, p.angle);
      m4.compose(new THREE.Vector3(p.x, 0.05 + (app.relief?.dz(p.x, p.z) ?? 0), p.z), q, un);
      if (v.ch.mode === 'tram') { if (nt < 40) trams.setMatrixAt(nt++, m4); }
      else if (nb < MAX) bus.setMatrixAt(nb++, m4);
      return true;
    });
    bus.count = nb; trams.count = nt;
    bus.instanceMatrix.needsUpdate = trams.instanceMatrix.needsUpdate = true;
  }

  function construireArrets() {
    app.etiquettes.retirerGroupe('arrets');
    const vus = [];
    for (const f of app.donnees.osm.arrets.features) {
      const [x, z] = app.proj.pt(f.geometry.coordinates);
      if (Math.hypot(x, z) > app.config.rayonEtude) continue;
      const nom = f.properties?.name || 'Arrêt';
      const pr = f.properties || {};
      const mode = pr.railway === 'tram_stop' || pr.tram === 'yes' ? 'tram' : 'bus';
      if (vus.some((v) => v.nom === nom && v.mode === mode && Math.hypot(v.x - x, v.z - z) < 40)) continue;
      vus.push({ nom, mode, x, z });
      app.etiquettes.ajouter({ texte: nom, position: new THREE.Vector3(x, 4, z), classe: `etiquette-arret etiquette-arret-${mode}`, groupe: 'arrets', distanceMax: 700, visibleSi: (a) => a.couches.flux });
    }
  }

  // ---------------------------------------------------------------
  // Parkings
  // ---------------------------------------------------------------
  const groupeParkings = new THREE.Group();
  groupe.add(groupeParkings);

  async function chargerParkings() {
    const enDirect = cfg.parkings?.url && app.mode !== 'borne' && navigator.onLine && cfg.parkings?.direct !== false;
    let liste = null;
    if (enDirect) {
      try {
        liste = await lireParkings(cfg.parkings.url);
        etat.source = 'direct';
        etat.maj = new Date();
      } catch (e) {
        console.warn('Parkings en direct indisponibles', e);
      }
    }
    if (!liste) {
      const rejeu = await chargerJSON('data/rejeu/parkings.json', null);
      liste = rejeu?.parkings || [];
      etat.source = liste.length ? 'rejeu' : 'aucune';
      etat.maj = rejeu?.date ? new Date(rejeu.date) : null;
    }
    etat.parkings = liste.map((p) => {
      const { x, z } = app.proj.versLocal(p.lat, p.lon);
      return { ...p, x, z, distance: Math.hypot(x, z) };
    }).filter((p) => p.distance <= (cfg.parkings?.rayon ?? 800)).sort((a, b) => a.distance - b.distance);
    dessinerParkings();
    majPanneau();
  }

  function dessinerParkings() {
    groupeParkings.clear();
    app.etiquettes.retirerGroupe('parkings');
    for (const p of etat.parkings) {
      if (p.disponibles == null) continue;
      const hauteur = Math.max(1.5, Math.min(p.disponibles / 8, 90));
      const taux = p.capacite ? 1 - p.disponibles / p.capacite : 0.5;
      const couleur = new THREE.Color(0x5e9384).lerp(new THREE.Color(COULEURS.coupe), Math.min(Math.max(taux, 0), 1));
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2, 3.2, hauteur, 24).translate(0, hauteur / 2, 0),
        new THREE.MeshStandardMaterial({ color: couleur, transparent: true, opacity: 0.85, roughness: 0.7 })
      );
      m.position.set(p.x, 0, p.z);
      m.userData = { nom: p.nom, infobulle: `${p.disponibles} places libres${p.capacite ? ` sur ${p.capacite}` : ''}` };
      groupeParkings.add(m);
      app.etiquettes.ajouter({ texte: `${p.nom} : ${p.disponibles}`, position: new THREE.Vector3(p.x, hauteur + 3, p.z), classe: 'etiquette-parking', groupe: 'parkings', distanceMax: 1600, visibleSi: (a) => a.couches.flux });
    }
  }

  async function enregistrerInstantane() {
    try {
      const liste = await lireParkings(cfg.parkings.url);
      await enregistrerDonnees('rejeu/parkings.json', JSON.stringify({ date: new Date().toISOString(), source: cfg.parkings.url, parkings: liste }, null, 2));
    } catch (e) {
      app.signaler(`Impossible de joindre l'Open Data de Nantes Métropole (${e.message}).`);
    }
  }

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  function majPanneau() {
    if (!ui.parkings) return;
    const libres = etat.parkings.reduce((s, p) => s + (p.disponibles || 0), 0);
    const quand = etat.maj ? etat.maj.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : null;
    ui.source.textContent = {
      direct: `En direct, mis à jour le ${quand}.`,
      rejeu: `Instantané enregistré${quand ? ` le ${quand}` : ''} (pas de connexion en direct).`,
      aucune: 'Aucune donnée : connectez-vous, ou enregistrez un instantané pour le mode borne.',
    }[etat.source] || '';
    ui.parkings.replaceChildren(
      etat.parkings.length ? h('p', { class: 'resultat' }, `${libres} places libres dans ${etat.parkings.length} parkings publics à moins de ${cfg.parkings?.rayon ?? 800} m de la mairie.`) : '',
      h('ul', { class: 'liste-donnees' }, ...etat.parkings.map((p) => h('li', {},
        h('span', {}, p.nom), h('span', {}, p.disponibles != null ? `${p.disponibles}${p.capacite ? ` / ${p.capacite}` : ''}` : '—'), h('span', { class: 'discret' }, `${Math.round(p.distance)} m`)))),
    );
    ui.rues.replaceChildren(
      ...(etat.rues.length ? etat.rues.slice(0, 6).map((r) => h('li', {}, h('span', {}, r.nom), h('span', {}, ...[...r.lignes].map((x, k) => h('span', { style: { color: COULEURS_FLUX[etat.modes.get(x)] || 'inherit', fontWeight: 600 } }, (k ? ', ' : '') + x))), h('span', {}, `≈ ${Math.round(r.bus)} /h`)))
        : [h('li', {}, 'Aucune ligne dans le plateau (données OSM absentes ?).')]),
    );
  }

  function construirePanneau(conteneur) {
    ui.source = h('p', { class: 'note' });
    ui.parkings = h('div');
    ui.rues = h('ul', { class: 'liste-donnees' });
    conteneur.append(
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: app.couches.flux, onchange: (e) => { app.couches.flux = e.target.checked; app.emettre('couches'); } }), 'Afficher les flux sur la maquette'),
      h('h3', {}, 'Bus et tram dans le plateau'),
      h('ul', { class: 'legende legende-flux' },
        h('li', {}, h('i', { style: { background: COULEURS_FLUX.tram } }), 'Tramway : lignes, rames et arrêts'),
        h('li', {}, h('i', { style: { background: COULEURS_FLUX.bus } }), 'Bus : lignes, véhicules et arrêts'),
        h('li', {}, h('i', { class: 'trait-largeur' }), 'Largeur du ruban : passages par heure')),
      h('p', { class: 'note' }, `Passages théoriques par heure, deux sens confondus. Fréquences à reprendre des horaires GTFS Naolib dans data/config.json. Animation en temps accéléré ×${acceleration}.`),
      ui.rues,
      h('h3', {}, 'Parkings publics'),
      ui.source,
      ui.parkings,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: chargerParkings }, 'Actualiser'),
        app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton discret', onclick: enregistrerInstantane }, 'Enregistrer un instantané') : null),
    );
    majPanneau();
  }

  function construire() {
    construireLignes();
    construireArrets();
    chargerParkings();
    clearInterval(etat.minuterie);
    etat.minuterie = setInterval(() => { if (app.couches.flux && etat.source === 'direct') chargerParkings(); }, 120000);
  }

  app.on('couches', () => { groupe.visible = app.couches.flux; });

  return {
    construire, construirePanneau, etat,
    maj(dt) { if (groupe.visible) majVehicules(Math.min(dt, 0.1)); },
  };
}

function distanceOrigineSegment([x1, z1], [x2, z2]) {
  const dx = x2 - x1, dz = z2 - z1;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, -(x1 * dx + z1 * dz) / l2));
  return Math.hypot(x1 + t * dx, z1 + t * dz);
}
