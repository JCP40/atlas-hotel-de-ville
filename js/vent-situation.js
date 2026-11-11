import { h } from './util.js';
import { definirSituation, situation, extremesDetail, extremesCourant, roseSituation, periodeExtremes, erreurExtremesDetail, annee } from './meteo.js';
import { condition } from './meteo-extremes.js';
import { svgRose } from './roses-saisons.js';

// Sélecteur « Situation » de l'outil Vent (10/11/2026, demande de l'utilisateur : d'où vient le vent en canicule, au plus grand froid…).
// Bloc inséré dans le panneau Vent à l'ouverture (comme les 4 roses des saisons, sans modifier js/vent.js) :
// - « Période habituelle » (défaut) : rien ne change ;
// - une situation (canicule, chaleur, plus grand froid, gel, tempête, chaud sans vent, froid et venté) : js/meteo.js definirSituation(id),
//   rose(12, saison) renvoie alors la rose des heures de la situation (js/meteo-extremes.js sur les mesures horaires) ; l'événement
//   « meteoAnnee » fait redessiner à js/vent.js la rose cliquable, le tableau des saisons, la rose posée, et appliquer la direction dominante
//   et la vitesse (vent moyen ou fort) à la carte, aux particules et au sillage ; Période et Température sont grisées (année, toutes températures).
// - moins de 100 h de vent (chaud sans vent, froid et venté) : js/vent.js ne dessine pas la rose (seuil 100 h) : rose dessinée ici, direction
//   appliquée ici (au moins 10 h), mention « échantillon faible ».
// État : app.vent.etat.situation (gardé par les points de vue, js/vues.js). Textes du panneau complétés par un MutationObserver.
export const SITUATIONS = [['habituel', 'Période habituelle'], ['canicule', 'Canicule'], ['chaleur', 'Chaleur (30 °C et plus)'], ['plus-froid', 'Plus grand froid (10 jours)'],
  ['gel', 'Gel (0 °C et moins)'], ['tempete', 'Tempête (force 6 et plus)'], ['chaud-sans-vent', 'Chaud sans vent'], ['froid-vente', 'Froid et venté']];
const MIN = 10; // heures de vent au moins pour poser la direction d'une situation
const NOMS12 = ['N', 'NNE', 'ENE', 'E', 'ESE', 'SSE', 'S', 'SSO', 'OSO', 'O', 'ONO', 'NNO'];
const nombre = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d).replace('.', ','));

export function creerVentSituation(app) {
  const ui = {};
  const E = () => app.vent?.etat;
  const actif = () => situation() !== 'habituel';
  const libelle = (id = situation()) => SITUATIONS.find(([v]) => v === id)?.[1] ?? condition(id)?.libelle ?? id;
  const vitesse = (s) => (E()?.modeVitesse === 'fort' ? s.p90 : s.vm);

  async function choisir(id, { appliquer = true } = {}) {
    const V = E();
    if (!V) return;
    const v = SITUATIONS.some(([x]) => x === id) ? id : 'habituel';
    V.situation = v;
    definirSituation(v);
    if (v !== 'habituel') {
      V.saison = 'annee'; V.temperature = 'all';
      majUI('Lecture des mesures horaires (conditions extrêmes)…');
      const R = await extremesDetail();
      if (V.situation !== v) return;
      if (!R) { V.situation = 'habituel'; definirSituation('habituel'); majUI(erreurExtremesDetail() || 'Conditions extrêmes indisponibles.'); return; }
    }
    app.emettre('meteoAnnee', annee()); // js/vent.js : rose, saisons, mois, rose posée, direction de la période ; 4 saisons, légende
    if (appliquer && app.vent.definirSuitPeriode) app.vent.definirSuitPeriode(true);
    completer({ appliquer });
    majUI();
  }

  // situation de moins de 100 h : rose et direction posées ici (js/vent.js exige 100 h)
  function completer({ appliquer = true } = {}) {
    if (!actif() || !ui.select?.isConnected) return;
    const ro = roseSituation(situation());
    if (ro.N >= 100 || ro.N < MIN || !ro.dominant) return;
    const conteneur = document.querySelector('#panneau-outil .panneau-vent .rose-conteneur');
    if (conteneur) {
      const s = { lib: libelle(), r: ro, ok: true, dom: ro.secteurs[ro.dominant.k] };
      const axe = Math.max(10, Math.ceil(Math.max(...ro.secteurs.map((x) => x.f)) / 5) * 5);
      conteneur.innerHTML = `<svg viewBox="0 0 100 124" class="graphique rose-vent" role="img" aria-label="Rose des vents, ${s.lib}">${svgRose(s, axe, { cx: 50, cy: 50, R: 36, p: 7 })}</svg>`;
    }
    const d = ro.secteurs[ro.dominant.k];
    if (appliquer && E()?.suitPeriode) app.vent.regler(d.dir, vitesse(d));
    corriger();
  }

  // textes du panneau Vent écrits pour une « période » : précisés pour la situation
  function corriger() {
    if (!actif() || !ui.select?.isConnected) return;
    const ro = roseSituation(situation());
    const quand = `en situation « ${libelle()} » (${periodeExtremes()}, ${ro.N.toLocaleString('fr-FR')} h${ro.N < 100 ? ', échantillon faible' : ''})`;
    const poser = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
    const p = document.querySelector('#panneau-outil .texte-periode-vent');
    if (p) {
      let t = p.textContent.replace(/(Direction dominante|Dominante) sur l'année/, `$1 ${quand}`);
      if (ro.N < 100 && ro.N >= MIN && ro.dominant) {
        const s = ro.secteurs[ro.dominant.k];
        t = `Direction dominante ${quand} : ${s.dir}° (${NOMS12[s.k]}), ${nombre(vitesse(s))} m/s ${E()?.modeVitesse === 'fort' ? 'en vent fort (dépassé 10 % du temps)' : 'en moyenne'}, ${nombre(s.f, 0)} % du temps.`;
      }
      poser(p, t);
    }
    const a = document.querySelector('#panneau-outil .panneau-vent p.alerte');
    if (a && /la case « [^»]+ »/.test(a.textContent)) poser(a, a.textContent.replace(/la case « [^»]+ »/, `la situation « ${libelle()} »`));
    const i = document.querySelector('#panneau-outil .panneau-vent .info-vent');
    if (i && ro.N < 100 && ro.N >= MIN && ro.dominant && /trop peu de mesures/.test(i.textContent)) {
      const s = ro.secteurs[ro.dominant.k];
      poser(i, `${NOMS12[s.k]} (${(s.dir + 345) % 360} à ${(s.dir + 15) % 360}°) : ${nombre(s.f)} % des heures de la situation, ${nombre(s.vm)} m/s en moyenne, ${nombre(s.p90)} m/s dépassés 10 % du temps. ${ro.N} h de mesures, calme ${nombre(ro.calmes, 0)} %. Rose non cliquable (moins de 100 h).`);
    }
  }

  function majUI(message = null) {
    if (!ui.select?.isConnected) return;
    const s = actif();
    ui.select.value = situation();
    document.querySelectorAll('#panneau-outil .panneau-vent .deux-champs select').forEach((x) => {
      x.disabled = s || (x.querySelector('option[value="froid"]') ? !!annee() : false);
      if (s) { x.title = 'Situation choisie : rose de toutes les heures de la situation (revenir à « Période habituelle » pour choisir la période)'; x.value = x.querySelector('option[value="annee"]') ? 'annee' : 'all'; }
    });
    const c = s ? condition(situation()) : null;
    ui.note.textContent = message ?? (c ? `${c.libelle} : ${c.def} ; ${periodeExtremes()}. Statistique observée, pas une prévision ; vent de l'aéroport (10 m). Le confort au vent reste calculé sur la période.` : '');
    ui.note.hidden = !ui.note.textContent;
    const lab = document.querySelector('#panneau-outil .case-periode-vent');
    const n = lab && [...lab.childNodes].find((x) => x.nodeType === 3 && /Direction suivant/.test(x.textContent));
    if (n) n.textContent = 'Direction suivant la période ou la situation (vent dominant)';
  }

  function inserer() {
    const conteneur = document.querySelector('#panneau-outil .panneau-vent');
    const ancre = conteneur?.querySelector('.deux-champs');
    if (!ancre || conteneur.querySelector('.situation-vent')) return;
    ui.select = h('select', { 'aria-label': 'Situation', onchange: (e) => choisir(e.target.value) },
      ...SITUATIONS.map(([v, l]) => h('option', { value: v, selected: v === situation() }, l)));
    ui.note = h('p', { class: 'note note-situation-vent', 'data-garder': '', hidden: true });
    ancre.before(h('div', { class: 'situation-vent', 'data-garder': '' },
      h('label', { class: 'champ champ-situation-vent', title: 'Vent des heures de canicule, de grand froid, de tempête… (mesures horaires) : direction dominante et vitesse appliquées à la carte, aux particules et au sillage' }, h('span', {}, 'Situation'), ui.select),
      ui.note));
    ui.obs?.disconnect();
    ui.obs = new MutationObserver(() => corriger());
    ui.obs.observe(conteneur, { childList: true, subtree: true, characterData: true });
    majUI();
    if (actif()) choisir(situation(), { appliquer: false }); // vue enregistrée avec une situation, ou panneau rouvert
  }
  app.on('outil', (id) => {
    if (id !== 'vent') return;
    definirSituation(E()?.situation || 'habituel'); // avant le premier dessin de la rose par js/vent.js
    setTimeout(inserer, 0);
  });
  // source ou année changée : conditions extrêmes de la nouvelle source ou année lues, puis js/vent.js redessine (meteoAnnee)
  for (const ev of ['meteoSource', 'meteoAnnee']) app.on(ev, async () => {
    if (!actif()) return;
    if (!extremesCourant()) { await extremesDetail(); app.emettre('meteoAnnee', annee()); }
    setTimeout(() => { majUI(); completer(); }, 50);
  });
  return { SITUATIONS, choisir, situation };
}
