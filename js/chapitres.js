import { h, allerVers, versVecteur, texteRiche } from './util.js';

// Les chapitres forment un parcours du plus large au plus proche.
// La navigation est une règle graduée, comme l'échelle graphique d'un plan.
export function creerChapitres(app) {
  // chapitres masqués (« masque »: true dans data/chapitres.json) : gardés dans le fichier, absents de la règle ;
  // les chapitres restants sont renumérotés à la suite (le numéro du fichier reste celui d'origine)
  const tous = app.donnees.chapitres.chapitres || [];
  const premier = tous.find((c) => !c.masque)?.numero ?? 0;
  const liste = tous.filter((c) => !c.masque).map((c, i) => ({ ...c, numeroFichier: c.numero, numero: (Number.isFinite(+premier) ? +premier : 0) + i }));
  const regle = document.getElementById('regle-chapitres');
  const carte = document.getElementById('carte-chapitre');
  let index = -1;

  const segments = liste.map((ch, i) => {
    const b = h('button', { type: 'button', class: 'segment', 'aria-label': `Chapitre ${ch.numero} : ${ch.titre}`, onclick: () => aller(i) },
      h('span', { class: 'numero' }, String(ch.numero)),
      h('span', { class: 'titre' }, ch.titre));
    return b;
  });
  regle.append(
    h('button', { type: 'button', class: 'fleche', 'aria-label': 'Chapitre précédent', onclick: precedent }, '‹'),
    h('div', { class: 'segments' }, ...segments),
    h('button', { type: 'button', class: 'fleche', 'aria-label': 'Chapitre suivant', onclick: suivant }, '›'),
  );

  function rendreCarte(ch) {
    carte.replaceChildren();
    if (!ch) { carte.hidden = true; return; }
    const paires = [];
    const n = Math.max(ch.motsSite?.length || 0, ch.motsProjet?.length || 0);
    for (let i = 0; i < n; i++) {
      paires.push(h('li', {},
        h('span', { class: 'mot-site' }, ch.motsSite?.[i] || ''),
        ch.motsProjet?.[i] ? h('span', { class: 'mot-projet' }, ch.motsProjet[i]) : null));
    }
    const texte = h('div', { class: 'texte' });
    for (const p of [].concat(ch.texte || [])) {
      const el = h('p'); el.innerHTML = texteRiche(p); texte.append(el);
    }
    carte.append(...[
      h('p', { class: 'numero-chapitre' }, `Chapitre ${ch.numero}`),
      h('h2', {}, ch.titre),
      ch.sousTitre ? h('p', { class: 'sous-titre' }, ch.sousTitre) : null,
      paires.length ? h('ul', { class: 'paires', 'aria-label': 'Mots du site' }, ...paires) : null,
      texte,
      ch.fiche ? h('button', { type: 'button', class: 'bouton', onclick: () => app.fiches.ouvrir(ch.fiche) }, 'Ouvrir la fiche') : null,
    ].filter(Boolean));
    carte.hidden = false;
  }

  async function aller(i, { instantane = false } = {}) {
    if (i < 0 || i >= liste.length) return;
    index = i;
    const ch = liste[i];
    segments.forEach((s, k) => {
      s.classList.toggle('actif', k === i);
      s.classList.toggle('passe', k < i);
      s.setAttribute('aria-current', k === i ? 'step' : 'false');
    });
    rendreCarte(ch);
    app.parcours?.arreter();

    // vue, couches et fonds du chapitre
    if (ch.vue) app.vue.basculer(ch.vue === '2d');
    if (ch.couches) Object.assign(app.couches, ch.couches);
    if (ch.roseVents != null) app.climat?.afficherRose(ch.roseVents);
    if (ch.fonds) {
      if ('principal' in ch.fonds && app.calques.etat.principal !== (ch.fonds.principal || null)) app.calques.choisir('principal', ch.fonds.principal);
      if ('comparaison' in ch.fonds && app.calques.etat.comparaison !== (ch.fonds.comparaison || null)) app.calques.choisir('comparaison', ch.fonds.comparaison);
    }
    // vue maquette : seulement si le chapitre la précise (sinon on garde celle de l'utilisateur, maquette par défaut)
    if (ch.vueMaquette != null) app.definirVueMaquette(!!ch.vueMaquette);
    if (ch.etat) app.temps.changer(ch.etat, { instantane });
    else app.temps.appliquer({ instantane });
    app.emettre('couches');

    if (ch.coupe) app.coupes.activer(ch.coupe, { cadrer: !ch.camera });
    else if (app.coupes.etat.actif) app.coupes.desactiver();
    if (ch.fiche && app.fiches.courante && app.fiches.courante.id !== ch.fiche) app.fiches.fermer();
    if (ch.soleil) app.soleil.regler(ch.soleil);

    if (ch.camera) {
      const cible = versVecteur(app, ch.camera.cible, 0);
      const pos = versVecteur(app, ch.camera.position, 120);
      await allerVers(app, pos, cible, instantane ? 0 : 2000);
    }
    app.emettre('chapitre', ch.id);
  }

  function suivant() { aller(Math.min(index + 1, liste.length - 1)); }
  function precedent() { aller(Math.max(index - 1, 0)); }

  return {
    aller, suivant, precedent, liste,
    get index() { return index; },
    masquerCarte() { carte.hidden = true; },
    afficherCarte() { if (liste[index]) rendreCarte(liste[index]); },
  };
}
