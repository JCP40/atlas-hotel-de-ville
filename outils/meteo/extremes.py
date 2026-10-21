"""Jours extrêmes et périodes chaudes / froides (outil Climat de l'atlas).

Usage : python extremes.py meteofrance_44020001_horaire.csv extremes.json

Entrée : mesures horaires Météo-France de la station 44020001 (filtre.py), heures AAAAMMJJHH en UTC.
Sortie : data/meteo/extremes.json, lu par js/climat.js.
Journée civile de Nantes (Europe/Paris) ; une journée compte si au moins 20 heures de température sont valides.
Tmin = minimum de TN (sinon T), Tmax = maximum de TX (sinon T), Tmoy = moyenne horaire de T.
"""
import json
import sys

import pandas as pd

A0, A1 = 2016, 2025  # années complètes, comme analyse.py
N_EXTREMES = 10


def jour(d):
    return d.strftime('%Y-%m-%d')


def main(csv, sortie):
    df = pd.read_csv(csv, dtype={'AAAAMMJJHH': str}, usecols=['AAAAMMJJHH', 'T', 'TN', 'TX'])
    t = pd.to_datetime(df['AAAAMMJJHH'], format='%Y%m%d%H', utc=True).dt.tz_convert('Europe/Paris')
    df['jour'] = t.dt.tz_localize(None).dt.normalize()
    for c in ('T', 'TN', 'TX'):
        df[c] = pd.to_numeric(df[c], errors='coerce')
        df.loc[(df[c] < -25) | (df[c] > 45), c] = float('nan')
    df['TN'] = df['TN'].fillna(df['T'])
    df['TX'] = df['TX'].fillna(df['T'])
    g = df.groupby('jour').agg(n=('T', 'count'), tmin=('TN', 'min'), tmax=('TX', 'max'), tmoy=('T', 'mean'))
    g = g[(g.n >= 20) & (g.index.year >= A0) & (g.index.year <= A1)].copy()
    g['tmoy'] = g['tmoy'].round(1)

    def ligne(d, r):
        return {'date': jour(d), 'tmin': round(float(r.tmin), 1), 'tmax': round(float(r.tmax), 1), 'tmoy': float(r.tmoy)}

    froid = g.tmin.idxmin()
    chaud = g.tmax.idxmax()
    froid_moy = g.tmoy.idxmin()
    chaud_moy = g.tmoy.idxmax()
    p10, p90 = float(g.tmoy.quantile(0.1)), float(g.tmoy.quantile(0.9))

    # épisodes : plus longues suites de jours consécutifs dans le décile froid / chaud de la température moyenne
    def episodes(masque, nb=3):
        res, debut, prec = [], None, None
        for d, m in masque.items():
            if m and debut is not None and (d - prec).days == 1:
                prec = d
                continue
            if debut is not None:
                res.append((debut, prec))
            debut, prec = (d, d) if m else (None, None)
        if debut is not None:
            res.append((debut, prec))
        res.sort(key=lambda e: (e[1] - e[0]).days, reverse=True)
        return [{'debut': jour(a), 'fin': jour(b), 'jours': (b - a).days + 1,
                 'tmoy': round(float(g.loc[a:b].tmoy.mean()), 1)} for a, b in res[:nb]]

    # saison la plus froide / la plus chaude de l'année type : fenêtre glissante de 31 jours sur la moyenne
    # des températures moyennes de chaque jour de l'année (29 février ignoré)
    clim = g[~((g.index.month == 2) & (g.index.day == 29))].copy()
    clim['jj'] = clim.index.strftime('%m-%d')
    moy = clim.groupby('jj').tmoy.mean()
    ordre = sorted(moy.index, key=lambda s: pd.Timestamp(f'2023-{s}'))
    serie = pd.Series([moy[k] for k in ordre], index=ordre)
    double = pd.concat([serie, serie])
    gliss = double.rolling(31, center=True).mean().iloc[len(serie) // 2: len(serie) // 2 + len(serie)]
    gliss.index = [double.index[i] for i in range(len(serie) // 2, len(serie) // 2 + len(serie))]

    def fenetre(centre):
        i = ordre.index(centre)
        return {'debut': ordre[(i - 15) % len(ordre)], 'fin': ordre[(i + 15) % len(ordre)], 'centre': centre,
                'tmoy': round(float(gliss[centre]), 1)}

    # mois des jours du décile chaud / froid (part en %)
    def mois(masque):
        s = g[masque].index.month.value_counts(normalize=True).sort_index()
        return {int(k): round(float(v) * 100, 1) for k, v in s.items() if v >= 0.005}

    res = {
        'source': 'Météo-France, données climatologiques de base horaires, station 44020001 Nantes-Bouguenais, Licence Ouverte Etalab 2.0',
        'periode': f'{A0}-{A1}',
        'jours_valides': int(len(g)),
        'def': 'Journée civile (Europe/Paris), au moins 20 h de mesures ; Tmin = minimum de TN, Tmax = maximum de TX, Tmoy = moyenne horaire de T. '
               'Déciles sur la température moyenne journalière. Saison la plus froide / chaude : fenêtre glissante de 31 jours sur la moyenne interannuelle de chaque jour de l\'année.',
        'plus_froid': ligne(froid, g.loc[froid]),
        'plus_chaud': ligne(chaud, g.loc[chaud]),
        'plus_froid_moyenne': ligne(froid_moy, g.loc[froid_moy]),
        'plus_chaud_moyenne': ligne(chaud_moy, g.loc[chaud_moy]),
        'froids': [ligne(d, g.loc[d]) for d in g.tmin.nsmallest(N_EXTREMES).index],
        'chauds': [ligne(d, g.loc[d]) for d in g.tmax.nlargest(N_EXTREMES).index],
        'deciles': {
            'p10_tmoy': round(p10, 1), 'p90_tmoy': round(p90, 1),
            'mois_froids': mois(g.tmoy <= p10), 'mois_chauds': mois(g.tmoy >= p90),
            'episodes_froids': episodes(g.tmoy <= p10), 'episodes_chauds': episodes(g.tmoy >= p90),
        },
        'saison_froide': fenetre(gliss.idxmin()),
        'saison_chaude': fenetre(gliss.idxmax()),
    }
    with open(sortie, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: res[k] for k in ('plus_froid', 'plus_chaud', 'saison_froide', 'saison_chaude')}, ensure_ascii=False))
    print(res['deciles']['episodes_chauds'][:1], res['deciles']['episodes_froids'][:1])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
