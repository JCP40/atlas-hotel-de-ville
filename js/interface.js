import * as THREE from 'three';
import { h, info } from './util.js';

const ICONES = {
  observateur: '<circle cx="7" cy="5" r="2"/><path d="M7 8v6m0 0-2 6m2-6 2 6M4.5 11h5"/><path d="m12 9 9-4v12l-9-4" stroke-dasharray="2 1.6"/>',
  vues: '<rect x="3" y="7" width="18" height="13" rx="1.5"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7 10 4h4l1.5 3"/>',
  couches: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  soleil: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>',
  coupes: '<path d="M3 20h18"/><path d="M5 20V9l4-3 4 3v11"/><path d="M13 20v-7h6v7"/><path d="M16 3v18" stroke-dasharray="2 2"/>',
  flux: '<path d="M3 7h13"/><path d="m13 4 3 3-3 3"/><path d="M21 17H8"/><path d="m11 14-3 3 3 3"/>',
  parcours: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5" stroke-dasharray="2.5 2"/>',
  fiches: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h5"/>',
  releve: '<path d="M4 20 15 9"/><path d="m14 5 5 5"/><path d="M13 6l2-2 5 5-2 2"/><path d="M4 20l1-4 3 3z"/>',
  climat: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0Z"/><path d="M12 9v7"/><path d="M17 6h3M17 10h2"/>',
  vent: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  centre: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  reseaux: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  confort: '<circle cx="8" cy="7" r="3"/><path d="M8 1.5v1.5M2.5 7H1M4.1 3.1 3 2M12.9 3.1 14 2"/><path d="M17 10v7.5a2.5 2.5 0 1 1-2 0V10a1 1 0 0 1 2 0Z"/><path d="M4 21c1-3 3-4 5-4"/>',
  chaleur: '<path d="M12 3c2.5 3 4 5.2 4 7.5a4 4 0 0 1-8 0C8 8.2 9.5 6 12 3Z"/><path d="M3 20h18"/><path d="M5 17h3M10.5 17h3M16 17h3"/>',
  bruit: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  trajets: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
  bati: '<path d="M4 21V8l6-4 6 4v13"/><path d="M16 11h4v10"/><path d="M2 21h20"/><path d="M8 10h4M8 14h4M8 18h4"/>',
  hauteurs: '<path d="M4 21V9h7v12"/><path d="M2 21h20"/><path d="M17 3v18M14.5 5.5 17 3l2.5 2.5M14.5 18.5 17 21l2.5-2.5"/>',
  projet: '<path d="M4 21V10l6-4 6 4v11"/><path d="M2 21h20"/><path d="M8 21v-5h4v5"/><path d="M19 2v6M16 5h6"/>',
  exporter: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>',
  relief: '<path d="M2 19 8 9l4 6 3-4 7 8Z"/><path d="M6.5 12.5 8 14l1.5-1.5"/>',
  psmv: '<path d="M4 4h16v16H4z"/><path d="M4 11h7v9M11 4v7h9"/><path d="M14 14h3v3h-3z"/>',
  fond: '<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2Z"/><path d="M9 4v14M15 6v14"/>',
  aide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/>',
};

const svg = (nom) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nom]}</svg>`;

// Onglets de la barre d'outils : chaque outil déclare son « groupe » dans I.ajouterOutil({ groupe, … }).
// Un onglet sans outil est masqué, sauf s'il porte un texte « aVenir » (panneau d'attente).
// horsBorne : onglet absent en mode borne.
const GROUPES = [
  { id: 'site', libelle: 'Site', titre: 'Lecture du site' },
  { id: 'topographie', libelle: 'Topo­graphie', titre: 'Topographie : relief et courbes de niveau' },
  { id: 'psmv', libelle: 'PSMV', titre: 'Cadastre et PSMV' },
  { id: 'fond', libelle: 'Fond de plan', titre: 'Fond de plan et plans anciens' },
  { id: 'batiments', libelle: 'Bâtiments', titre: 'Bâti existant et projet', horsBorne: true },
  { id: 'climat', libelle: 'Ambiance', titre: 'Ambiance : soleil, climat, vent, confort, chaleur et bruit' },
  { id: 'coupes', libelle: 'Coupes', titre: 'Coupes' },
  { id: 'vues', libelle: 'Vues', titre: 'Vues : points de vue, observateur et parcours' },
  { id: 'export', libelle: 'Export', titre: 'Exporter' },
];
const CLE_ONGLET = 'atlas-hdv-onglet';
const lireOnglet = () => { try { return localStorage.getItem(CLE_ONGLET); } catch { return null; } };
const memoriserOnglet = (id) => { try { localStorage.setItem(CLE_ONGLET, id); } catch { /* stockage indisponible */ } };

export function creerInterface(app) {
  const barre = document.getElementById('outils');
  const panneau = document.getElementById('panneau-outil');
  const titrePanneau = panneau.querySelector('h2');
  const contenu = panneau.querySelector('.panneau-contenu');
  const infobulle = document.getElementById('infobulle');
  const annonces = document.getElementById('annonces');
  const outils = [];
  let ouvert = null;

  // styles des onglets (index.html n'est pas modifié : la feuille est ajoutée ici)
  if (!document.querySelector('link[href="css/onglets.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/onglets.css' }));
  document.body.classList.add('avec-onglets');

  // ------------------------------------------------------------
  // Onglets : une rangée au-dessus des boutons d'outils
  // ------------------------------------------------------------
  const rangeeOnglets = h('div', { class: 'onglets-outils', role: 'tablist', 'aria-label': 'Groupes d\'outils' });
  const zoneBoutons = h('div', { class: 'outils-groupe', role: 'tabpanel' });
  barre.insertBefore(rangeeOnglets, barre.firstChild);
  barre.insertBefore(zoneBoutons, document.getElementById('bouton-aide'));
  const onglets = GROUPES.filter((g) => !(g.horsBorne && app.mode === 'borne')).map((g) => ({
    ...g,
    bouton: h('button', {
      type: 'button', class: 'onglet-outil', role: 'tab', 'aria-selected': 'false', 'data-groupe': g.id, title: g.titre,
      onclick: () => choisirGroupe(g.id, { ouvrirSeul: true }),
    }, g.libelle),
  }));
  rangeeOnglets.append(...onglets.map((o) => o.bouton));
  let groupeActif = lireOnglet() || 'site';
  const outilsDuGroupe = (id) => outils.filter((o) => o.groupe === id);

  function afficherGroupe(id) {
    groupeActif = id;
    onglets.forEach((o) => o.bouton.setAttribute('aria-selected', String(o.id === id)));
    outils.forEach((o) => { o.bouton.hidden = o.groupe !== id; });
  }

  // clic sur un onglet : ses outils s'affichent ; s'il n'en a qu'un, il s'ouvre
  function choisirGroupe(id, { ouvrirSeul = false } = {}) {
    const g = onglets.find((o) => o.id === id && !o.bouton.hidden);
    if (!g) return;
    afficherGroupe(id);
    memoriserOnglet(id);
    if (ouvert?.startsWith('onglet:') && ouvert !== `onglet:${id}`) fermer(); // panneau d'attente d'un autre onglet
    if (!ouvrirSeul) return;
    const liste = outilsDuGroupe(id);
    if (liste.length === 1) ouvrir(liste[0].id);
    else if (!liste.length && g.aVenir) ouvrirAVenir(g);
  }

  // une fois tous les outils déclarés : onglets vides masqués, onglet mémorisé restauré
  function validerOnglets() {
    for (const o of onglets) o.bouton.hidden = !outilsDuGroupe(o.id).length && !o.aVenir;
    const courant = outils.find((x) => x.id === ouvert);
    if (courant) groupeActif = courant.groupe;
    if (!onglets.some((o) => o.id === groupeActif && !o.bouton.hidden)) groupeActif = 'site';
    afficherGroupe(groupeActif);
  }
  setTimeout(validerOnglets, 0);

  // ------------------------------------------------------------
  // Outils et panneau
  // ------------------------------------------------------------
  function ajouterOutil(def) {
    if (def.masqueEnBorne && app.mode !== 'presentateur') return;
    if (def.horsBorne && app.mode === 'borne') return;
    const groupe = def.groupe || 'site';
    const b = h('button', { type: 'button', class: 'outil', 'aria-pressed': 'false', 'aria-controls': 'panneau-outil', title: def.raccourci ? `${def.libelle} (${def.raccourci})` : def.libelle, onclick: () => basculer(def.id) });
    b.innerHTML = svg(def.icone || def.id);
    b.append(h('span', {}, def.libelle));
    b.hidden = groupe !== groupeActif;
    zoneBoutons.append(b);
    outils.push({ ...def, groupe, bouton: b });
  }

  // Textes explicatifs, sources et références des panneaux : rangés derrière un bouton « i » placé à côté du titre
  // de leur section (h3). Ne sont pas touchés : notes vides ou mises à jour (aria-live, role), messages d'état
  // (« Aucun… », « Projet vide… »), notes imbriquées hors d'une section, panneaux Couches, Relief, PSMV et Fond, éléments [data-garder].
  const ETAT = /^(Aucun|Aucune|Projet vide|Bascule le calque|Hauteur du soleil|Le soleil est couché|Images absentes|Parcelles absentes|Lecture|Calcul en cours|\d+ bâtiment)/;
  function rangerNotes(racine) {
    const notes = [...racine.querySelectorAll('p.note, p.source')].filter((p) => {
      const t = p.textContent.trim();
      if (!t || ETAT.test(t) || p.hidden || p.hasAttribute('aria-live') || p.getAttribute('role') || p.closest('[data-garder], .info-panneau, li, label, table, details, .resultat')) return false;
      const parent = p.parentElement;
      return parent === racine || !!parent.querySelector(':scope > h3, :scope > .titre-info');
    });
    const groupes = new Map();
    for (const p of notes) {
      let titre = null;
      for (let e = p.previousElementSibling; e; e = e.previousElementSibling) if (e.matches('h3, .titre-info')) { titre = e; break; }
      const cle = titre || p.parentElement;
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(p);
    }
    for (const [cle, liste] of groupes) {
      liste.forEach((p) => p.remove());
      const existant = cle.matches?.('.titre-info') ? cle.querySelector('.info-panneau') : null;
      if (existant) { existant.append(...liste); continue; }
      const bouton = info(...liste);
      if (cle.matches?.('h3')) { const ligne = h('div', { class: 'titre-info' }); cle.replaceWith(ligne); ligne.append(cle, bouton); }
      else cle.prepend(h('div', { class: 'titre-info info-seul' }, h('span', { class: 'note' }, 'À propos'), bouton));
    }
  }

  function afficherPanneau(id, titre, construire) {
    ouvert = id;
    titrePanneau.textContent = titre;
    contenu.replaceChildren();
    construire(contenu);
    if (!['couches', 'relief', 'psmv', 'fond'].includes(id)) {
      rangerNotes(contenu);
      // sources remplies après lecture des données (météo…) : second passage
      setTimeout(() => { if (ouvert === id) rangerNotes(contenu); }, 1500);
    }
    panneau.hidden = false;
    document.body.classList.add('panneau-ouvert');
    outils.forEach((x) => x.bouton.setAttribute('aria-pressed', String(x.id === id)));
  }

  function ouvrir(id) {
    const o = outils.find((x) => x.id === id);
    if (!o) return;
    // un raccourci (K, W, C, L…) active l'onglet de son outil
    if (o.groupe !== groupeActif) { afficherGroupe(o.groupe); memoriserOnglet(o.groupe); }
    afficherPanneau(id, o.titre || o.libelle, o.construire);
    app.emettre('outil', id);
  }

  // onglet encore vide (Bâtiments) : panneau d'attente
  function ouvrirAVenir(g) {
    const etaitOutil = outils.some((x) => x.id === ouvert);
    afficherPanneau(`onglet:${g.id}`, g.titre, (c) => c.append(h('p', { class: 'note a-venir' }, g.aVenir)));
    if (etaitOutil) app.emettre('outil', null);
  }

  function fermer() {
    ouvert = null;
    panneau.hidden = true;
    document.body.classList.remove('panneau-ouvert');
    outils.forEach((x) => x.bouton.setAttribute('aria-pressed', 'false'));
    app.emettre('outil', null);
  }

  function basculer(id) { if (ouvert === id) fermer(); else ouvrir(id); }
  panneau.querySelector('.fermer').addEventListener('click', fermer);

  // ------------------------------------------------------------
  // Frise des trois états
  // ------------------------------------------------------------
  const frise = document.getElementById('frise-etats');
  const boutonsEtat = app.etatsActifs().map((e, i) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(app.etat === e.id), 'data-etat': e.id,
    onclick: () => app.temps.changer(e.id), title: `${e.libelle} (${i + 1})`,
  }, h('i', { 'aria-hidden': 'true' }), h('span', {}, e.libelle)));
  frise.append(...boutonsEtat);
  frise.classList.toggle('deux-etats', boutonsEtat.length === 2);
  // config.epoques = false : sélecteur d'époque retiré (une seule époque, « Aujourd'hui ») et ligne « 1 2 » de l'aide masquée
  frise.hidden = !app.epoques || boutonsEtat.length < 2;
  if (frise.hidden) [...document.querySelectorAll('#aide th')].find((c) => c.textContent.trim() === '1 2')?.closest('tr')?.remove();

  // Bascule maquette 3D / plan 2D
  const bascule = document.getElementById('bascule-vue');
  const boutonsVue = [['3d', 'Maquette 3D'], ['2d', 'Plan']].map(([v, l]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String((v === '2d') === !!app.vue2D), 'data-vue': v,
    title: `${l} (V)`, onclick: () => app.vue.basculer(v === '2d'),
  }, l));
  bascule.append(...boutonsVue);
  app.on('vue', (v) => boutonsVue.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.vue === v))));
  app.on('etat', (etat) => boutonsEtat.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.etat === etat))));

  // ------------------------------------------------------------
  // Annonces et infobulle
  // ------------------------------------------------------------
  function signaler(texte) {
    const el = h('p', { class: 'annonce' }, texte);
    annonces.append(el);
    setTimeout(() => el.classList.add('sortie'), 5200);
    setTimeout(() => el.remove(), 5800);
  }

  // ------------------------------------------------------------
  // Interaction avec la maquette : survol, clic, capture de points
  // ------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const souris = new THREE.Vector2();
  const planSol = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const canvas = app.renderer.domElement;
  let appui = null;
  let dernierSurvol = 0;

  function lancer(e) {
    const r = canvas.getBoundingClientRect();
    souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(souris, app.camera);
  }
  function objetSous(e) {
    lancer(e);
    const cibles = app.pickables.filter((o) => {
      let v = o; while (v) { if (!v.visible) return false; v = v.parent; } return true;
    });
    const hit = ray.intersectObjects(cibles, false).find((i) => (!app.renderer.clippingPlanes.length || app.renderer.clippingPlanes.every((p) => p.distanceToPoint(i.point) >= 0))
      && (!app.decoupe?.actif || app.decoupe.dedans(i.point)) && (!app.elements || app.elements.affiche(i.object)));
    return hit ? { objet: hit.object, instance: hit.instanceId, point: hit.point } : null;
  }
  function pointSol(e) {
    lancer(e);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(planSol, p) ? [p.x, p.z] : null;
  }

  canvas.addEventListener('pointerdown', (e) => { appui = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!appui || Math.hypot(e.clientX - appui.x, e.clientY - appui.y) > 6) { appui = null; return; }
    appui = null;
    if (app.captureSol) {
      // le second argument (l'événement) permet un lancer de rayon sur le bâti (outil Projet) ;
      // sansSol : la fonction accepte aussi un clic sans point au sol (ciel visé, bâtiment touché)
      const p = pointSol(e);
      if (p || app.captureSol.sansSol) app.captureSol(p, e);
      return;
    }
    const cible = objetSous(e);
    if (app.captureObjet) { app.captureObjet(cible?.objet); return; }
    if (cible?.objet.userData.fiche) { app.fiches.ouvrir(cible.objet.userData.fiche, { point: cible.point }); return; }
    // clic sur le sol (ou sur un bâtiment sans fiche) : la parcelle cadastrale, si la couche est active
    let p = cible?.point ? [cible.point.x, cible.point.z] : null;
    if (!p) {
      // clic sur un bâtiment ordinaire : on prend le point touché sur sa façade ou son toit
      const bati = app.scene.getObjectByName('batiments');
      const hit = bati && bati.visible ? ray.intersectObjects(bati.children.filter((m) => m.visible), false)[0] : null;
      p = hit ? [hit.point.x, hit.point.z] : pointSol(e);
    }
    if (p && app.cadastre?.clicSol(p)) return;
    if (cible?.objet.userData.nom) signaler(cible.objet.userData.nom);
  });
  canvas.addEventListener('pointermove', (e) => {
    const t = performance.now();
    if (t - dernierSurvol < 60 || e.buttons) return;
    dernierSurvol = t;
    const p = pointSol(e);
    if (p) app.emettre('pointeurSol', p);
    if (app.captureSol) {
      canvas.style.cursor = 'crosshair';
      infobulle.hidden = true;
      app.survolCapture?.(p, e); // surbrillance pendant une capture (démolition)
      return;
    }
    const cible = objetSous(e);
    const ud = cible?.objet.userData;
    if (ud?.nom) {
      infobulle.replaceChildren(...[h('strong', {}, ud.nom), ud.infobulle && ud.infobulle !== ud.nom ? h('span', {}, ud.infobulle) : null].filter(Boolean));
      infobulle.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
      infobulle.hidden = false;
      canvas.style.cursor = ud.fiche ? 'pointer' : 'default';
    } else {
      infobulle.hidden = true;
      canvas.style.cursor = '';
    }
  });
  canvas.addEventListener('pointerleave', () => { infobulle.hidden = true; });

  // ------------------------------------------------------------
  // Orientation (nord) et échelle graphique
  // ------------------------------------------------------------
  const nord = document.querySelector('#orientation .nord');
  const echelle = document.querySelector('#orientation .echelle');
  const echelleBarre = echelle.querySelector('i');
  const echelleTexte = echelle.querySelector('span');
  const dir = new THREE.Vector3();
  let derniereEchelle = 0;
  function majOrientation() {
    dir.subVectors(app.controls.target, app.camera.position);
    const angle = app.vue2D ? 0 : Math.atan2(dir.x, -dir.z);
    nord.style.transform = `rotate(${-angle}rad)`;
    const mParPx = app.vue.metresParPixel();
    const cibles = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    const m = cibles.find((c) => c / mParPx >= 70) || 500;
    if (m !== derniereEchelle || Math.abs(parseFloat(echelleBarre.style.width) - m / mParPx) > 2) {
      echelleBarre.style.width = `${Math.round(m / mParPx)}px`;
      echelleTexte.textContent = `${m} m`;
      derniereEchelle = m;
    }
  }
  nord.addEventListener('click', () => {
    if (app.vue2D) return;
    // remettre le nord en haut
    const t = app.controls.target;
    const d = app.camera.position.distanceTo(t);
    const hauteur = app.camera.position.y - t.y;
    const horizontal = Math.sqrt(Math.max(d * d - hauteur * hauteur, 1));
    app.camera.position.set(t.x, app.camera.position.y, t.z + horizontal);
  });

  // ------------------------------------------------------------
  // Aide
  // ------------------------------------------------------------
  const aide = document.getElementById('aide');
  aide.querySelector('.fermer').addEventListener('click', () => aide.close());
  const tableAide = aide.querySelector('table');
  if (tableAide && !aide.querySelector('.note-onglets')) {
    tableAide.after(h('p', { class: 'note note-onglets' },
      `Outils rangés en onglets (${onglets.map((o) => o.libelle).join(', ')}) : un raccourci ouvre l'outil et affiche son onglet.`));
  }

  // ------------------------------------------------------------
  // Clavier (mode présentateur et au-delà)
  // ------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const cible = e.target;
    if (cible.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (app.releve?.actif) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); app.chapitres.suivant(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); app.chapitres.precedent(); }
    else if ((k === '1' || k === '2' || k === '3') && app.epoques) { const e = app.etatsActifs()[+k - 1]; if (e) app.temps.changer(e.id); }
    else if (k === ' ' && app.parcours.actif) { e.preventDefault(); app.parcours.basculerPause(); }
    else if (k === 's' || k === 'S') basculer('soleil');
    else if (k === 'c' || k === 'C') basculer('coupes');
    else if (k === 'l' || k === 'L') basculer('couches');
    else if (k === 'm' || k === 'M') { app.definirVueMaquette(!app.vueMaquette); }
    else if (k === 'v' || k === 'V') app.vue.basculer();
    else if (k === 'b' || k === 'B') app.bati.modeSuivant();
    else if (k === 'k' || k === 'K') basculer('climat');
    else if (k === 'w' || k === 'W') basculer('vent');
    else if (k === 'e' || k === 'E') { app.couches.etiquettes = !app.couches.etiquettes; app.emettre('couches'); }
    else if (k === 'f' || k === 'F') {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
    } else if (k === 'h' || k === 'H' || k === '?') { if (aide.open) aide.close(); else aide.showModal(); }
    else if (k === 'Escape') {
      if (app.parcours.actif) app.parcours.arreter();
      else if (app.fiches.courante) app.fiches.fermer();
      else fermer();
    }
  });

  // ------------------------------------------------------------
  // Mode borne : sans interaction, l'atlas se présente tout seul
  // ------------------------------------------------------------
  const attente = { minuterie: null, actif: false, etape: 0, boucle: null };
  function arreterPresentation() {
    if (!attente.actif) return;
    attente.actif = false;
    clearTimeout(attente.boucle);
    app.parcours.arreter();
    document.body.classList.remove('presentation-auto');
  }
  function etapeSuivante() {
    if (!attente.actif) return;
    const n = app.chapitres.liste.length;
    if (attente.etape < n) {
      app.chapitres.aller(attente.etape);
      attente.etape++;
      attente.boucle = setTimeout(etapeSuivante, (app.config.attente?.dureeChapitre ?? 22) * 1000);
    } else {
      attente.etape = 0;
      app.parcours.demarrer();
      const verifier = () => { if (!attente.actif) return; if (app.parcours.actif) attente.boucle = setTimeout(verifier, 1000); else etapeSuivante(); };
      attente.boucle = setTimeout(verifier, 3000);
    }
  }
  function relancerAttente() {
    arreterPresentation();
    clearTimeout(attente.minuterie);
    if (app.mode !== 'borne') return;
    attente.minuterie = setTimeout(() => {
      attente.actif = true;
      attente.etape = 0;
      fermer();
      app.fiches.fermer();
      document.body.classList.add('presentation-auto');
      etapeSuivante();
    }, (app.config.attente?.delaiSecondes ?? 60) * 1000);
  }
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, relancerAttente, { passive: true }));

  return {
    ajouterOutil, ouvrir, fermer, signaler, relancerAttente, choisirGroupe,
    maj() { majOrientation(); },
    get ouvert() { return ouvert; },
    get groupe() { return groupeActif; },
  };
}
