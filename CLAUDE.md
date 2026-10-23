# Atlas du site de l'Hôtel de Ville de Nantes — contexte pour Claude Code

Répondre et commenter en **français**. Utilisateur : Jean-Charles Poullain, étudiant FPC L3 S5 à l'ENSA Nantes
(projet « Inclusion dans la ville historique », coordination Françoise Coulon). Il travaille sous Windows,
lance l'atlas dans **Chrome**, et range le projet dans Dropbox
(`D:\Dropbox\06 - ENSA\L3\S1 - Projet\Site\application\`).

## Ce qu'est l'application

Atlas web d'**analyse du site** (la phase projet a été retirée à sa demande) : maquette 3D / plan 2D du quartier
de l'Hôtel de Ville, époque « aujourd'hui » (sélecteur avant 1943 retiré le 21/10/2026, réactivable), cadastre et fiches du PSMV, relief, climat, soleil,
rayonnement et confort, vent, bruit, réseaux, trajets, coupes, exports (PNG, GLB/OBJ, DXF Lambert-93). Version 8 (octobre 2026).
Le mode d'emploi complet est dans `LISEZMOI.md`.

## Technique

- HTML + CSS + JavaScript en modules ES, **sans étape de compilation**. Three.js local (`lib/three/`, importmap
  dans `index.html`), SunCalc local (`lib/suncalc.js`). Pas de npm, pas de framework.
- Serveur local : `python serveur.py` (sans cache, pour que Chrome recharge les mises à jour).
  Lanceurs : `lancer-windows.bat`, `lancer-borne-windows.bat`, `lancer-mac.command`.
- Modes : `?mode=presentateur` (défaut), `?mode=borne`, `?mode=web`.
- Repère : origine `config.origine` = centroïde de la parcelle EY 64 de la mairie (47.218385, -1.55452, depuis le
  13/10/2026 ; avant : 47.2187, -1.5538, point approximatif au coin nord-est, 65 m plus loin), x vers l'est, z vers le sud,
  y vers le haut, en mètres (`js/geo.js` : `creerProjection`, `versLocal`, `versGeo`). Le centre peut être déplacé par
  l'outil Centre (réglage dans localStorage `atlas-hdv-centre`).
- **Règle : toute donnée en mètres locaux dépend de `config.origine`.** Fichiers concernés : `data/toits/hotel-de-ville.json`
  (porte son `origine` ; `js/toits.js` le recale à la lecture si elle diffère), caméras de `data/chapitres.json`,
  `data/ign/altimetrie.json` (porte son `origine`, recalé par `js/topo.js`), `data/facades/hotel-de-ville.json` (porte son `origine`, recalé par `js/toits.js`), idem `data/toits/ilot-*.json` et `data/facades/ilot-*.json`. Tout le reste est en WGS84 (coupes, projet,
  calques, relevés, axes, fiches, arbres, bâti disparu) ou centré sur (0, 0) par construction (plateau, confort, vent,
  caméra par défaut). Si l'origine change : translater les fichiers en mètres (ou laisser les recalages), vérifier les
  caméras, les caches IndexedDB suivent (`app.cleZone` contient l'origine).
- Données en ligne mises en cache IndexedDB (`js/cache.js`), clés suffixées par `app.cleZone`.
- Événements internes : `app.on(nom, fn)` / `app.emettre(nom, ...)` (`etat`, `couches`, `vue`, `fond`,
  `outil`, `pointeurSol`, `topographie`, `bati`…). Couches affichées : objet `app.couches`.
- **Météo : source unique** `data/meteo/meteo.json` + `meteo_horaire.json` (Météo-France, station 44020001 Nantes-Bouguenais,
  horaire 2016-2025, Licence Ouverte Etalab 2.0), lus une fois par `js/meteo.js` (`chargerMeteo`, puis `rose(n, saison, temperature)` en 16 ou 12
  secteurs, `normales()`, `depassements(n, saison)` en % de toutes les heures, `depassementsParMetre` pour vent-calcul,
  `horaire()` pour Confort (meteo_horaire.json), `mention()`, `avertissement(N)` sous 100 h, `csvRose`/`csvNormales`/`csvDepassements`).
  Saisons `annee|hiver|printemps|ete|automne`, températures `all|froid|frais|doux|chaud` ; dépassements sans découpage
  par température. Aucun appel à Open-Meteo. Mise à jour : `outils/meteo/` (filtre.py, analyse.py, puis horaire.py).
  `data/climat.json` et `data/vent/meteofrance.json` ont été supprimés.
  **Année choisie** : `data/meteo/meteo_annees.json` (`outils/meteo/annees.py` : `annees[AAAA] = { heures_vent_valides, couverture_pct,
  rose12[saison] (toutes températures), normales, extremes }`), lu par `chargerMeteo` ; `definirAnnee(a|null)`, `annee()`, `annees()`,
  `extremesAnnee()`, `libellePeriode()` ; `rose(12, …)` et `normales()` suivent l'année (`temperatureIgnoree` si tranche demandée) ;
  rose 16, `depassements`, CSV et Confort restent sur la moyenne ; `mention({ annee: true })` pour le texte de l'année.
  Sélecteur `app.climat.selecteurAnnee()` (Climat et Vent) → événement `meteoAnnee` (Climat se redessine s'il est l'outil ouvert, Vent redessine
  rose, saisons, mois et rose posée).
  **Source météo** (22/10/2026) : `definirSource('base'|'epw-nantes'|'epw-perso', { nom, texte })`, `source()` (type, libellé, période, avertissements : station > 30 km
  du site via `definirSite`, fuseau ≠ UTC+1, contrôles), `sourceEPW()`, `extremesJours()` (extremes.json ou EPW ; Climat ne lit plus le fichier lui-même), `journeesTypes()`
  (profils Chaleur tirés de l'EPW, sinon null → data/chaleur/journees.json). Un EPW est lu par `js/epw.js` (`lireEPW` : LOCATION, COMMENTS, DATA PERIODS, colonnes
  T, Td, HR, P, GHI, DNI, DHI, DD, FF, nébulosité ; manquants 99.9/999/9999 → NaN ; erreur `ErreurEPW` si pas de LOCATION, < 672 heures ou vent/T manquant > 50 %)
  puis `adapterEPW` (mêmes structures que meteo.json / meteo_horaire.json / extremes.json / journees.json ; heures EPW = heure normale du fichier, converties en heure
  de Paris avec l'heure d'été ; pas de rafales : FXImax et fxi = vent horaire max ; `donneesAnnees` null en EPW → sélecteur d'année masqué). Choix mémorisé dans
  localStorage `atlas-hdv-meteo-source`, fichier perso `{ nom, texte }` en IndexedDB (`js/cache.js`, clé `meteo-epw-perso`). UI : `js/meteo-source.js`
  (`creerSourceMeteo(app)` → `app.meteoSource`, créé avant `app.climat` ; `bloc()` `data-garder` en tête de Climat, Vent, Confort, Chaleur ; FileReader, aucun envoi ;
  « Enregistrer dans data/meteo/ » par `enregistrerDonnees`, serveur.py accepte `.epw`) → événement `meteoSource` (Climat redessine ; Vent relit, vide `bilans`,
  recalcule le confort au vent ; Confort vide `climato` et la carte ; Chaleur refait la section Température et recalcule ; Export met à jour sa mention). Styles fin de `css/complements.css`.
- Interface : `h(tag, attrs, ...enfants)` dans `js/util.js` ; outils ajoutés par `I.ajouterOutil({...})`
  dans `js/app.js` ; icônes dans `ICONES` de `js/interface.js`.
- Onglets de la barre d'outils (Site, Topographie, PSMV, Fond de plan, Bâtiments, Ambiance — id `climat` —, Coupes, Vues, Export) : liste `GROUPES` de `js/interface.js`,
  styles dans `css/onglets.css` (ajoutée par `interface.js` : `index.html` n'a pas été modifié), onglet actif
  gardé dans localStorage `atlas-hdv-onglet`. Un onglet sans outil est masqué, sauf s'il a un texte `aVenir`
  (panneau d'attente ; plus utilisé depuis l'étape 2). `ouvrir(id)` active l'onglet de l'outil (raccourcis compris).
- **Hauteurs corrigées** (`js/hauteurs.js`, `creerHauteurs(app)` → `app.hauteurs`, chargé après `app.projet.charger()`, avant le premier
  `construireBatiments`) : `data/hauteurs.json` `{ description, hauteurs: [{ cle, nom, hauteur, origine, lat, lon }] }`, clé comme les démolitions
  (`osm`/`id_ign`, sinon `g<lat>,<lon>` du centre). `construireBatiments` remplace la hauteur des bâtiments simples par `app.hauteurs.valeur(id, cx, cz)`
  (empreinte : `corrigee`, `hauteurOrigine`) ; corps détaillés non concernés. Outil `hauteurs` (onglet Bâtiments, horsBorne) : `captureSol` actif tant que
  l'outil est ouvert, sélection par lancer de rayon (`batimentSous`, comme projet.js) et surbrillance propre, `definir(em, h)`, `retablir(cle)` → `reconstruireBatiments` + `bati`.
- **Réseaux souterrains** (`js/reseaux.js`, `SOUTERRAINS`) : `data/reseaux/{gaz,elec-bt,elec-hta,postes}.geojson` + `sources.json` (GRDF, Enedis, Etalab 2.0,
  cercle 420 m, extraits le 15/10/2026), chargés par `chargerJSON` dans `construire()` (hors ligne). Groupe `reseaux-souterrains` (dans `reseaux`, donc sous
  `app.couches.reseaux`), un sous-groupe `reseau-<id>` par couche : ruban plat `geometrieRubans` (maquette.js) MeshBasic polygonOffset -7/-8/-9, renderOrder 5,
  y 0,10/0,12/0,14 m (gaz 0,9 m jaune #e6b800, BT 0,45 m #e3262c, HTA 1,5 m #9e0b1a) + trait 1 px (LineDashed pour HTA) renderOrder 6 ; postes = InstancedMesh
  de blocs 2,4 × 1,6 m. Drapés par relief.js (surfaces plates subdivisées). Cases mémorisées dans localStorage `atlas-hdv-reseaux-souterrains` (try/catch).
  `app.reseaux.souterrains` = [{ id, calque, fc, visible, objet }] ; export DXF (couches cochées) calques `RESEAU_GAZ`, `RESEAU_ELEC_BT`, `RESEAU_ELEC_HTA`,
  `POSTES` (cercles r 1,2 m). Sources, dates et limites dans le `info()` du titre ; ligne « non publié en open data — DT-DICT » pour eaux usées, pluviales,
  eau potable, fibre (`NON_PUBLIES`, aucun tracé). Ne jamais inventer de tracé.
- **Panneau Couches** (outil `couches`, onglet Site, L) : lecture, éléments de la maquette et bâti existant ; légende, explication des éléments et texte / crédits du bâti existant derrière des `info()` (titres Lecture, Éléments, Bâti existant) ; case « Mémoire du bâti disparu (1943) » masquée si `config.epoques === false`.
  Onglets de premier niveau `topographie` (outil `relief`, `panneauRelief` → `app.topo.construireCommandes`), `psmv` (outil `psmv`, `panneauPSMV` :
  cases cadastre/psmv/batimentsPSMV + `cadastre.construireLegende`), `fond` (outil `fond`, `panneauFond` : `calques.construireCommandesSol` +
  `calques.remplirPanneau` dans son propre conteneur, qu'il vide pour se redessiner), tous dans `js/app.js`, disponibles en borne. Libellé
  « Topographie » avec un trait d'union conditionnel U+00AD après « Topo » (coupure dans la barre de 64 px) ; libellés d'onglet sur deux lignes au-delà de 820 px.
  `rangerNotes` ne touche pas ces quatre panneaux. Les anciens sous-onglets (`.sous-onglets`, localStorage `atlas-hdv-couches`) ont été supprimés
  le 15/10/2026 : l'utilisateur ne les voyait pas (cachés dans le panneau Couches).
- `data/projet.json` et `data/imports/` sont écrits par l'utilisateur (outil Projet, serveur.py) : relire la version Dropbox avant un test
  (un ancien volume « rond » noir de 22 m, retiré par l'utilisateur le 15/10, apparaissait comme « cylindre noir » avec une copie périmée).
- **Flux** : `COULEURS_FLUX` (`js/flux.js`, bus `#d9822b`, tram `#2a7f9e`) : un mesh par mode (`lignes-bus`, `lignes-tram`), véhicules, arrêts
  (`etiquette-arret-bus|tram`, styles en fin de `css/onglets.css`, tram si `railway=tram_stop` ou `tram=yes`), légende `.legende-flux`.
- **Sol urbain** (`js/maquette.js`, 15/10/2026) : deux teintes uniques, `COULEURS.voirie` (chaussée #bdc1bf) et `COULEURS.cheminement` (trottoirs,
  places, chemins #dcdfdb), matériaux partagés `materiauSol('chaussee'|'trottoir')` (polygonOffset -4 / -3 ; y trottoirs 0,03, chaussées 0,055,
  végétal / eau / parkings 0,07-0,08, plateau 0,01, noms des rues 0,10 m) ; relief : `userData.reliefPas = 2` (voirie, surfaces, plateau : mailles
  de 2 m jusqu'à rayonPlateau + 30 m, 6 m au-delà, même découpage → pas de plaques au travers), `sol` glissé de `reliefDecalage` -0,6 m ; groupe `voirie` = meshes
  `trottoirs` (chemins + bande de `LARGEUR_TROTTOIR` 2,5 m de part et d'autre de chaque chaussée) et `chaussees` ; `geometrieRubans(l, y, { joints: true })`
  ajoute un disque à chaque sommet (raccords et carrefours sans trou ; reseaux.js l'appelle sans joints). Surfaces `voirie`/`pietonne` sur les mêmes matériaux ;
  végétal, eau, parking au-dessus (-5) ; noms des rues -6, réseaux -7 à -9.
- Soleil `grilleHauteurs` : arbres (cercles) et bâti triés ensemble par hauteur.
- Onglet Bâtiments : outils `bati` (commandes de `js/bati.js`, restées dans Couches en mode borne) et `projet`
  (`js/projet.js`, `creerProjet(app)`, styles `css/projet.css` ajoutés par le module). Démolition : le bâti est
  reconstruit sans les démolis (`app.reconstruireBatiments` passe par `app.projet.filtrer`), clé d'un bâtiment =
  `osm`/`id_ign`, sinon centre géographique ; bâtiment sous le pointeur par lancer de rayon sur le mesh fusionné
  (`faceIndex * 3` → `debut/nb`), sinon emprise sous le point du sol. Volumes : `anneauForme(f)` (repère x est,
  z sud, rotation trigonométrique nord en haut), groupe Three.js `projet` (`pasDeRelief`, posé avec `app.relief.dz`).
  Captures : `app.captureSol(p, e)` reçoit aussi l'événement ; une fonction marquée `sansSol` est appelée même
  sans point au sol ; `app.survolCapture(p, e)` est appelé au survol pendant une capture.
- **Bâti effectif** : `app.batiEffectif()` = `app.empreintes` (sans les démolis) + volumes du projet au même format
  (`mesh: null`, `projet: true`, `cle` `PI`/`PE`). À utiliser pour tout calcul sur le bâti (Soleil `grilleHauteurs`,
  Confort via Soleil, Vent `preparerGrille`, export) ; écouter `app.on('bati', …)` pour recalculer.
  `data/projet.json` : `{ visible, couleur?, demolis: [{ cle, nom, hauteur }], formes: [{ n, forme, a, b, t, rot, h, lat, lon, vis, couleur? }] }`
  (couleurs `#rrggbb` : par volume, sinon `couleur` par défaut du projet, sinon `--projet` ; matériau propre libéré au redessin).
- **Coupes** (`js/coupes.js`, `css/coupes.css` ajoutée par le module) : liste `app.coupes.liste` de coupes `{ id, nom, type: 'ligne'|'zone'|'polyligne', visible, … }` ;
  lignes `{ A, B, inverse, decalage, profondeur }` (A et B prédéfinies depuis `config.axes`, `predefinie: true`, non supprimables),
  zones `{ cx, cz, a, b, rot, hmax }` (rectangle comme `anneauForme`, rotation trigonométrique nord en haut). Une seule active
  (`etat.actif`, `activer(id)`, `desactiver()`, utilisés par chapitres.js et vue.js) : `renderer.clippingPlanes` = 1 plan (+ plan arrière si
  profondeur) ou 5 plans (boîte, plafond à `dz(centre) + hmax`). Poché : sections analytiques des polygones de `app.batiEffectif()`
  (filtrés par `visibiliteBatiment`), quads posés à 6 cm du plan côté gardé, plafond triangulé (`ShapeUtils`), groupe `coupes-poche` ;
  recalcul sur `bati`, `etat` et changement de relief. Tracé : `app.captureSol` / `survolCapture` (2 clics ligne, 3 clics zone).
  Dessin 2D : `modele(id)` (abscisse de gauche à droite pour l'observateur, altitudes NGF par `app.topo.altitude`), `svg(id)`,
  `dxf(id)` (R12 : POLYLINE, SOLID, LINE, TEXT ; calques `COUPE_SOL`, `COUPE_BATI`, `COUPE_PROJET`, `ELEVATION`, `COTES`),
  `exporterSVG`/`exporterDXF`, `blocExport()` inséré dans l'onglet Export. `app.coupes.axes` = coupes linéaires (export DXF du plan).
  `data/coupes.json` : `{ coupes: [{ id, nom, type, visible, predefinie?, inverse, decalage, profondeur, de, a } | { …, centre, longueur, largeur, rot, hmax } | { …, points: [[lat, lon]], inverse, profondeur, segment }] }`.
  Polylignes `{ P: [Vector3], inverse, profondeur, segment }` : `segmentsPoly`/`segmentsCoupe`, poché par segment, clipping sur le segment `c.segment` ;
  tracé par clics (`captureSol.pointPoly`), `finirPolyligne()` (dblclick sur le canevas), `editerPoint(c, k, 'deplacer'|'supprimer'|'inserer')`.
  `modele()` déroule les segments (`plis`, calque DXF `PLIS`) et liste les `facades` (photos de `app.toits.ensembles`) ; `svgCoupe(M, grand, { couleurs, images })`,
  `etat.couleurs` (case « En couleurs »), `exporterSVG` asynchrone (photos en data: URI). `vueFace()`/`quitterVueFace()` : OrthographicCamera + OrbitControls
  sans rotation permutés dans `app.camera`/`app.controls`, état dans `etat.face`, quittée au changement d'outil, de coupe ou de vue (`vueDeFace`).
- **Vues** (`js/vues.js`, `creerVues(app)` → `app.vues`, créé après `app.chapitres`, avant l'interface, `await app.vues.charger()` ; outils de l'onglet déclarés par `app.vues.ajouterOutils(I, ajouterLigneAide)` ; `css/vues.css` ajoutée par le module ; onglet `vues`) :
  `capturer(nom)` → `{ id, nom, date, projection: '3d'|'axo'|'plan'|'face'|'pieton', camera: { position: { lat, lon, h }, cible: { lat, lon, h }, focale, demi }, coupe, soleil: { annee, jour, heure },
  etat, couches, vueMaquette, bati: { mode, representation }, onglet, outil, reglages, pieton?, vignette }` (`reglages` = `reglagesOutils()` : chaleur { affichage, vueTemp, meteo, toits }, vent { direction, vitesse, saison, temperature, modeVitesse, confort, seuil, roseMaquette, quatreSaisons }, reseaux { id: visible } ; posés par `appliquerReglages` avant de rouvrir l'outil). `nomAuto()` : libellé de l'outil ouvert (+ carte de Chaleur ou saison du Vent) – « 21 juin 15 h », dédoublonné ; champ en tête du panneau (`.tete-vues`, sticky), reproposé sur `outil`/`soleil`/`vue`/`couches` tant qu'il n'est pas modifié. Événement `vues` à chaque changement de liste ou de vue courante. (h = hauteur au-dessus de `app.relief.dz` : indépendant de `config.origine` ;
  `demi` = demi-hauteur visible en m pour axo/plan ; vignette JPEG 192 × 120 rendue à la demande). `appliquer(v, { duree, outil })` : époque, couches, maquette, représentation et mode du bâti,
  soleil, onglet/outil (option localStorage `atlas-hdv-vues`), coupe, projection puis `allerVers` + focale animée. `aller(i)`, `suivante()`, `precedente()` (touches N / P, listener propre,
  inactif pendant la vue piéton ou Relevé). `data/vues.json` `{ description, vues: [...] }` (`enregistrer()` par `enregistrerDonnees`). Focale mm équivalent 24 × 36 : `focaleVersFov(f) = 2 atan(12/f)` sur
  la caméra perspective (`app.vues.cam3`, gardée même en plan ou axo). **Axonométrie** : `entrerAxo()` / `quitterAxo()` permutent une OrthographicCamera (à 1 500 m de la cible, `axo.demi / zoom`)
  et ses OrbitControls dans `app.camera` / `app.controls`, comme la vue de face des coupes. `app.vue.basculer` est enveloppé : toute bascule plan/3D quitte d'abord axo, piéton et vue de face (`quitterModes`).
  **Observateur** (`js/pieton.js`, `creerPieton(app, vues)` → `app.pieton`, créé par vues.js ; outil `observateur`) : `obs { pose, x, z, cap (rad, 0 = nord, horaire), inclinaison, hauteur, focale }`,
  pose par `app.captureSol` (clic 1 position, survol + clic 2 direction), groupe `observateur` (`pasDeRelief`, posé à `dz`) : capsule + tête, anneau, secteur au sol (champ horizontal = écran + focale, 30 m)
  et 4 arêtes depuis l'œil. `entrer()` : `allerVers` jusqu'à l'œil, puis `app.controls` = contrôle neutre `{ target, update(){} }` (ctl3 désactivé), caméra pilotée par sa propre boucle rAF ;
  clavier en phase de capture (`e.code` KeyW/KeyA/KeyS/KeyD, flèches, Maj ; `stopImmediatePropagation` pour ne pas déclencher S, flèches…), Échap → `quitter()` (retour à la vue d'avant) ;
  regard : pointer lock au clic souris, sinon glisser ; molette = focale ; pavé `.pad-pieton` si `(pointer: coarse)` ; `app.captureSol` neutre pendant la vue (pas de fiche au clic).
  Collisions : `bloque(x, z)` sur les polygones de `app.batiEffectif()` (grille de 25 m, rayon 0,3 m, glissement par axe, refait sur `bati`, inactif si `app.bati.masque`). `etatVue()` / `appliquerVue(v)` pour l'outil Vues.
  **Parcours** (`js/parcours.js`, `creerParcours(app, vues)` → remplace l'interface neutre `app.parcours` ; `css/parcours.css` ; outil `parcours`) : `maj(dt)` (boucle de rendu) échantillonne la caméra
  (continu, 0,1 s, points identiques fusionnés sauf pause > 1 s) ou lit ; points clés `ajouterCle()` (t += max(2 s, distance / 12 m/s)) ; lecture `lire(i, { boucle, video })` : `actif` → la boucle
  ne fait plus `controls.update()`, position et cible en Catmull-Rom (adoucie aux points clés), focale linéaire ; `basculerPause()` (Espace), `arreter()` (Échap, chapitres, plan) ;
  `exporterVideo(i)` : `canvas.captureStream(30)` + MediaRecorder (`formatVideo()` VP9/VP8), arrêt après la dernière image, `telecharger(<nom>.webm)` ; `demarrer()` (fin de présentation borne) lit le premier parcours.
  `data/parcours.json` `{ description, parcours: [{ id, nom, mode: 'continu'|'cles', date, duree, points: [{ t, p: [lat, lon, h], c: [lat, lon, h], f }] }] }`, lu par `app.vues.charger()`.
- **Vues rapides** (`js/vues-rapides.js`, `creerVuesRapides(app)` → `app.vuesRapides`, créé juste après `app.vues.charger()`) : `details.vues-rapides` ajouté à `#haut-droite` sous la barre Soleil ; liste de `app.vues.liste` (clic : `aller(i, { outil: true })`), « + » : `enregistrerVue(nomAuto())` puis POST direct `__enregistrer/data/vues.json` (serveur.py ; sans serveur, bouton « Enregistrer » = `app.vues.enregistrer()`) ; ouvert/replié dans localStorage `atlas-hdv-vues-rapides`. Écoute `vues`.
- **Légende automatique** (`js/legende.js`, `creerLegende(app)` → `app.legende`, créé après `app.centre`) : `details#legende-auto.legende-auto` (bas gauche, au-dessus de `#regle-chapitres`, décalé à droite du panneau ouvert ou de la carte de chapitre ; ouvert/replié dans localStorage `atlas-hdv-legende`). `decrire()` → sections `{ id, titre, items: [{ libelle, couleur, forme: aplat|contour|trait|tirets|cercle|carre }], degrade?: { stops: [[u, [r,g,b]]], graduations: [{ u, texte }], gauche?, droite? }, note? }` : analyses d'abord (outil ouvert en tête) via `app.chaleur.legendeAuto()`, `app.confort.legendeAuto()`, `app.soleil.legendeAuto()` (hooks ajoutés dans ces modules, mêmes palettes que leurs panneaux), Vent (particules, `CLASSES_CONFORT` de vent-calcul.js si `etat.confort && etat.P`) et Bruit (classes `userData.classe` des meshes du groupe `bruit`) ; puis `maquette` (éléments `maq*` cochés et présents, ombres portées si soleil levé, projet si volumes ou imports chargés), `reseaux` (souterrains visibles, jeux), `flux`. `grader(G, ecart)` retire les graduations trop proches. Mise à jour : événements (couches, outil, bati, etat, meteoSource, meteoAnnee, soleil, vues, vueMaquette, legende, relief) + contrôle de signature toutes les 1,5 s. Sert aussi à la planche.
- **4 roses des saisons** (`js/roses-saisons.js`, `creerRosesSaisons(app)` → `app.rosesSaisons`) : `donneesRoses()` (rose(12, saison, 'all') × 4, échelle commune `axe`, dominant, `fort` = % des heures > 5 m/s, `ventee` = saison la plus ventée), `svgRose(s, axe, { cx, cy, R, p, actif })` (chaîne SVG, unités libres). Bloc inséré sous `.rose-conteneur` du panneau Vent à l'ouverture (événement `outil`, sans modifier vent.js) : case « 4 saisons » → `app.vent.etat.quatreSaisons`, clic sur une rose = change le select Période du panneau. Redessin sur `meteoSource`, `meteoAnnee`.
- **Planche à l'échelle** (`js/planche.js`, `creerPlanche(app)` → `app.planche` ; PDF minimal `js/pdf.js` `pdfImages(pages)` : JPEG DCTDecode pleine page, MediaBox en points) : bloc `.bloc-planche` inséré en tête du panneau Export (événement `outil` = `exporter`, `data-garder`). `reglages { format (c500 défaut|c450|c400|a3|a2|a1|perso), largeur, hauteur, echelle 200|250|500|1000, mode rogner|ajuster|reduire, marge, aPart, roses (null = auto si Vent ouvert ou 4 saisons), dpi 300|150, titre, rayon (null = config.rayonPlateau) }`. `mise()` → `{ W, H, k (mm/m), echelle, Rm, Raff, Rmm, cx, cy, zone, type: coins|bande|apart, cadres { elements, reseaux, analyse, cartouche, roses? }, page2?, alertes }` (coins : côté calculé pour rester hors du cercle ; roses → coins + bandeaux haut/bas ; format allongé → bande latérale ; sinon 2e page). `svgPlanche(L, { carte, page, px })` : viewBox en mm, groupes `carte` (clip zone ∩ cercle : socle, `places-pietonnes`, `trottoirs`, `chaussees`, `stationnements`, `espaces-verts`, `eau`, `analyse` = textures DataTexture des plans au sol en `<image>` calées, `bruit`, `ombres` (polygones projetés, soleil de la barre), `reseau-*`, `flux-*`, `arbres`, `bati`, `projet`, `coupes`, `noms-rues` via `app.rues.poses`), `cercle`, `roses-des-vents`, `legende-*`, `cartouche` (nord, `echelle-graphique` avec data-longueur-m/mm). PDF : `rendreOrtho` (OrthographicCamera vers le bas, up -z, tuiles de 1024 px par setViewOffset, brouillard retiré, vue étendue si le cercle dépasse le plateau), découpe au cercle, calque SVG des cadres rasterisé par-dessus. Contrôle : au 1/500, 100 m = 200 mm (cercle de 210 m = 420 mm mesuré dans le PDF) ; au 1/200 le plateau de 90 m fait 450 mm (25 mm de marge sur 500 × 500).
- **Toitures détaillées par ensembles** (`js/toits.js`, `creerToits(app)` → `app.toits`, chargé avant le bâti) : liste
  `ENSEMBLES` (`hotel-de-ville`, `ilot-saint-vincent`, `ilot-commune-saint-vincent`, `ilot-fanny-peccot`, `hotel-de-charette`, `moulin-23-27`, `fenelon-flechier` ; ou `config.toits.ensembles`), chaque ensemble = `data/toits/<id>.json`
  + facultatif `data/facades/<id>.json` et `data/facades/<id>/*.jpg` (`app.toits.ensembles` = `[{ id, donnees, facades }]` ;
  `app.toits.donnees` / `facades` = ceux de la mairie). Un ensemble hors mairie déclare `remarquable: { id, fiche, etiquette }`
  (`app.toits.remarquable(corps)`, utilisé par `construireBatiments` à la place de la remarquable « mairie ») et a sa fiche dans
  `data/fiches.json` (îlot : `ilot-saint-vincent`). Type de toit `comble-brise` (`h_egout`, `h_brisis`, `retrait`, `h_faitage`,
  `retrait_faitage`, `toit_terrasson`) : brisis puis terrasson sur chaque côté d'un gabarit convexe à n côtés (`combleBrise`).
  Champ de corps `etages: { n, source }` prioritaire sur la BD TOPO. Hôtel de Ville : lit
  `data/toits/hotel-de-ville.json` (`perimetre.polygone` = parcelle EY 64, `objets_bdtopo`, `cours`, `corps[]` :
  `{ id, nom, objet_bdtopo, emprise: [[x, z]…] (emprise réelle, polygone), trous?, gabarit?: [[x, z]×4], toit: { type, h_egout, h_faitage, faitage?: [P, Q], h_brisis?, retrait?,
  retrait_faitage?, h_verriere?, retrait_verriere?, centre?, rayon? }, materiaux, etages_estimes, sources, confiance }`,
  types `deux-pans|croupe|pavillon|mansarde|verriere|terrasse|tour`). Pans : chaque sommet de l'emprise rejoint l'extrémité
  du faîtage la plus proche (croupe, ou pignon vertical si le point est sur le côté). Corps à `gabarit` (ou terrasse) :
  `geometrieDecoupee` calcule la fonction hauteur du toit (arbre min/max de plans relevés sur le gabarit, prolongés, jamais
  sous l'égout), découpe exactement les triangles de l'emprise réelle selon le plan actif et monte les murs jusqu'au toit ;
  emprises réelles = bâtiments OSM de la mairie partagés entre corps (pas de débord ni de recouvrement), restes en
  `complement-n` (terrasse, hauteur médiane du MNH LiDAR). `app.toits.centre()` = centroïde du périmètre (départ de la coupe B,
  étiquette « Hôtel de Ville »). `construireBatiments` appelle
  `app.toits.assigner(lots)` : un corps va au bâtiment chargé (OSM ou BD TOPO) du périmètre qui contient son centre ;
  ce bâtiment devient remarquable `mairie`, garde son emprise et sa clé (démolition, DXF, soleil, vent), `hauteur` = faîtage
  max, `empreinte.detail.corps`, `empreinte.couleurs` (teintes rétablies par `colorierBatiments`), `empreinte.hauteurEn(x, z)`
  (poché 3D des coupes qui suit les pans). Lignes d'étages : enfant `etages` (`userData.blocRelief`, suivi d'un bloc par
  relief.js). Représentation à 4 choix dans le panneau Bâti : `app.toits.definirRepresentation('simple'|'detaille'|'photos'|'blanc')`
  (`representation()` la lit ; plus de localStorage : « photos » forcé au démarrage) ; `etat.mode` simple/detaille, `etat.photos`, `etat.blanc`
  (blanc : `colorierBatiments` n'applique pas `empreinte.couleurs`, photos masquées). `definirMode` reconstruit le bâti et émet `bati`. Fiche : `app.fiches.ouvrir(id, { point })` ; `app.toits.blocFiche`
  ajoute le corps cliqué à la fiche `mairie`. Export GLB/OBJ : géométrie détaillée dans « Bati existant » (couleurs
  retirées comme pour le reste du bâti, sauf couleurs PSMV affichées).
- **Photos de façade de la mairie** (`js/toits.js`, `data/facades/hotel-de-ville.json` + `data/facades/hotel-de-ville/*.jpg`) :
  `tampon().mur(p, q, hp, hq, teinte, out)` enregistre chaque mur des géométries détaillées dans `geometry.userData.murs` ;
  (tous ensembles : images lues dans `data/facades/<id>/`, ids de façade uniques entre ensembles)
  `app.toits.facadesPhoto(geos)` (appelé par `construireBatiments`, résultat dans `empreinte.facades`, ajouté en enfants du mesh
  de la mairie) construit pour chaque façade `{ id, gauche, droite, normale_az, hauteur_m, image, source, auteur, licence, date_prise,
  confiance, corps }` un mesh texturé sur les murs à moins de 2 m du segment, parallèles (±25°) et tournés vers la rue : mêmes sommets
  que le mur (relief : `userData.blocRelief`), u le long de la façade, v = y / hauteur_m (coupé au-dessus), MeshStandardMaterial
  `map` + polygonOffset (ombrage et ombres conservés), `raycast` neutralisé, opacité recopiée de `app.materiaux.remarquable`
  (`onBeforeRender`). Bascule `app.toits.definirPhotos(v)` (sans localStorage), masquées si les
  bâtiments sont colorés PSMV ou si l'image manque (message dans le panneau Bâti). Crédits : `app.toits.creditsFacades()` (panneau Bâti,
  légende de Couches), bloc « Photos de façade » de la fiche `mairie`. Export GLB et OBJ (ZIP) : objets « Facade photo <id> » texturés.
  Façades traitées : rue de la Commune (n° 2, n° 4, pavillon à verrière, pavillon blanc, aile basse) ; rue de Strasbourg (aile moderne,
  pignon nord côté Garde-Dieu, pignon du pavillon sud-est) et pavillons de la cour d'honneur (rue de l'Hôtel de Ville, rue du Général-Leclerc),
  ajoutés le 14/10/2026 ; Panoramax immergis (Licence Ouverte 2.0), Koreller (CC BY-SA 4.0, pavillon ouest) et PSMV fiche 39. Images redressées par homographie (scripts hors atlas, non livrés).
  Îlot Saint-Vincent (`ilot-saint-vincent`, 14/10/2026) : un corps (OSM relation/1273706, courette en `trous`), comble brisé
  égout 18,4 m / brisis 22,5 m / sommet 25,3 m ; façades `rue-strasbourg-27`, `rue-leclerc-sud`, `place-saint-jean-pointe`
  (Panoramax immergis, vues horizontales perpendiculaires à la façade puis mise aux dimensions réelles) ; rue Saint-Vincent en teinte.
  Îlot rue de la Commune – rue Saint-Vincent (`ilot-commune-saint-vincent`) : 8 corps découpés dans 4 bâtiments OSM (boîtes), toits ajustés
  automatiquement sur le MNH (script hors atlas : deux pans à pignons ou terrasse, champ `ajustement`) ; façades `rue-commune-1` (Panoramax),
  `rue-commune-3`, `rue-commune-5`, `rue-saint-vincent-9` (photos PSMV redressées, `lien` vers `data/psmv/photos/`). `blocFiche` : clic sur un mur → `corpsProche` (1 m).
  Îlot rue Fanny Peccot – rue Saint-Vincent (`ilot-fanny-peccot`) : 7 corps dans 5 bâtiments OSM ; `comble-brise` pour les n° 9 et 11 a
  rue du Général-Leclerc (gabarit = enveloppe convexe de l'emprise prolongée de 4 m sur les mitoyens, pas de brisis sur un mitoyen),
  deux pans (11 b, aile du 3 rue Saint-Vincent, angle Fanny Peccot), terrasses (corps bas et cour de la résidence) ; façades `rue-leclerc-9`,
  `rue-leclerc-11`, `pignon-fanny-peccot-3` (Panoramax), `rue-fanny-peccot-3`, `rue-saint-vincent-1`, `rue-saint-vincent-3` (PSMV 31-32).
  Parcelles EO 26 (`hotel-de-charette`), EO 195 (`moulin-23-27`), EO 49 + 162 (`fenelon-flechier`) : sans fichier de façades, sauf `hotel-de-charette` (`facades/hotel-de-charette.json`, une photo : façade sur cour vue de la rue du Moulin) ; corps découpés par
  boîtes dans les bâtiments OSM, égout parfois fixé (`ajustement.remarque`), `etages` renseigné pour chaque corps, `materiaux.confiance`.
- Adresse et liens externes : `config.json > adresse` et `liens` (`{ cle: { libelle, titre, url } }`), affichés
  en tête du panneau Couches par `blocAdresse()` (`js/app.js`), liens masqués en mode borne.

- **Démarrage** : `etatDeDemarrage()` (fin de `demarrer()`, après `chapitres.aller(0, { instantane: true })`) : vue 3D,
  représentation « photos », `couches.axes = false`, coupe désactivée, soleil 21 juin 12 h (`soleil.regler`), caméra sur la place
  de l'Hôtel de Ville (47.21768, -1.55419) ; surcharge `config.json > demarrage { cible, recul, jour: "MM-JJ", heure }`.
- **Bouton « i »** : `info(...textes ou nœuds)` dans `js/util.js` (infobulle `title` + panneau `.info-panneau` au clic, Échap ferme ;
  styles en fin de `css/atlas.css`) ; titre + bouton : `h('div', { class: 'titre-info' }, h('h3', …), info(…))`.
- **Rose des vents** : dessinée par `js/climat.js` (`reglerRose({ n, saison, temperature, visible })`), pilotée par l'outil Vent
  (case « Poser la rose… », 12 secteurs, masquée à la fermeture de Vent) ; le panneau Climat n'a plus de rose.
- **Bouton « i » automatique** : `rangerNotes(contenu)` dans `js/interface.js` (après `construire`, puis 1,5 s plus tard pour les sources
  remplies après lecture des données) range les `p.note` / `p.source` non vides, sans `aria-live` ni `role`, enfants directs du panneau
  ou d'une section à `h3`, derrière un `info()` à côté du `h3` précédent (sinon ligne « À propos » en tête). Exclus : panneaux Couches, Relief, PSMV, Fond,
  messages d'état (regex `ETAT` : « Aucun… », « Projet vide… »…), `[data-garder]`, notes dans `li`, `label`, `table`, `details`.
  Pour garder une note visible : `data-garder` ou `role="status"`.
- **Noms des rues** (`js/rues.js`, `creerRues(app)` → `app.rues`, `demarrer()` après `construireVoirie`, `maj()` dans la boucle) :
  noms OSM (`name`) de `app.donnees.osm.voirie`, tronçons raboutés par nom. Depuis le 21/10/2026 : taille unique `H_TEXTE` 2,6 m (plan),
  variantes nom complet → abrégé (`ABREV`) → réduit 0,85 / 0,7 ; deux jeux d'étiquettes (`mode`) : `etendue` (une ou deux par nom, deux au-delà
  de 220 m, 120 m d'écart, portion droite : écart à la corde < 0,35 h ; masquées sous 7 px) et `maquette` (vue maquette coupée : une par voie
  qui traverse le plateau, au plus près du milieu de son tronçon intérieur, rectangle à 1,2 m du bord au moins), jamais sur une emprise
  bâtie ni sous une couronne d'arbre (d × 0,6), sans recouvrement (`chevauche`) ; `rues.demarrer()` après `construireArbres`, refait sur `bati`.
  Plan découpé (mailles 2 m) dont chaque sommet suit `app.relief.dz` (+0,10 m, `poser`) ; orientation fixe le long de la voie, lecture
  rétablie en tournant la texture de 180° (`map.rotation`, `orienter`) ; couche `app.couches.rues`. Groupe `rues`, `pasDeRelief`.
- **Soleil persistant** : `construireBarre()` de `js/soleil.js` ajoute `details.soleil-barre` dans `#haut-droite` (date `input[type=date]`,
  heure en curseur, boutons `.soleil-heure-rapide` 10 h / 13 h / 16 h (`HEURES_RAPIDES`) surlignés par `majBarre`), mis à jour par `maj()` ; styles `css/complements.css` (chargée par soleil.js ; aussi `.extremes` de Climat).
- **Jours extrêmes** : `data/meteo/extremes.json` (`outils/meteo/extremes.py`, journée civile Europe/Paris, ≥ 20 h de mesures,
  2016-2025) lu par `js/climat.js` (`blocExtremes()`).
- **Import 3D** (`js/imports.js`, `creerImports(app)` → `app.imports`, créé juste après `app.projet`) : loaders locaux
  `lib/three/addons/loaders/{GLTFLoader,OBJLoader,MTLLoader}.js` (copiés de three 0.180.0 npm, même version que lib). `importer(files)`
  (fichiers choisis ensemble, LoadingManager + setURLModifier vers des blob: ; copie par `enregistrerDonnees('imports/<nom>')` si serveur.py),
  `placer(it)` (rotation, unite × echelle, posé au sol + hauteur + dz du relief), `calculerEmprise(it)` (enveloppe convexe des sommets ;
  couverture rastérisée triangle par triangle ; simple si couverture ≥ 0,85 et hauteur > 0,5 m). `projet.js` appelle `empreintes()`
  (entrées `importe: true, projet: true` du bâti effectif, modèles simples seulement), `serialiser()` / `lire(liste)` (clé `imports` de
  `projet.json` : `[{ n, nom, fichiers: ['imports/…'], lat, lon, rot, unite, echelle, hauteur, vis }]`), `construireBloc(div)`,
  `vider()`, `nombre()`. Écoute `bati`, `etat`, `relief`, `outil` (placement au clic). Export : `objetsExport(dedans)`.
  OBJ : `garderMaillages` (imports.js) retire points et lignes (OBJ NURBS de Rhino : lignes `vp`, positions NaN) et refuse un OBJ sans maillage.
  serveur.py accepte en plus .glb .gltf .bin .obj .mtl dans data/. Pas de FBX (pas d'exporteur Three.js fiable).
- **Export OBJ** (`js/export.js`) : `archiveOBJ(scene, base)` → ZIP (`zip()` maison, méthode stockée, CRC32) : .obj (mtllib),
  .mtl (Kd, d, map_Kd textures/<nom>.jpg ; noms de matériaux nettoyés et uniques, rétablis après), JPEG redessinés par canvas,
  LISEZ-MOI.txt. Photos de façade exportées pour tous les formats ; volumes du projet dans leur couleur.
- **Chaleur** (`js/chaleur.js`, `creerChaleur(app)` → `app.chaleur`, créé après Confort ; outil `chaleur`, onglet Ambiance ; `css/chaleur.css` ajoutée par le module). ESTIMATION PÉDAGOGIQUE (bandeau `data-garder`, limites dans les « i »).
  Grille des matériaux `construireGrille({ corrections, bati })` → `{ r, pas (2 m, 3 m au-delà de 150 m), n, x0, z0, cls (index de classe, 254 bâti, 255 hors cercle), zone, zones [{ type, cle, nom }], arbre, bat, batiments [{ e, toit, source, cellules }] }`,
  rayon = `config.rayonConfort` (max 300 m). Ordre : orthophoto (`data/chaleur/ortho.json`, grille de 4 m v/c/. codée par plages, WGS84) < surfaces OSM (`app.donnees.osm.surfaces`, catégorie `surface` de donnees.js) < bandes de trottoir
  (largeur + 2 × 2,5 m) < chemins < chaussées (`surface=*` d'OSM, table `SURFACE_OSM`, largeurs `LARGEURS` copiées de maquette.js) < sol sous arbres (`app.arbres.lots`) < corrections (disque, polygone) ; bâti effectif filtré par `visibiliteBatiment`.
  Toitures : correction > corps détaillés (`materiaux.toit`) > `data/chaleur/toitures.json` (`t: [[clé osm|cleabs, classe, source o/b/d/p/f/x, code BD TOPO, lat?, lon?]]`) > terrasse (projet) > ardoise ; clé de bâtiment `e.id` sinon `g<lat>,<lon>`.
  `data/chaleur/materiaux.json` : `classes { id: { libelle, type sol|toit, couleur, albedo, plage, emissivite, effusivite, evaporation, transmission?, refs } }`, `references`, `modele`, `verification`.
  `data/chaleur/corrections.json` : `{ corrections: [{ id, type: 'element' (cle osm ou osm#trottoir) | 'disque' (lat, lon, rayon) | 'polygone' (points) | 'toit' (cle), classe, date }] }`, écrit par `enregistrerDonnees('chaleur/corrections.json')`.
  Affichage : texture `DataTexture` au sol (`chaleur-carte`, y 0,33, polygonOffset -11, comme Confort), toits par couleurs de sommets (normale y > 0,55), rétablis par `app.cadastre.majBatiments(true)`.
  Vues `etat.affichage` : `materiaux` (couleur de classe), `echauffement` (`c.tref` = `temperatureReference(c)` de chaleur-modele.js : équilibre du bilan de simulerJournee dans `REFERENCE` { K 800 W/m², ta 30 °C, hr 40 %, v 2 m/s, ciel clair, SVF 1, sousArbres × 0,2 }, rappel force-restore ∝ effusivité ;
  `PALETTE_ECH` bleu → blanc cassé → rouge sur `etat.ech` = [min, max] des classes ; herbe ≈ 42 °C bleue, zinc ≈ 64 °C), `albedo` (« Albédo seul », `PALETTE_ALB` rouge → bleu, échelle fixe 0,05-0,5), `temperature`, `ecart`. `degradeActif()` (palette, bornes, graduations, textes) sert la légende `legendeDegrade()` (classes `.legende-albedo*` de css/chaleur.css) et la barre de l'export PNG (`api.degradeActif` dans chaleur-points.js).
  Température (`js/chaleur-modele.js`, calcul pur) : `preparerPoints` (mailles du sol + 24 points par toit), `calculerSVF` (24 directions, 120 m, grille `app.soleil.grilleHauteurs`), `positionsSoleil` / `calculerMasques`
  (49 instantanés de 30 min, arrêt des rayons au-dessus de la hauteur max), `simulerJournee` (force-restore Deardorff, pas de 5 min, deux jours, Brutsaert + nébulosité, h = 5,7 + 3,8 v, évaporation = part du net) → `{ T (49 × n), Tmax, hMax }`.
  Jour et heure = barre Soleil (événement `soleil` : même jour → réaffichage, autre jour → recalcul) ; météo `horaire().moyennes[mois]` ou `data/chaleur/journees.json` (`profils.chaude|record.heures[0-23]`, `outils/chaleur/journees.py`) ;
  vent local = `app.vent.etat.solveur.echantillon(x, -z)` si calculé, sinon 0,35 + 0,65 SVF. `etat.suspendu` ignore l'événement `bati` pendant une comparaison.
  Lot 3 (`js/chaleur-points.js`, `creerPointsChauds(app, api)`) : zones ≥ 9e décile / ≤ 1er décile (8-connexité, ≥ 16 m², 6 chaudes, 4 fraîches), étiquettes groupe `chaleur` ; variantes provisoires ; comparaison existant / projet par
  `app.projet.definirVisible(false|true)` (rétabli ensuite) ; exports PNG (texture + légende), CSV (Lambert-93 `versLambert93` d'export.js), DXF R12 calque `CHALEUR`. Pré-traitement hors ligne : `outils/chaleur/pretraitement.py` (BD TOPO WFS + orthophoto WMS téléchargées dans un dossier à part, `python3 -I`).
- **Vue maquette coupée** (`js/decoupe.js`, 21/10/2026, `app.decoupe`) : par défaut (`config.vueMaquetteParDefaut`, appliquée dans `etatDeDemarrage`) ;
  touche M / `app.definirVueMaquette(b)` (émet `vueMaquette`, appelle `app.decoupe.appliquer()`). 64 plans locaux (polygone inscrit au cercle `rayonPlateau`,
  mêmes angles que `CircleGeometry(R, 64)`) ajoutés à `material.clippingPlanes` (avec `clipShadows`) de tous les matériaux de la scène, rebalayés toutes les
  500 ms (`app.decoupe.maj(t)` dans la boucle), retirés en vue étendue ; jamais coupés : noms `EXCLUS` (sol, socle-maquette, faces-coupe-maquette, observateur,
  vent-fleche, rose-vents), objets `userData.horsDecoupe`, groupes sans nom à la racine de la scène (trajectoire du soleil, aperçus Centre, Relevé,
  Coupes) et anneau sans nom (cercle Confort) : nommer un nouveau groupe à la racine s'il doit être coupé. Faces de coupe : groupe
  `faces-coupe-maquette`, un mesh par mesh de bâti (`userData.batiment`), murs sur le polygone de la base (ou du terrain `app.relief.dz`) au toit (`e.hauteur`, ou
  `e.hauteurEn` pour les ensembles détaillés), poché `POCHE`, refaits sur `bati`, `relief` et `reconstruireBatiments`, synchronisés avant chaque rendu (visibilité,
  transparence du bâti). Projet et imports : faces arrière en poché (onBeforeCompile chaîné, `DoubleSide`). Socle = `app.sol.epaisseur` (bande sur le polygone,
  suit le relief). `visibiliteBatiment` ne masque plus le bâti hors plateau quand la découpe est disponible (`config.decoupeMaquette !== false`) ; voirie et
  surfaces restent affichées (coupées). Étiquettes hors plateau masquées, clics hors plateau ignorés (`app.decoupe.dedans`). Chapitres : `vueMaquette` appliquée
  seulement si précisée. Calculs (`{ ...app, vueMaquette: false }`) et exports inchangés.
- **Éléments de la maquette** (`js/elements.js`, `app.elements`, Site > Couches ; texte derrière un « i » ; « Arbres » et « Espaces verts » (`maqEspacesVerts`) séparés) : `ELEMENTS` (clés `maq*` + `arbres` dans `app.couches`, plus `rues`, `etiquettes`
  et relief = `app.relief.activer`). Masquage au rendu seulement : `renderer.render` est enveloppé (objets décochés `.visible = false` le temps de l'image, puis
  remis) : `.visible`, lancers de rayons de calcul et exports DXF/GLB intacts, PNG compris dans l'affichage. `app.elements.affiche(obj)` filtre les clics. Clés `maq*`
  dans localStorage `atlas-hdv-elements` ; toutes gardées par les points de vue (`couches`).
- **Époques désactivables** : `config.epoques === false` (`app.epoques`) → `temps.js` n'active que `actuel`, `#frise-etats` caché, touches 1 2 ignorées, ligne « 1 2 »
  de l'aide retirée ; données et code « avant » conservés. **Chapitres masqués** : `"masque": true` dans `data/chapitres.json` (memoire, evolution), filtrés par
  `chapitres.js` qui renumérote (`numero` affiché, `numeroFichier` d'origine) ; fiches.js lit `app.chapitres.liste` (fiches d'un chapitre masqué dans « Autres fiches »).
- Avancement des lots d'améliorations : `AVANCEMENT.md` (dossier de travail, hors atlas) et LISEZMOI § 10.

## Ajouter un outil

1. Module `js/mon-outil.js` exportant `creerMonOutil(app)` avec `construirePanneau(conteneur)` ; l'importer et
   le créer dans `demarrer()` (`js/app.js`).
2. Le déclarer : `I.ajouterOutil({ id, groupe, libelle, titre, raccourci?, masqueEnBorne?, horsBorne?, construire })`.
   `groupe` est l'onglet : `site`, `topographie`, `psmv`, `fond`, `batiments`, `climat` (libellé Ambiance), `coupes`, `vues` ou `export` (défaut `site`). Les outils du bâti
   vont dans `batiments` (avec `horsBorne: true` : l'onglet n'existe pas en mode borne). L'ordre des appels donne l'ordre
   des boutons dans l'onglet.
3. Icône : entrée `ICONES[id]` dans `js/interface.js` (SVG 24 × 24, trait 1,5).
4. Raccourci : branche du `keydown` de `js/interface.js` (`basculer(id)`), et ligne de l'aide par
   `ajouterLigneAide(apres, touche, texte)` dans `js/app.js` (comme la ligne W).
5. Nouveau groupe : l'ajouter à `GROUPES` (`js/interface.js`), sans autre changement.
6. Mettre à jour `LISEZMOI.md` (§ 2 et § 9) et ce fichier.

## Modules (js/)

app (démarrage, panneaux Couches, Relief, PSMV, Fond) · hauteurs (hauteurs corrigées par bâtiment) · interface (outils, clavier, clics) · maquette (bâti fusionné, couleurs par
sommet, voirie, arbres) · couches (bâti disparu, parcelles, POI) · toits (toitures détaillées : Hôtel de Ville, îlot Saint-Vincent) · temps (époques, désactivables) · decoupe (vue maquette coupée) · elements (éléments affichés) · vue (3D/plan) ·
calques (fonds au sol IGN/OSM/Google, plans à caler) · cadastre (parcelles, PSMV, couleurs du bâti) ·
topo (relief : MNT Nantes Métropole, RGE ALTI, courbes, profils) · relief (maquette drapée sur le terrain) · meteo (lecture de data/meteo/meteo.json, ou d'un EPW) · epw (lecteur et adaptateur EPW) · meteo-source (sélecteur Source météo) · climat · soleil (ombres, grille de hauteurs) ·
confort (ouverture au ciel, rayonnement sol/façades, température ressentie) · chaleur, chaleur-modele, chaleur-points (matériaux, albédo, température de surface estimée, points chauds) · vent (outil W, onglet Climat : rose cliquable 12 secteurs
par saison/température et vent moyen/fort, tableau des saisons, graphique mensuel, direction + boussole + flèche sur la maquette, vues rapides
via `app.vue.basculer` / `allerVers`, particules, confort au vent avec/sans projet par `app.projet.definirVisible(v)` (calque Projet, émet `bati`),
phénomènes ; styles `css/vent.css` ajoutés par le module ; grilles gardées en cache par signature du bâti ; calcul 2D sans Three.js
dans vent-calcul.js, repère x est / y nord, y = -z) · bruit (cartes de bruit) ·
reseaux (OSM + réseaux souterrains open data + Open Data Nantes) · trajets (IGN, OSRM FOSSGIS, OpenRouteService, Navitia, isochrones) ·
coupes (coupes linéaires et zones, poché, dessin 2D SVG/DXF) · vues (points de vue, axonométrie, focale, nom proposé, réglages des outils) · vues-rapides (liste sous la barre Soleil) · legende (légende automatique) · roses-saisons (4 roses des saisons) · planche (planche à l'échelle PDF / SVG) · pdf (PDF minimal) · pieton (observateur, vue piéton) · parcours (parcours de caméra, vidéo WebM) · flux · fiches · chapitres · etiquettes · releve (dessin, calage) · centre · bati (opaque/transparent/
masqué, photo sur les toits, liens Google Earth) · projet (onglet Bâtiments : démolitions, volumes ajoutés,
bâti effectif) · imports (modèles GLB/glTF/OBJ du projet) · export (PNG, GLB, OBJ texturé en ZIP, DXF R12, CSV météo, liens EPW et CSV horaire) · donnees (services externes) ·
preparer (page de préparation hors ligne).

## Données (data/)

`config.json`, `chapitres.json`, `fiches.json`, `projet.json` (projet de l'onglet Bâtiments), `hauteurs.json` (hauteurs corrigées, outil Hauteurs), `coupes.json` (outil Coupes), `vues.json` et `parcours.json` (onglet Vues), `psmv/` (73 fiches extraites du PDF, photos, planches),
`documents/` (PDF du PSMV), `calques/` (plans à caler), `topographie/` (CSV du MNT de Nantes Métropole),
`ign/altimetrie.json` (grille RGE ALTI de 8 m sur ±704 m), `meteo/meteo.json` et `meteo/meteo_horaire.json` (source météo unique ; `meteo/extremes.json` jours extrêmes ; `meteo/*.epw` et
`meteo/meteofrance_44020001_horaire.csv` facultatifs, proposés dans Export ; l'EPW de Nantes sert aussi de source météo au choix), `toits/hotel-de-ville.json` (toitures de la mairie : BD TOPO,
BD ORTHO et LiDAR HD de l'IGN, Licence Ouverte 2.0), `facades/hotel-de-ville.json` et `facades/hotel-de-ville/*.jpg` (photos de façade
de la mairie, rue de la Commune, rue de Strasbourg et pavillons de la cour d'honneur : Panoramax immergis Licence Ouverte 2.0, Koreller CC BY-SA 4.0, PSMV), `toits/ilot-saint-vincent.json`,
`facades/ilot-saint-vincent.json` et `facades/ilot-saint-vincent/*.jpg` (îlot Saint-Vincent, 27 rue de Strasbourg), idem `ilot-commune-saint-vincent` (1-5 rue de la Commune, 9-11 rue Saint-Vincent) et `ilot-fanny-peccot` (9-11 rue du Général-Leclerc, 1-3 rue Saint-Vincent, 3 rue Fanny Peccot), `toits/hotel-de-charette.json`, `toits/moulin-23-27.json`, `toits/fenelon-flechier.json` (parcelles EO 26, 195, 49 et 162 ; `facades/hotel-de-charette.json` et `facades/hotel-de-charette/*.jpg` : façade sur cour de l'hôtel de Charette, Panoramax immergis), `chaleur/` (outil Chaleur : materiaux, toitures, ortho, journees, corrections), `bruit.geojson` (DDTM 44, 2022), `fantomes.geojson` et `arbres.geojson` (vides : à dessiner avec Relevé).
`config.json > rayonPlateau` = 45 (plateau de 90 m, maquette de 45 cm au 1/200 : `maquette { diametreCm: 45, echelle: 200 }`), confirmé par l'utilisateur le 23/10/2026. Un réglage Centre dans localStorage `atlas-hdv-centre` (maquette) le remplace : outil Centre > « Revenir au centre de config.json ».
`osm/`, `cadastre/`, fonds IGN : produits par `preparer.html` pour la borne hors ligne.

## Points ouverts

- Services en ligne testés en réel le 30/09/2026 (curl + Chrome, CORS compris) : IGN (itinéraire, isochrones,
  altimétrie, BD TOPO, WMTS, API Carto cadastre), Open Data Nantes (catalogue,
  exports GeoJSON, MNT, parkings), OSRM FOSSGIS : conformes. Corrigés : catalogue WMTS (grilles nommées
  `PM_6_15`…), recherche Open Data (`select=metas` refusé), Overpass (miroir maps.mail.ru ajouté, délai de 120 s).
  Restent à tester avec une vraie clé : OpenRouteService, Navitia, Google Map Tiles (CORS vérifié pour les deux premiers).
- « Parcelles 63 et 51 » du programme : hypothèse cadastrale EY 63 / EO 51 à faire confirmer.
- Le bâti d'avant 1943 est à dessiner sur un plan ancien calé (les anciens exemples étaient fictifs).
- Carte du bruit : seules les cartes de l'État (DDTM 44, WFS Géo-IDE, GML Lambert-93) sont ouvertes ; celle de
  l'agglomération (rues communales) n'est pas publiée par Nantes Métropole : import GeoJSON prévu.
- Rayons : `rayonPlateau` (cercle de la maquette), `rayonEtude` (périmètre), `rayonConfort` (analyses), réglables
  dans l'outil Centre (localStorage `atlas-hdv-centre`, puis config.json).
- Relief 3D : `js/relief.js` drape toute la scène sur la grille de `topo` (subdivision des surfaces plates, bâtiments
  soulevés d'un bloc via `app.empreintes`, balayage des nouvelles couches toutes les 400 ms). Un objet qui gère
  lui-même sa hauteur porte `userData.pasDeRelief` et utilise `app.relief.dz(x, z)` (bus, étiquettes).
- Enregistrement : `enregistrerDonnees(chemin relatif à data/, contenu)` (js/donnees.js) → POST
  `/__enregistrer/data/…` de serveur.py (sauvegarde dans data/.sauvegardes/), sinon téléchargement.
- Modèles simplifiés (confort, rayonnement, chaleur) : ordres de grandeur, pas une norme. Chaleur : ±5 °C au mieux, toits horizontaux, arbres opaques (12 % de lumière), pas d'arrosage ni de chaleur anthropique ; matériaux du sol surtout « enrobé » faute de tags OSM (corriger au clic) ; toitures « zinc » parfois des ardoises claires au soleil (orthophoto).
- Onglet Vues : vue piéton sans gravité ni escaliers (l'œil suit `app.relief.dz`), collisions sur les emprises seulement (pas les arbres, ni le mobilier, ni les toits) ; vidéo WebM sans
  étiquettes ni panneaux (DOM hors canevas), cadence liée au rendu (une machine lente ralentit la lecture et la vidéo) ; vignettes des vues en JPEG dans `vues.json` (≈ 10 ko chacune).
- Messages d'erreur de `js/topo.js` et `js/relief.js` (grille absente) : disent encore « Couches > Relief » au lieu de l'onglet Topographie.
- Toitures de la mairie (`data/toits/hotel-de-ville.json`) : relevé du 13/10/2026 à 1 ou 2 m près, matériaux supposés
  d'après la photo (BD TOPO muette), étages estimés (BD TOPO : 1), noms historiques des corps non vérifiés ; dessin de
  coupe 2D encore en rectangle jusqu'au faîtage pour ces bâtiments.
- Liens externes (`config.json > liens`) : adresse et coordonnées non revérifiées par la Base Adresse Nationale
  (réseau indisponible lors de l'écriture) ; liens centrés sur `origine` (47.218385, -1.55452).
- Emprises réelles des toitures de la mairie découpées dans OSM (Overpass du 13/10/2026) : si l'atlas lit le bâti BD TOPO,
  les corps gardent ces emprises (écarts de l'ordre du mètre avec la BD TOPO).
- Photos de façade de la mairie : 10 façades (rue de la Commune, rue de Strasbourg, pavillons de la cour d'honneur) ; rue Garde-Dieu (aucune
  vue Panoramax), rue Saint-Léonard (mur de clôture et arbres) et fond de la cour d'honneur (vu à travers la grille) restent en teinte. Les JPEG de `data/facades/hotel-de-ville/` ne peuvent pas être écrits par l'outil Dropbox
  (texte seulement) : à déposer à la main ; sans eux, la maquette reste en teinte et le panneau Bâti le signale.
  Idem pour `data/facades/ilot-saint-vincent/` (3 JPEG), `data/facades/ilot-commune-saint-vincent/` (4 JPEG), `data/facades/ilot-fanny-peccot/` (6 JPEG)
  et `data/facades/hotel-de-charette/` (1 JPEG : façade sur cour vue de la rue du Moulin ; rue Bossuet et façade nord en teinte).
- Îlot Saint-Vincent : façade ouest (rue Saint-Vincent) sans photo ; courette laissée vide (le LiDAR y voit une couverture
  vers 25 m) ; lucarnes non modelées ; la photo sud donne une corniche à 20 m (18,4 m retenus, image tassée de 10 %).
- Îlot rue de la Commune – rue Saint-Vincent : communs sur cour à 9 m (estimé) ; photos PSMV 2013 obliques ; 11 rue Saint-Vincent sans photo.
- Îlot rue Fanny Peccot – rue Saint-Vincent : 11 b, résidence (cour à 4 m fixée) et 11 a de confiance faible (écart LiDAR > 1,2 m) ;
  photos PSMV des rues Saint-Vincent et Fanny Peccot très obliques ; 11 b, angles coupés et cours sans photo.
- Parcelles EO 26, 195, 49, 162 : emprises OSM décalées de 1 à 2 m du LiDAR, égouts fixés à la main, 5 corps de confiance faible ;
  étages PSMV / BD TOPO contradictoires (EO 195, EO 49) ; tuiles de la BD TOPO démenties par l'orthophoto (EO 26, EO 49).

## Vérifications avant de livrer

- `node --check` sur chaque fichier de `js/` (avec un `package.json` `{"type":"module"}` temporaire), JSON valides.
- Tester dans Chrome via `python serveur.py`, console sans erreur ; Ctrl+Maj+R après une mise à jour.
