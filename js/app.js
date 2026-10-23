import * as THREE from 'three';
import { creerProjection, empriseAutour, polygonesLocaux, centroide, pointDansPolygone } from './geo.js';
import { chargerJSON, collection, interrogerOverpass, convertirOSM, interrogerCadastre, interrogerBDTopo, definirSignaleur } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';
import { creerVue } from './vue.js';
import { creerClimat } from './climat.js';
import { creerSourceMeteo } from './meteo-source.js';
import { creerCadastre } from './cadastre.js';
import { creerExport } from './export.js';
import { appliquerReglageCentre, creerCentre } from './centre.js';
import { creerBati } from './bati.js';
import { creerToits } from './toits.js';
import { creerTrajets } from './trajets.js';
import { creerConfort } from './confort.js';
import { creerChaleur } from './chaleur.js';
import { creerBruit } from './bruit.js';
import { creerVent } from './vent.js';
import { creerProjet } from './projet.js';
import { creerRues } from './rues.js';
import { creerImports } from './imports.js';
import { creerHauteurs } from './hauteurs.js';
import { creerDecoupe } from './decoupe.js';
import { creerElements } from './elements.js';
import { creerVuesRapides } from './vues-rapides.js';
import { creerLegende } from './legende.js';
import { creerRosesSaisons } from './roses-saisons.js';
import { creerPlanche } from './planche.js';
import {
  creerScene, creerSol, construireBatiments, construireVoirie, construireSurfaces, construireArbres,
  majBrouillard, arbresVueMaquette,
} from './maquette.js';
import { creerTemps } from './temps.js';
import { creerEtiquettes } from './etiquettes.js';
import { creerFiches } from './fiches.js';
import { construireFantomes, construireParcelles, construirePOI, CERTITUDES } from './couches.js';
import { creerCoupes } from './coupes.js';
import { creerSoleil } from './soleil.js';
import { creerFlux } from './flux.js';
import { creerCalques } from './calques.js';
import { creerTopo } from './topo.js';
import { creerRelief } from './relief.js';
import { creerReseaux } from './reseaux.js';
import { creerChapitres } from './chapitres.js';
import { creerVues } from './vues.js';
import { creerReleve } from './releve.js';
import { creerInterface } from './interface.js';
import { h, info, allerVers, jourDeLAnnee } from './util.js';

const app = {
  config: null,
  proj: null,
  mode: 'presentateur',
  donnees: {},
  groupes: {},
  pickables: [],
  etat: 'actuel',
  vueMaquette: false,
  couches: {
    etiquettes: true, poi: true, fantomes: false, parcelles: true, arbres: true,
    axes: true, rues: true, flux: false, cadastre: false, psmv: false, batimentsPSMV: false, topographie: false, teintes: false, reseaux: false, bruit: false,
  },
  captureSol: null,
  captureObjet: null,
  animationCamera: null,
  _ecouteurs: {},
  on(type, fn) { (this._ecouteurs[type] ??= []).push(fn); },
  emettre(type, detail) { for (const fn of this._ecouteurs[type] || []) fn(detail); },
  signaler(texte) { if (this.interface) this.interface.signaler(texte); else console.info(texte); },
};
window.atlas = app; // pratique pour explorer depuis la console du navigateur

const chargement = document.getElementById('chargement');
const etapeChargement = chargement.querySelector('.etape');
const etape = (t) => { etapeChargement.textContent = t; };
const pause = () => new Promise((r) => setTimeout(r, 0));

function bandeau(texte, lien) {
  const b = document.getElementById('bandeau');
  b.replaceChildren(...[h('p', {}, texte), lien ? h('a', { href: lien.href }, lien.texte) : null].filter(Boolean), h('button', { type: 'button', class: 'fermer', 'aria-label': 'Fermer', onclick: () => { b.hidden = true; } }, '×'));
  b.hidden = false;
}

// ------------------------------------------------------------------
// Données
// ------------------------------------------------------------------

async function chargerDonnees() {
  const vide = collection();
  const lire = (f, d = vide) => chargerJSON(`data/${f}`, d);
  etape('Lecture des contenus de l\'atlas…');
  const [fantomes, parcelles, arbres, fiches, chapitres, calques, psmv] = await Promise.all([
    lire('fantomes.geojson'), lire('parcelles.geojson'),
    lire('arbres.geojson'), lire('fiches.json', { fiches: [] }), lire('chapitres.json', { chapitres: [] }),
    lire('calques.json', { calques: [] }), lire('psmv/fiches.json', null),
  ]);
  Object.assign(app.donnees, { fantomes, parcelles, arbres, fiches, chapitres, calques, psmv });
  const enLigne = app.mode !== 'borne' && navigator.onLine;
  const emprise = empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.2);

  etape('Lecture du fond de plan…');
  const noms = ['batiments', 'voirie', 'surfaces', 'arbres', 'arrets', 'lignes', 'reseaux'];
  const osm = Object.fromEntries(await Promise.all(noms.map(async (n) => [n, await lire(`osm/${n}.geojson`, null)])));

  if (!osm.batiments) {
    const enCache = await lireCache(`osm2-${app.cleZone}`, 60);
    if (enCache) {
      for (const n of noms) osm[n] = enCache[n];
    } else if (enLigne) {
      try {
        etape('Première ouverture : lecture d\'OpenStreetMap en direct…');
        const conv = convertirOSM(await interrogerOverpass(emprise, etape));
        for (const n of noms) osm[n] = conv[n];
        await ecrireCache(`osm2-${app.cleZone}`, conv);
      } catch (err) {
        bandeau(`Fond de plan indisponible : ${err.message}. Ouvrez la page de préparation avec une connexion internet.`, { href: 'preparer.html', texte: 'Préparer les données' });
      }
    } else {
      bandeau('Fond de plan absent de data/osm. Préparez les données une fois avec une connexion internet.', { href: 'preparer.html', texte: 'Préparer les données' });
    }
  }
  for (const n of noms) osm[n] ??= vide;
  app.donnees.osm = osm;

  // OpenStreetMap indisponible (serveurs saturés) : le bâti est lu dans la BD TOPO de l'IGN, plus fiable
  let bdtopo = await lire('ign/batiments_bdtopo.geojson', null);
  if (!bdtopo && !osm.batiments.features.length && enLigne) {
    bdtopo = await lireCache(`bdtopo-${app.cleZone}`, 180);
    if (!bdtopo) {
      try {
        etape('Lecture du bâti dans la BD TOPO (IGN)…');
        bdtopo = await interrogerBDTopo(emprise, etape);
        await ecrireCache(`bdtopo-${app.cleZone}`, bdtopo);
      } catch (err) {
        console.warn('BD TOPO indisponible', err);
      }
    }
  }

  // Cadastre : fichier préparé, sinon cache, sinon API Carto de l'IGN en direct
  let cadastre = await lire('cadastre/parcelles.geojson', null);
  if (!cadastre) cadastre = await lireCache(`cadastre-${app.cleZone}`, 180);
  if (!cadastre && enLigne) {
    try {
      etape('Lecture du cadastre (IGN)…');
      cadastre = await interrogerCadastre(emprise, etape);
      await ecrireCache(`cadastre-${app.cleZone}`, cadastre);
    } catch (err) {
      console.warn('Cadastre indisponible', err);
      app.cadastreErreur = err.message;
    }
  }
  app.donnees.cadastre = cadastre || vide;

  // Bâti : la BD TOPO (hauteurs mesurées) est préférée quand elle a été préparée.
  // On lui transmet les noms et étiquettes OSM des bâtiments remarquables par superposition.
  if (bdtopo?.features?.length) {
    const osmPolys = osm.batiments.features.filter((f) => f.properties?.name || f.properties?.amenity).map((f) => ({ f, polys: polygonesLocaux(f.geometry, app.proj) }));
    for (const b of bdtopo.features) {
      const polys = polygonesLocaux(b.geometry, app.proj);
      if (!polys[0]) continue;
      const [cx, cz] = centroide(polys[0][0]);
      const o = osmPolys.find(({ polys: op }) => op.some(([ext]) => pointDansPolygone(cx, cz, ext)));
      if (o) {
        const { name, amenity, building, osm: id, start_date: sd } = o.f.properties;
        Object.assign(b.properties, { name, amenity, building, osm_superpose: id, start_date: sd });
      }
    }
    app.donnees.batiments = bdtopo;
    app.sourceBati = 'BD TOPO (IGN)';
  } else {
    app.donnees.batiments = osm.batiments;
    app.sourceBati = 'OpenStreetMap';
  }
}

// ------------------------------------------------------------------
// Vue maquette : le plateau seul, comme la maquette physique au 1/500
// ------------------------------------------------------------------

// Depuis le 21/10/2026 (js/decoupe.js) : tout est coupé net au bord du plateau, faces de coupe pochées, socle ;
// sol urbain (chaussées, trottoirs) gardé sur le plateau. Vue maquette par défaut (config.vueMaquetteParDefaut).
app.definirVueMaquette = (actif) => {
  app.vueMaquette = actif;
  app.sol.epaisseur.visible = actif;
  app.sol.sol.visible = !actif;
  const solUrbain = !actif || !!app.decoupe?.disponible;
  ['voirie', 'surfaces'].forEach((n) => { const g = app.scene.getObjectByName(n); if (g) g.visible = solUrbain && !app.fondActif; });
  arbresVueMaquette(app, actif);
  document.body.classList.toggle('vue-maquette', actif);
  app.temps.appliquer();
  app.decoupe?.appliquer();
  app.emettre('vueMaquette', actif);
};

app.reconstruireBatiments = () => {
  const ancien = app.scene.getObjectByName('batiments');
  if (ancien) {
    ancien.traverse((o) => { app.temps.retirer(o); const i = app.pickables.indexOf(o); if (i >= 0) app.pickables.splice(i, 1); });
    app.scene.remove(ancien);
  }
  app.etiquettes.retirerGroupe('batiments');
  // sans les bâtiments démolis par le projet (calque « Projet » affiché)
  construireBatiments(app, app.projet ? app.projet.filtrer(app.donnees.batiments) : app.donnees.batiments);
  app.cadastre?.majBatiments(true);
  app.bati?.appliquer();
  app.temps.appliquer({ instantane: true });
  app.decoupe?.appliquer(); // faces de coupe du nouveau bâti
};

// Bâti effectif : empreintes non démolies + volumes du projet, au format de app.empreintes
// ({ polys, hauteur, base, cle, rem, mesh, debut, nb, cx, cz } ; mesh null et projet: true pour un volume).
// Utilisé par Soleil (grilleHauteurs), Confort, Vent (preparerGrille) et l'export. Événement « bati » à chaque changement.
app.batiEffectif = () => (app.projet ? app.projet.batiEffectif() : (app.empreintes || []));

// ------------------------------------------------------------------
// Adresse du site et liens externes (cadastre, Géoportail de l'urbanisme)
// config.json : « adresse » (texte) et « liens » ({ cle: { libelle, titre, url } }).
// Les liens demandent une connexion : ils sont masqués en mode borne (hors ligne).
// ------------------------------------------------------------------

function blocAdresse() {
  const { adresse, liens } = app.config;
  const listeLiens = app.mode === 'borne' ? [] : Object.values(liens || {}).filter((l) => l && typeof l === 'object' && l.url);
  if (!adresse && !listeLiens.length) return null;
  return h('div', { class: 'adresse-site' },
    adresse ? h('p', { class: 'adresse' }, adresse) : null,
    listeLiens.length ? h('div', { class: 'actions liens-externes' }, ...listeLiens.map((l) => h('a', {
      class: 'bouton petit', href: l.url, target: '_blank', rel: 'noopener', title: l.titre || l.libelle,
    }, `${l.libelle} ↗`))) : null,
  );
}

// ------------------------------------------------------------------
// Panneau « Couches »
// ------------------------------------------------------------------

function panneauCouches(conteneur) {
  const bascule = (cle, libelle, apres) => h('label', { class: 'case' },
    h('input', { type: 'checkbox', checked: !!app.couches[cle], onchange: (e) => { app.couches[cle] = e.target.checked; apres?.(); app.temps.appliquer(); } }),
    libelle);
  const pastille = (couleur, libelle, opacite = 1) => h('li', {}, h('i', { style: { background: couleur, opacity: opacite } }), libelle);
  // Topographie, PSMV et Fond de plan sont des onglets de premier niveau (outils relief, psmv, fond) :
  // ce panneau garde la lecture et le bâti existant.
  const pages = { couches: h('div') };
  conteneur.append(...[blocAdresse(), pages.couches].filter(Boolean));

  // Couches : lecture, bâti existant, légende (derrière un « i »)
  const legende = info(
    h('ul', { class: 'legende' },
      ...Object.entries(CERTITUDES).map(([, c]) => pastille('#6F86A6', `Bâti disparu : ${c.libelle.toLowerCase()}`, c.opacite + 0.2))),
    h('p', {}, `Bâti existant : ${app.sourceBati}. Hauteurs par défaut quand la donnée manque (corrigibles par bâtiment : onglet Bâtiments, outil Hauteurs) ; toitures simplifiées en terrasses, sauf les ensembles détaillés (onglet Bâtiments > Bâti).`),
  );
  pages.couches.append(...[
    h('div', { class: 'titre-info' }, h('h3', {}, 'Lecture'), legende),
    bascule('poi', 'Points d\'intérêt'),
    // bâti disparu de 1943 : case masquée quand les époques sont retirées (config.epoques = false), code gardé
    app.epoques ? bascule('fantomes', 'Mémoire du bâti disparu (1943)') : null,
    bascule('parcelles', 'Parcelles vacantes'),
    bascule('axes', 'Axes de coupe', () => { const g = app.scene.getObjectByName('axes'); if (g) g.visible = app.couches.axes; }),
  ].filter(Boolean));
  // vue maquette, noms des rues, étiquettes, arbres et autres éléments : liste « Éléments de la maquette » (js/elements.js)
  app.elements.construireCommandes(pages.couches);
  // Bâti existant : titre et commandes visibles, explication et crédits des photos de façade derrière un « i »
  const textesBati = [];
  if (app.mode !== 'borne') textesBati.push(h('p', {}, 'Opaque, transparent ou masqué (touche B) : onglet Bâtiments, outil Bâti. Démolir et ajouter des volumes : outil Projet ; corriger une hauteur : outil Hauteurs.'));
  const credits = app.toits?.creditsFacades?.(); // attribution obligatoire
  if (credits) textesBati.push(h('p', { class: 'source' }, credits));
  pages.couches.append(textesBati.length ? h('div', { class: 'titre-info' }, h('h3', {}, 'Bâti existant'), info(...textesBati)) : h('h3', {}, 'Bâti existant'));
  // l'affichage du bâti est rangé dans l'onglet Bâtiments (absent en mode borne : il reste ici)
  if (app.mode === 'borne') app.bati.construireCommandes(pages.couches);
}

// Onglet Topographie : relief, courbes, teintes, profils
function panneauRelief(conteneur) {
  conteneur.append(h('h3', {}, 'Relief'));
  app.topo.construireCommandes(conteneur);
}

// Onglet PSMV : cadastre et couleurs du plan de sauvegarde
function panneauPSMV(conteneur) {
  const bascule = (cle, libelle) => h('label', { class: 'case' },
    h('input', { type: 'checkbox', checked: !!app.couches[cle], onchange: (e) => { app.couches[cle] = e.target.checked; app.temps.appliquer(); } }),
    libelle);
  conteneur.append(
    h('h3', {}, 'Cadastre et PSMV'),
    bascule('cadastre', 'Parcelles et numéros'),
    bascule('psmv', 'Parcelles colorées selon le PSMV'),
    bascule('batimentsPSMV', 'Bâtiments colorés selon le PSMV'),
  );
  app.cadastre.construireLegende(conteneur);
}

// Onglet Fond de plan : fonds au sol et plans anciens à caler (conteneur propre : remplirPanneau le redessine)
function panneauFond(conteneur) {
  conteneur.append(h('h3', {}, 'Fond au sol'));
  app.calques.construireCommandesSol(conteneur);
  const plans = h('div');
  conteneur.append(h('h3', {}, 'Plans anciens et calques'), plans);
  app.calques.remplirPanneau(plans);
}

// Ligne du tableau des raccourcis de l'aide (index.html), ajoutée après celle de la touche « apres »
// si elle n'y figure pas déjà
function ajouterLigneAide(apres, touche, texte) {
  const table = document.querySelector('#aide table');
  if (!table) return;
  const cellules = [...table.querySelectorAll('th, td')];
  if (cellules.some((c) => c.textContent.trim() === touche)) return;
  const ref = cellules.find((c) => c.textContent.trim() === apres)?.closest('tr');
  const ligne = h('tr', {}, h('th', {}, touche), h('td', {}, texte));
  if (ref) ref.after(ligne); else (table.tBodies[0] || table).append(ligne);
}

// ------------------------------------------------------------------
// Démarrage
// ------------------------------------------------------------------

async function demarrer() {
  etape('Lecture de la configuration…');
  app.config = await chargerJSON('data/config.json', null);
  if (!app.config) {
    chargement.querySelector('.etape').textContent = '';
    chargement.querySelector('.erreur').textContent = 'Le fichier data/config.json est introuvable. L\'atlas doit être ouvert via un petit serveur local : double-cliquez sur lancer-windows.bat ou lancer-mac.command (voir LISEZMOI).';
    return;
  }
  const params = new URLSearchParams(location.search);
  app.mode = ['borne', 'presentateur', 'web'].includes(params.get('mode')) ? params.get('mode') : (app.config.modeParDefaut || 'presentateur');
  document.body.dataset.mode = app.mode;
  appliquerReglageCentre(app, params);
  definirSignaleur((t) => app.signaler(t));
  app.cleZone = `${app.config.origine.lat.toFixed(4)},${app.config.origine.lon.toFixed(4)},${app.config.rayonEtude}`;
  document.title = `${app.config.titre}, ${app.config.sousTitre}`;
  document.querySelector('.cartouche h1').textContent = app.config.titre;
  document.querySelector('.cartouche .sous-titre').textContent = app.config.sousTitre;
  document.querySelector('.cartouche .auteur').textContent = app.config.auteur || '';

  const { lat, lon } = app.config.origine;
  app.proj = creerProjection(lat, lon);

  const s = creerScene(app);
  Object.assign(app, { renderer: s.renderer, scene: s.scene, camera: s.camera, controls: s.controls });
  app.vue = creerVue(app);
  app.lumieres = { soleil: s.soleil, hemi: s.hemi };
  app.temps = creerTemps(app);
  app.etiquettes = creerEtiquettes(app);
  app.fiches = creerFiches(app);

  await chargerDonnees();

  etape('Montage de la maquette…'); await pause();
  creerSol(app);
  app.decoupe = creerDecoupe(app); // vue maquette coupée net au bord du plateau
  app.elements = creerElements(app); // éléments de la maquette affichés ou masqués (Site > Couches)
  app.projet = creerProjet(app);
  app.imports = creerImports(app); // fichiers 3D importés (GLB, glTF, OBJ), lus avec projet.json
  app.toits = creerToits(app);
  await app.toits.charger(); // data/toits/hotel-de-ville.json : toitures détaillées de la mairie
  await app.projet.charger(); // data/projet.json : démolitions et volumes, avant de monter le bâti
  app.hauteurs = creerHauteurs(app);
  await app.hauteurs.charger(); // data/hauteurs.json : hauteurs corrigées par bâtiment
  construireBatiments(app, app.projet.filtrer(app.donnees.batiments));
  app.bati = creerBati(app);
  app.bati.appliquer();
  construireVoirie(app, app.donnees.osm.voirie);
  app.rues = creerRues(app); // noms des rues à plat sur la chaussée (couche « rues »)
  construireSurfaces(app, app.donnees.osm.surfaces);
  construireArbres(app, app.donnees.arbres, app.donnees.osm.arbres);
  await app.rues.demarrer(); // après les arbres : aucun nom posé sous une couronne

  etape('Couches de l\'atlas…'); await pause();
  construireFantomes(app);
  construireParcelles(app);
  construirePOI(app);

  app.cadastre = creerCadastre(app);
  app.cadastre.construire();
  app.coupes = creerCoupes(app);
  app.soleil = creerSoleil(app);
  app.meteoSource = creerSourceMeteo(app); // sélecteur « Source météo » (base Météo-France / EPW) des outils d'Ambiance
  app.climat = creerClimat(app);
  await app.climat.construire();
  app.flux = creerFlux(app);
  app.flux.construire();
  app.calques = creerCalques(app);
  await app.calques.construire();
  // la visite guidée a été retirée avec la phase projet : on garde une interface neutre
  app.parcours = { actif: false, arreter() {}, demarrer() {}, maj() {}, basculerPause() {}, construire() {} };
  app.topo = creerTopo(app);
  await app.topo.charger({ enDirect: false });
  app.relief = creerRelief(app);
  app.projet.construire();
  app.reseaux = creerReseaux(app);
  await app.reseaux.construire();
  app.confort = creerConfort(app);
  app.chaleur = creerChaleur(app); // outil Chaleur (onglet Ambiance) : matériaux, albédo, température de surface
  app.trajets = creerTrajets(app);
  app.bruit = creerBruit(app);
  await app.bruit.construire();
  app.vent = creerVent(app);
  // bâti modifié par le projet (événement « bati ») : la grille de hauteurs du Confort est à refaire
  // (Soleil et Vent écoutent eux-mêmes l'événement)
  app.on('bati', () => {
    const c = app.confort;
    const avait = !!c.etat.calque;
    c.effacerCarte();
    c.etat.grille = null;
    c.etat.svf = null;
    if (avait) app.signaler('Bâti modifié par le projet : relancez le calcul du Confort.');
  });
  app.on('etat', (e) => {
    if (e === 'avant' && !app.donnees.fantomes.features.length) app.signaler('Aucun bâti disparu n\'est encore dessiné : calez un plan ancien (onglet Fond de plan), puis dessinez les emprises avec l\'outil Relevé.');
  });
  app.chapitres = creerChapitres(app);
  app.vues = creerVues(app); // onglet Vues : points de vue enregistrés (data/vues.json), axonométrie, focale
  await app.vues.charger();
  app.vuesRapides = creerVuesRapides(app); // vues rapides sous la barre Soleil (même liste que l'onglet Vues)
  app.releve = creerReleve(app);

  const I = creerInterface(app);
  app.interface = I;
  // « groupe » : onglet de la barre d'outils (site, topographie, psmv, fond, batiments, climat, coupes, export ; voir GROUPES dans interface.js)
  I.ajouterOutil({ id: 'couches', groupe: 'site', libelle: 'Couches', titre: 'Couches de lecture', raccourci: 'L', construire: panneauCouches });
  I.ajouterOutil({ id: 'relief', groupe: 'topographie', libelle: 'Relief', titre: 'Topographie : relief et courbes de niveau', construire: panneauRelief });
  I.ajouterOutil({ id: 'psmv', groupe: 'psmv', libelle: 'PSMV', titre: 'Cadastre et PSMV', construire: panneauPSMV });
  I.ajouterOutil({ id: 'fond', groupe: 'fond', libelle: 'Fond', titre: 'Fond de plan et plans anciens', construire: panneauFond });
  I.ajouterOutil({ id: 'bati', groupe: 'batiments', libelle: 'Bâti', titre: 'Bâti existant', horsBorne: true, construire: (c) => app.bati.construireCommandes(c) });
  I.ajouterOutil({ id: 'hauteurs', groupe: 'batiments', libelle: 'Hauteurs', titre: 'Hauteur des bâtiments', horsBorne: true, construire: (c) => app.hauteurs.construirePanneau(c) });
  I.ajouterOutil({ id: 'projet', groupe: 'batiments', libelle: 'Projet', titre: 'Projet : démolir et ajouter des volumes', horsBorne: true, construire: (c) => app.projet.construirePanneau(c) });
  I.ajouterOutil({ id: 'soleil', groupe: 'climat', libelle: 'Soleil', titre: 'Soleil et ombres', raccourci: 'S', construire: (c) => app.soleil.construirePanneau(c) });
  I.ajouterOutil({ id: 'climat', groupe: 'climat', libelle: 'Climat', titre: 'Températures et vent (source météo choisie)', raccourci: 'K', construire: (c) => app.climat.construirePanneau(c) });
  I.ajouterOutil({ id: 'vent', groupe: 'climat', libelle: 'Vent', titre: 'Vent autour du bâti', raccourci: 'W', construire: (c) => app.vent.construirePanneau(c) });
  ajouterLigneAide('K', 'W', 'Vent autour du bâti');
  I.ajouterOutil({ id: 'confort', groupe: 'climat', libelle: 'Confort', titre: 'Rayonnement et confort', construire: (c) => app.confort.construirePanneau(c) });
  I.ajouterOutil({ id: 'chaleur', groupe: 'climat', libelle: 'Chaleur', titre: 'Chaleur au sol (estimation pédagogique)', construire: (c) => app.chaleur.construire(c) });
  I.ajouterOutil({ id: 'coupes', groupe: 'coupes', libelle: 'Coupes', titre: 'Coupes', raccourci: 'C', construire: (c) => app.coupes.construirePanneau(c) });
  app.vues.ajouterOutils(I, ajouterLigneAide); // onglet Vues (outils déclarés par js/vues.js)
  I.ajouterOutil({ id: 'flux', groupe: 'site', libelle: 'Flux', titre: 'Bus, tram et parkings', construire: (c) => app.flux.construirePanneau(c) });
  I.ajouterOutil({ id: 'reseaux', groupe: 'site', libelle: 'Réseaux', titre: 'Réseaux', construire: (c) => app.reseaux.construirePanneau(c) });
  I.ajouterOutil({ id: 'bruit', groupe: 'climat', libelle: 'Bruit', titre: 'Carte du bruit', construire: (c) => app.bruit.construirePanneau(c) });
  I.ajouterOutil({ id: 'trajets', groupe: 'site', libelle: 'Trajets', titre: 'Trajets et isochrones', construire: (c) => app.trajets.construirePanneau(c) });
  I.ajouterOutil({ id: 'fiches', groupe: 'site', libelle: 'Fiches', titre: 'Toutes les fiches', construire: (c) => app.fiches.construireSommaire(c) });
  app.export = creerExport(app);
  app.centre = creerCentre(app);
  app.legende = creerLegende(app); // légende automatique de ce qui est affiché (cadre en bas à gauche)
  app.rosesSaisons = creerRosesSaisons(app); // 4 roses des vents des saisons (outil Vent, planche)
  app.planche = creerPlanche(app); // planche à l'échelle PDF / SVG (onglet Export)
  I.ajouterOutil({ id: 'centre', groupe: 'site', libelle: 'Centre', titre: 'Centre du projet et cercle de la maquette', masqueEnBorne: true, construire: (c) => app.centre.construirePanneau(c) });
  I.ajouterOutil({ id: 'exporter', groupe: 'export', libelle: 'Exporter', titre: 'Exporter', horsBorne: true, construire: (c) => app.export.construirePanneau(c) });
  I.ajouterOutil({ id: 'releve', groupe: 'site', libelle: 'Relevé', titre: 'Relever et caler', masqueEnBorne: true, construire: (c) => app.releve.construirePanneau(c) });
  const boutonAide = document.getElementById('bouton-aide');
  boutonAide.addEventListener('click', () => document.getElementById('aide').showModal());

  app.soleil.maj();
  app.temps.changer('actuel', { instantane: true });
  app.emettre('couches');

  // boucle de rendu
  let precedent = performance.now();
  function boucle(t) {
    requestAnimationFrame(boucle);
    const dt = Math.min((t - precedent) / 1000, 0.1);
    precedent = t;
    if (app.animationCamera) app.animationCamera(t);
    if (!app.parcours.actif) app.controls.update();
    app.temps.maj(t);
    app.parcours.maj(dt);
    app.flux.maj(dt);
    app.vent.maj(dt);
    app.projet.maj();
    app.relief.maj(t);
    app.decoupe.maj(t);
    app.rues.maj();
    majBrouillard(app);
    app.renderer.render(app.scene, app.camera);
    app.etiquettes.maj();
    I.maj();
  }
  requestAnimationFrame(boucle);

  chargement.classList.add('fini');
  setTimeout(() => { chargement.hidden = true; }, 700);
  if (app.chapitres.liste.length) await app.chapitres.aller(0, { instantane: true });
  etatDeDemarrage();
  I.relancerAttente();
}

// État de départ (demande du 14/10/2026) : vue 3D, bâti détaillé avec photos, soleil du 21 juin à 12 h (heure légale),
// caméra centrée sur la place de l'Hôtel de Ville, aucune coupe active ni tracée. Réglable par config.json > demarrage
// ({ cible: [lat, lon], recul: [dx, dy, dz] en mètres, jour: "06-21", heure: 12 }).
function etatDeDemarrage() {
  const d = app.config.demarrage || {};
  if (app.vue2D) app.vue.basculer(false);
  // vue maquette coupée par défaut (config.json > vueMaquetteParDefaut, touche M pour la vue étendue)
  app.definirVueMaquette(app.config.vueMaquetteParDefaut !== false);
  app.toits?.definirRepresentation?.('photos');
  if (app.coupes.etat.actif) app.coupes.desactiver();
  app.couches.axes = false;
  app.couches.rues = true;
  const [mm, jj] = String(d.jour || '06-21').split('-').map(Number);
  const an = app.soleil.etat.annee ?? new Date().getFullYear();
  app.soleil.regler({ jour: jourDeLAnnee(new Date(an, mm - 1, jj)), heure: d.heure ?? 12 });
  app.emettre('couches');
  const [lat, lon] = d.cible || [47.21768, -1.55419]; // place de l'Hôtel de Ville (OSM)
  const c = app.proj.versLocal(lat, lon);
  const [dx, dy, dz] = d.recul || [0, 160, 210];
  const y0 = app.relief?.dz ? app.relief.dz(c.x, c.z) || 0 : 0;
  allerVers(app, [c.x + dx, y0 + dy, c.z + dz], [c.x, y0, c.z], 0);
}

demarrer().catch((err) => {
  console.error(err);
  chargement.querySelector('.erreur').textContent = `L'atlas n'a pas pu démarrer : ${err.message}`;
});

export default app;
