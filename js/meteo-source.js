import { h } from './util.js';
import { enregistrerDonnees } from './donnees.js';
import { chargerMeteo, definirSource, definirSite, source, epwPersoGarde, EPW_NANTES, meteo, annees, annee, definirAnnee } from './meteo.js';

// Sélecteur « Source météo » de l'onglet Ambiance (Climat, Vent, Confort, Chaleur) : météo de base (Météo-France
// 44020001, 2016-2025), EPW de Nantes fourni (data/meteo/) ou fichier EPW choisi par l'utilisateur (lu localement par
// FileReader, aucun envoi réseau ; gardé en IndexedDB ; enregistrable dans data/meteo/ si serveur.py tourne).
// Chaque bloc() affiche en permanence la source, la période et les avertissements (distance > 30 km, autre fuseau).
// Changement de source → événement « meteoSource » (les outils redessinent ou recalculent).
// 15/11/2026 (doublon 10) : barre({ annee }) = UN SEUL composant « Données météo » (source + année des mesures), compact
// (une ligne : source · période · Modifier ; détail repliable), inséré en tête de Climat, Vent, Confort et Chaleur, identique et
// synchronisé partout (même état ouvert / replié, mêmes valeurs ; événements « meteoSource » et « meteoAnnee » inchangés).
// Le choix de l'année (js/meteo.js definirAnnee) n'est proposé que là où il s'applique (Climat, Vent : { annee: true }) ;
// ailleurs (Confort, Chaleur : moyenne de la période) une note le dit. bloc() : ancien nom (année si Climat ou Vent est ouvert).
export function creerSourceMeteo(app) {
  definirSite(app.config.origine.lat, app.config.origine.lon);
  const blocs = new Set();
  const etat = { occupe: false, message: '', nomPerso: null, dernierPerso: null, ouvert: false };
  chargerMeteo().then(async () => { etat.nomPerso = await epwPersoGarde(); majTous(); });
  app.on('meteoAnnee', () => majTous());
  // période des mesures de la base : « 2016–2025 »
  const periodeBase = () => (meteo()?.periode?.stats?.split('/').map((x) => x.slice(0, 4)).join('–') ?? '');
  function choisirAnnee(a) {
    definirAnnee(a || null);
    app.emettre('meteoAnnee', annee()); // Climat redessine ; Vent : rose, saisons, mois, rose posée (js/climat.js, js/vent.js)
    majTous();
  }

  async function choisir(type, opts) {
    if (etat.occupe) return;
    etat.occupe = true; etat.message = 'Lecture du fichier météo…'; majTous();
    try {
      await definirSource(type, opts);
      if (type === 'epw-perso' && opts?.nom) { etat.nomPerso = opts.nom; etat.dernierPerso = opts; }
      etat.message = '';
      app.emettre('meteoSource', source());
    } catch (e) {
      etat.message = `Source météo inchangée : ${e.message}`;
    } finally { etat.occupe = false; majTous(); }
  }

  function lireFichier(f) {
    if (!f) return;
    const lecteur = new FileReader();
    lecteur.onload = () => choisir('epw-perso', { nom: f.name, texte: String(lecteur.result) });
    lecteur.onerror = () => { etat.message = `Lecture impossible de ${f.name}.`; majTous(); };
    lecteur.readAsText(f);
  }

  function majBloc(b) {
    const s = source();
    const sel = b.querySelector('select.choix-source-meteo');
    const optPerso = sel.querySelector('option[value="epw-perso"]');
    optPerso.hidden = !etat.nomPerso;
    optPerso.textContent = `Fichier EPW : ${etat.nomPerso || '…'}`;
    sel.value = s.type;
    sel.disabled = etat.occupe;
    const base = s.type === 'base';
    const liste = base ? annees() : [];
    const a = annee();
    const avecAnnee = b.dataset.annee === '1';
    // période réellement utilisée par l'outil : l'année choisie ne vaut que pour Climat et Vent
    const p = base ? (avecAnnee && a ? `année ${a}` : `moyenne ${periodeBase()}`) : s.periode;
    b.querySelector('.donnees-meteo-resume').textContent = `${base ? s.libelle.replace(/^Météo-France \d+ /, 'Météo-France ') : s.libelle}${s.nom && s.type === 'epw-perso' ? ` (${s.nom})` : ''} · ${p}`;
    b.querySelector('.source-meteo-ligne').textContent = `${s.titre} : ${s.libelle} · ${s.periode}${s.nom && s.type === 'epw-perso' ? ` · ${s.nom}` : ''}`;
    const selA = b.querySelector('select.choix-annee-meteo');
    if (selA) {
      const valeurs = ['', ...liste];
      if (selA.options.length !== valeurs.length) {
        selA.replaceChildren(h('option', { value: '' }, `Moyenne ${periodeBase()}`), ...liste.map((x) => h('option', { value: x }, `Année ${x}`)));
      }
      selA.value = a && liste.includes(a) ? a : '';
      selA.disabled = etat.occupe;
      selA.closest('label').hidden = !liste.length;
    }
    const noteA = b.querySelector('.donnees-meteo-note-annee');
    noteA.hidden = !(base && a && !avecAnnee);
    noteA.textContent = `Année ${a} choisie dans Climat ou Vent : cet outil utilise toujours la moyenne ${periodeBase()}.`;
    const al = b.querySelector('.source-meteo-alerte');
    al.replaceChildren(...[etat.message, ...s.avertissements].filter(Boolean).map((t) => h('span', {}, t, ' ')));
    al.hidden = !al.childNodes.length;
    b.querySelector('.source-meteo-enregistrer').hidden = !(s.type === 'epw-perso' && etat.dernierPerso);
    const d = b.querySelector('details');
    if (d.open !== etat.ouvert) d.open = etat.ouvert;
  }
  function majTous() { for (const b of [...blocs]) { if (b.isConnected) majBloc(b); else blocs.delete(b); } }

  // options : { annee: true } pour proposer l'année des mesures (Climat, Vent)
  function barre({ annee: avecAnnee = false } = {}) {
    const entree = h('input', { type: 'file', accept: '.epw,text/plain', hidden: true, onchange: (e) => { lireFichier(e.target.files[0]); e.target.value = ''; } });
    const details = h('details', { class: 'donnees-meteo-detail' },
      h('summary', { title: 'Source des mesures météo et période, communes à Climat, Vent, Confort et Chaleur' },
        h('span', { class: 'donnees-meteo-titre' }, 'Données météo'), ' ',
        h('span', { class: 'donnees-meteo-resume' }), ' ',
        h('span', { class: 'donnees-meteo-modifier', 'aria-hidden': 'true' }, 'Modifier')),
      h('div', { class: 'donnees-meteo-corps' },
        h('label', { class: 'champ' }, h('span', {}, 'Source'),
          h('select', { class: 'choix-source-meteo', 'aria-label': 'Source météo', onchange: (e) => choisir(e.target.value) },
            h('option', { value: 'base' }, 'Météo de base (Météo-France 2016–2025)'),
            h('option', { value: 'epw-nantes' }, 'Fichier EPW de Nantes (fourni)'),
            h('option', { value: 'epw-perso', hidden: true }, 'Fichier EPW'))),
        avecAnnee ? h('label', { class: 'champ selecteur-annee' }, h('span', {}, 'Mesures'),
          h('select', { class: 'choix-annee-meteo', 'aria-label': 'Période des mesures', onchange: (e) => choisirAnnee(e.target.value) })) : null,
        h('div', { class: 'boutons' },
          h('button', { type: 'button', class: 'bouton discret', title: 'Fichier .epw (EnergyPlus Weather), lu dans le navigateur, sans envoi', onclick: () => entree.click() }, 'Choisir un fichier EPW…'),
          h('button', { type: 'button', class: 'bouton discret source-meteo-enregistrer', hidden: true, title: 'Copier le fichier dans data/meteo/ (serveur local), sinon le télécharger',
            onclick: () => { const p = etat.dernierPerso; if (p) enregistrerDonnees(`meteo/${p.nom.replace(/[^\w.-]+/g, '_')}`, p.texte, { type: 'text/plain' }); } }, 'Enregistrer dans data/meteo/'),
          entree),
        h('p', { class: 'source-meteo-ligne', role: 'status' }),
        h('p', { class: 'donnees-meteo-aide' }, 'Réglage commun à Climat, Vent, Confort et Chaleur : le changer ici le change partout. L\'année des mesures ne s\'applique qu\'à Climat et Vent (Confort et Chaleur : moyenne de la période).')));
    details.addEventListener('toggle', () => { if (etat.ouvert !== details.open) { etat.ouvert = details.open; majTous(); } });
    const b = h('div', { class: 'source-meteo donnees-meteo', 'data-garder': '', 'data-annee': avecAnnee ? '1' : '0' },
      details,
      h('p', { class: 'donnees-meteo-note-annee note', role: 'status', hidden: true }),
      h('p', { class: 'source-meteo-alerte alerte', role: 'status', hidden: true }));
    b.title = `EPW de Nantes : ${EPW_NANTES}`;
    blocs.add(b);
    majBloc(b);
    return b;
  }

  // ancien nom : année proposée si l'outil ouvert est Climat ou Vent (appelants non mis à jour)
  const bloc = (o = {}) => barre({ annee: o.annee ?? ['climat', 'vent'].includes(app.interface?.ouvert) });
  return { barre, bloc, choisir, choisirAnnee, lireFichier };
}
