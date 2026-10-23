import { h } from './util.js';

// Vues rapides (22/10/2026) : petit panneau repliable sous la barre Soleil (#haut-droite), visible quel que soit l'onglet.
// Liste compacte des points de vue de l'outil Vues (même liste, même fichier data/vues.json) : clic = aller à la vue
// (état complet : caméra, soleil, couches et éléments, outil ouvert et ses réglages) ; « + » enregistre la vue actuelle
// sous le nom proposé par app.vues.nomAuto(). Avec serveur.py, data/vues.json est réécrit aussitôt ; sinon la liste
// est marquée « à enregistrer » (bouton « Enregistrer » : téléchargement de vues.json, à déposer dans data/).
// Styles : fin de css/complements.css (chargée par js/soleil.js).
const CLE = 'atlas-hdv-vues-rapides'; // panneau ouvert ou replié (préférence du poste)

export function creerVuesRapides(app) {
  const hote = document.getElementById('haut-droite');
  const vues = app.vues;
  if (!hote || !vues) return null;
  const ui = {};
  let ouvert = false;
  try { ouvert = localStorage.getItem(CLE) === '1'; } catch { /* stockage indisponible */ }
  const edition = app.mode !== 'borne';

  ui.resume = h('span', { class: 'vues-rapides-resume' }, 'Vues');
  ui.liste = h('ol', { class: 'vues-rapides-liste' });
  ui.plus = edition ? h('button', { type: 'button', class: 'vues-rapides-plus', title: 'Enregistrer la vue actuelle (caméra, soleil, couches, outil et ses réglages)', 'aria-label': 'Enregistrer la vue actuelle', onclick: ajouter }, '+') : null;
  ui.sauver = edition ? h('button', { type: 'button', class: 'vues-rapides-sauver', hidden: true, title: 'Enregistrer data/vues.json', 'aria-label': 'Enregistrer data/vues.json', onclick: () => vues.enregistrer() }, 'Enregistrer') : null;
  ui.el = h('details', { class: 'vues-rapides', open: ouvert },
    h('summary', { title: 'Vues rapides : points de vue enregistrés (onglet Vues)' }, h('span', { class: 'vues-rapides-icone', 'aria-hidden': 'true' }, '◱'), ui.resume),
    h('div', { class: 'vues-rapides-corps' }, ui.liste,
      h('p', { class: 'vues-rapides-vide', hidden: true }, edition ? 'Aucune vue : « + » enregistre la vue actuelle.' : 'Aucune vue enregistrée.'),
      edition ? h('div', { class: 'vues-rapides-pied' }, ui.plus, ui.sauver) : null));
  ui.vide = ui.el.querySelector('.vues-rapides-vide');
  ui.el.addEventListener('toggle', () => { try { localStorage.setItem(CLE, ui.el.open ? '1' : '0'); } catch { /* stockage indisponible */ } });
  hote.append(ui.el);

  function maj() {
    const L = vues.liste;
    ui.resume.textContent = L.length ? `Vues (${L.length})` : 'Vues';
    ui.liste.replaceChildren(...L.map((v, i) => h('li', {},
      h('button', { type: 'button', class: i === vues.etat.courant ? 'courante' : '', title: `Aller à « ${v.nom} »`, onclick: () => vues.aller(i, { outil: true }) }, v.nom))));
    ui.vide.hidden = L.length > 0;
    if (ui.sauver) ui.sauver.hidden = !vues.etat.modifie;
  }

  // enregistrement direct de data/vues.json par serveur.py ; sans serveur, rien n'est téléchargé d'office
  async function ecrireSiServeur() {
    try {
      const r = await fetch('__enregistrer/data/vues.json', { method: 'POST', body: new Blob([JSON.stringify(vues.serialiser(), null, 1)], { type: 'application/json' }) });
      if (r.ok && (await r.json())?.ok) { vues.etat.modifie = false; maj(); return true; }
    } catch { /* pas de serveur local */ }
    return false;
  }
  async function ajouter() {
    const v = vues.enregistrerVue(vues.nomAuto());
    ui.el.open = true;
    if (app.mode === 'presentateur' && await ecrireSiServeur()) app.signaler(`Vue « ${v.nom} » enregistrée dans data/vues.json.`);
  }

  app.on('vues', maj);
  maj();
  return { maj, ajouter, el: ui.el };
}
