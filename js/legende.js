import { h } from './util.js';
import { COULEURS } from './maquette.js';
import { COULEURS_FLUX } from './flux.js';
import { CLASSES_CONFORT } from './vent-calcul.js';
import { formaterHeure } from './geo.js';

// Légende automatique (22/10/2026) : un seul cadre repliable en bas à gauche, au-dessus de la barre des chapitres,
// qui liste ce qui est VISIBLE sur la maquette :
// - éléments de la maquette (Site > Couches > Éléments : chaussées, trottoirs, bâti, toits détaillés, projet, arbres, espaces verts, eau),
//   ombres portées (soleil de la barre Soleil) ;
// - réseaux souterrains cochés (gaz, BT, HTA en tirets, postes) et jeux Open Data affichés ; flux bus / tram ;
// - légendes de couleurs des analyses d'Ambiance affichées, fournies par les outils eux-mêmes (pas de copie) :
//   app.chaleur.legendeAuto() (matériaux, échauffement, albédo, température, écart), app.confort.legendeAuto(),
//   app.soleil.legendeAuto() (heures de soleil), et ici le Vent (classes CLASSES_CONFORT de vent-calcul.js, particules)
//   et le Bruit (classes portées par les meshes du groupe « bruit »).
// decrire() rend une liste de sections { id, titre, items: [{ libelle, couleur, forme: aplat|trait|tirets|cercle|carre|contour }],
// degrade?: { stops: [[u, [r, g, b]]], graduations: [{ u, texte }], gauche?, droite? }, note? } ; elle sert aussi à la planche
// à l'échelle (js/planche.js, légende en vecteurs). Mise à jour sur les événements (couches, outil, bati, meteoSource, soleil, vues…)
// et par un contrôle léger toutes les 1,5 s (signature du contenu). Styles : fin de css/complements.css.
const CLE = 'atlas-hdv-legende'; // cadre ouvert ou replié (préférence du poste)
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
export const rgb = (c) => (typeof c === 'string' ? c : `rgb(${c.join(',')})`);

// graduations lisibles : les premières et dernières gardées, les intermédiaires trop proches (écart < ecart) retirées
export function grader(G, ecart = 0.16) {
  if (!G || G.length < 3) return G || [];
  const garde = [G[0]];
  const fin = G[G.length - 1];
  for (const g of G.slice(1, -1)) if (g.u - garde[garde.length - 1].u >= ecart && fin.u - g.u >= ecart) garde.push(g);
  garde.push(fin);
  return garde;
}

export function creerLegende(app) {
  const ui = {};
  let ouvert = true;
  try { const m = localStorage.getItem(CLE); if (m != null) ouvert = m === '1'; else ouvert = !window.matchMedia('(max-width: 820px)').matches; } catch { /* stockage indisponible */ }

  const chercher = (nom, enfant) => {
    const g = app.scene.children.find((o) => o.name === nom);
    return enfant ? g?.children.find((o) => o.name === enfant) : g;
  };
  const affiche = (cle) => app.couches[cle] !== false;

  // ------------------------------------------------------------
  // Contenu
  // ------------------------------------------------------------
  function sectionMaquette() {
    const it = [];
    const ajouter = (cond, libelle, couleur, forme = 'aplat') => { if (cond) it.push({ libelle, couleur, forme }); };
    ajouter(affiche('maqChaussees') && chercher('voirie', 'chaussees'), 'Chaussée', hex(COULEURS.voirie));
    ajouter(affiche('maqTrottoirs') && chercher('voirie', 'trottoirs'), 'Trottoirs, places, stationnements', hex(COULEURS.cheminement));
    ajouter(affiche('maqEspacesVerts') && chercher('surfaces', 'vegetal'), 'Espaces verts', hex(COULEURS.vegetal));
    ajouter(affiche('maqEau') && chercher('surfaces', 'eau'), 'Eau', hex(COULEURS.eau));
    ajouter(affiche('arbres') && app.arbres?.groupe?.visible !== false && Object.values(app.arbres?.lots || {}).some((l) => l.length), 'Arbres (couronne)', hex(COULEURS.arbre), 'cercle');
    const bati = chercher('batiments');
    if (bati?.visible !== false && app.bati?.etat?.mode !== 'masque') {
      ajouter(affiche('maqBati'), 'Bâti existant', hex(COULEURS.maquette), 'contour');
      const rep = app.toits?.representation?.();
      ajouter(affiche('maqDetail') && rep && rep !== 'simple', rep === 'photos' ? 'Toits détaillés et façades photo' : 'Toits détaillés', hex(COULEURS.tuffeau), 'contour');
    }
    const projet = app.projet;
    if (affiche('maqProjet') && projet?.visible && ((projet.formesVisibles?.().length || 0) + (chercher('imports')?.children.length || 0))) {
      const c = projet.etat?.couleurDefaut || getComputedStyle(document.body).getPropertyValue('--projet').trim() || '#5e9384';
      it.push({ libelle: 'Projet (volumes ajoutés)', couleur: c, forme: 'contour' });
    }
    if (projet?.etat?.demolis?.size) it.push({ libelle: `Bâti démoli par le projet (${projet.etat.demolis.size})`, couleur: '#c8372d', forme: 'tirets' });
    const S = app.soleil?.etat;
    if (S && app.renderer?.shadowMap?.enabled !== false) {
      const haut = app.soleil?.hauteur?.() ?? 1;
      if (haut > 0) it.push({ libelle: `Ombres portées (soleil du ${app.soleil.libelleDate?.() || ''}, ${formaterHeure(S.heure)})`.replace(' du ,', ','), couleur: 'rgba(47,59,69,0.35)', forme: 'aplat' });
    }
    return it.length ? { id: 'maquette', titre: 'Maquette', items: it } : null;
  }

  function sectionReseaux() {
    if (!app.couches.reseaux || !app.reseaux) return null;
    const it = [];
    for (const s of app.reseaux.souterrains || []) {
      if (!s.visible) continue;
      it.push({ libelle: s.libelle, couleur: s.couleur, forme: s.points ? 'carre' : s.tirets ? 'tirets' : 'trait', largeur: s.largeur });
    }
    for (const j of app.reseaux.jeux || []) if (j.visible !== false && j.objet?.visible !== false) it.push({ libelle: j.titre, couleur: j.couleur, forme: 'trait' });
    return it.length ? { id: 'reseaux', titre: 'Réseaux', items: it, note: 'GRDF, Enedis (Licence Ouverte 2.0) ; eaux, fibre : non publiés (DT-DICT).' } : null;
  }

  function sectionFlux() {
    if (!app.couches.flux) return null;
    return { id: 'flux', titre: 'Transports en commun', items: [
      { libelle: 'Tramway : lignes, rames, arrêts', couleur: COULEURS_FLUX.tram, forme: 'trait' },
      { libelle: 'Bus : lignes, véhicules, arrêts', couleur: COULEURS_FLUX.bus, forme: 'trait' }] };
  }

  function sectionsVent() {
    const V = app.vent?.etat;
    if (!V || !app.vent.actif) return [];
    const L = [{
      id: 'vent-particules', titre: `Vent : ${V.direction}°, ${String(V.vitesse).replace('.', ',')} m/s (vitesse locale des particules)`,
      degrade: { stops: [[0, [6, 82, 209]], [0.3, [5, 209, 107]], [0.55, [142, 209, 5]], [1, [209, 75, 5]]], graduations: [{ u: 0, texte: 'abrité' }, { u: 1, texte: 'accéléré (×2,5)' }] },
    }];
    if (V.confort && V.P) {
      const lib = { annee: 'année', hiver: 'hiver', printemps: 'printemps', ete: 'été', automne: 'automne' }[V.saison] || V.saison;
      L.push({ id: 'vent-confort', titre: `Confort au vent (seuil ${V.seuil} m/s, ${lib})`, items: CLASSES_CONFORT.map((c) => ({ libelle: `${c.t} : ${c.l}`, couleur: rgb(c.c), forme: 'aplat' })) });
    }
    return L;
  }

  function sectionBruit() {
    const g = chercher('bruit');
    if (!g?.visible || !app.couches.bruit || !g.children.length) return null;
    const classes = [...new Set(g.children.map((m) => m.userData.classe).filter(Boolean))].sort((a, b) => a.min - b.min);
    return classes.length ? { id: 'bruit', titre: 'Bruit (Lden, cartes de l\'État)', items: classes.map((c) => ({ libelle: c.libelle, couleur: c.couleur, forme: 'aplat' })) } : null;
  }

  // analyses affichées, l'outil ouvert en premier
  function sectionsAnalyse() {
    const L = [];
    const par = {
      chaleur: () => app.chaleur?.legendeAuto?.(),
      confort: () => app.confort?.legendeAuto?.(),
      soleil: () => app.soleil?.legendeAuto?.(),
      vent: () => sectionsVent(),
      bruit: () => sectionBruit(),
    };
    const ordre = Object.keys(par);
    const ouvert = app.interface?.ouvert;
    if (ordre.includes(ouvert)) { ordre.splice(ordre.indexOf(ouvert), 1); ordre.unshift(ouvert); }
    for (const k of ordre) {
      try { const r = par[k](); if (Array.isArray(r)) L.push(...r); else if (r) L.push(r); } catch (e) { console.warn('légende', k, e); }
    }
    return L;
  }

  function decrire() {
    return [...sectionsAnalyse(), sectionMaquette(), sectionReseaux(), sectionFlux()].filter(Boolean);
  }

  // ------------------------------------------------------------
  // Rendu DOM
  // ------------------------------------------------------------
  function pastille(it) {
    const c = rgb(it.couleur);
    const style = it.forme === 'trait' ? { background: 'none', borderTop: `3px solid ${c}`, height: '0', alignSelf: 'center' }
      : it.forme === 'tirets' ? { background: 'none', borderTop: `3px dashed ${c}`, height: '0', alignSelf: 'center' }
        : it.forme === 'cercle' ? { background: c, borderRadius: '50%' }
          : it.forme === 'carre' ? { background: c, transform: 'scale(0.7)' }
            : it.forme === 'contour' ? { background: c, outline: '1px solid #2f3b45', outlineOffset: '-1px' }
              : { background: c };
    return h('i', { class: `pastille ${it.forme || 'aplat'}`, style });
  }
  function barre(D) {
    return h('div', { class: 'legende-albedo' },
      h('div', { class: 'legende-albedo-barre', style: { background: `linear-gradient(90deg, ${D.stops.map(([u, c]) => `${rgb(c)} ${Math.round(u * 1000) / 10}%`).join(', ')})` } }),
      D.graduations.length ? h('div', { class: 'legende-albedo-graduations' }, ...grader(D.graduations).map((g) => h('span', { style: { left: `${g.u * 100}%` } }, g.texte))) : null,
      D.gauche || D.droite ? h('div', { class: 'legende-albedo-sens' }, h('span', {}, D.gauche || ''), h('span', {}, D.droite || '')) : null);
  }
  function rendre(sections) {
    if (!ui.corps) return;
    ui.el.hidden = !sections.length;
    ui.corps.replaceChildren(...sections.map((s) => h('section', { class: `legende-auto-section ${s.id}` },
      h('h4', {}, s.titre),
      s.degrade ? barre(s.degrade) : null,
      s.items?.length ? h('ul', {}, ...s.items.map((it) => h('li', {}, pastille(it), h('span', {}, it.libelle)))) : null,
      s.note ? h('p', { class: 'legende-auto-note' }, s.note) : null)));
  }

  function construire() {
    if (ui.el) return;
    ui.corps = h('div', { class: 'legende-auto-corps' });
    ui.el = h('details', { class: 'legende-auto', id: 'legende-auto', open: ouvert, hidden: true },
      h('summary', { title: 'Légende de ce qui est affiché (mise à jour automatique)' }, 'Légende'), ui.corps);
    ui.el.addEventListener('toggle', () => { try { localStorage.setItem(CLE, ui.el.open ? '1' : '0'); } catch { /* stockage indisponible */ } });
    document.body.append(ui.el);
  }

  let signature = '', attente = 0;
  function maj() {
    construire();
    const s = decrire();
    const sig = JSON.stringify(s);
    if (sig === signature) return s;
    signature = sig;
    rendre(s);
    return s;
  }
  const planifier = () => { clearTimeout(attente); attente = setTimeout(maj, 120); };
  for (const ev of ['couches', 'outil', 'bati', 'etat', 'meteoSource', 'meteoAnnee', 'soleil', 'vues', 'vueMaquette', 'legende', 'relief']) app.on(ev, planifier);
  setInterval(maj, 1500);
  setTimeout(maj, 0);

  return { decrire, maj, get el() { return ui.el; } };
}
