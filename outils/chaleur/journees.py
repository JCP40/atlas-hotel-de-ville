"""Journées types pour l'outil Chaleur -> data/chaleur/journees.json.

Usage : python3 -I journees.py meteofrance_44020001_horaire.csv journees.json

Profils horaires (heure locale Europe/Paris, 0 à 23 h) de température (ta), humidité (hr), vent à 10 m (v),
rayonnement global (ghi) et sa décomposition direct normal / diffus (dni, dhi, modèle d'Erbs, comme horaire.py) :
- « chaude » : moyenne heure par heure des journées de juin à août 2016-2025 dont le maximum dépasse 30 °C ;
- « record » : journée la plus chaude mesurée (maximum de T), 2016-2025.
"""
import sys, json
import numpy as np
import pandas as pd

csv, sortie = sys.argv[1:3]
LAT, LON = 47.15, -1.608333
df = pd.read_csv(csv, dtype={"AAAAMMJJHH": str})
t = pd.to_datetime(df["AAAAMMJJHH"], format="%Y%m%d%H").dt.tz_localize("UTC")
df = df[(t.dt.year >= 2016) & (t.dt.year <= 2025)].copy()
t = t[df.index]
for c, (lo, hi) in {"T": (-20, 45), "U": (1, 100), "FF": (0, 45), "GLO": (0, 4000)}.items():
    df.loc[(df[c] < lo) | (df[c] > hi), c] = np.nan

tm = t - pd.Timedelta(minutes=30)
doy = tm.dt.dayofyear.values
hdec = tm.dt.hour.values + tm.dt.minute.values / 60
g = 2 * np.pi / 365 * (doy - 1 + (hdec - 12) / 24)
decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
        + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g) - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
ha = np.radians((hdec * 60 + eqt + 4 * LON) / 4 - 180)
phi = np.radians(LAT)
cosz = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
ghi = df["GLO"].values * 10000 / 3600
i0 = 1367 * (1 + 0.033 * np.cos(2 * np.pi * doy / 365)) * np.clip(cosz, 0, None)
with np.errstate(divide="ignore", invalid="ignore"):
    kt = np.clip(np.where(i0 > 10, ghi / i0, 0), 0, 1)
kd = np.where(kt <= 0.22, 1 - 0.09 * kt, np.where(kt <= 0.8, 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4, 0.165))
dhi = np.where(cosz > 0.065, kd * ghi, ghi)
with np.errstate(divide="ignore", invalid="ignore"):
    dni = np.clip(np.nan_to_num(np.where(cosz > 0.065, (ghi - dhi) / cosz, 0)), 0, 1100)

loc = t.dt.tz_convert("Europe/Paris")
h = pd.DataFrame({"jour": loc.dt.strftime("%Y-%m-%d").values, "m": loc.dt.month.values, "hh": loc.dt.hour.values,
                  "ta": df["T"].values, "hr": df["U"].values, "v": df["FF"].values, "ghi": ghi, "dni": dni, "dhi": dhi})
CH = ["ta", "hr", "v", "ghi", "dni", "dhi"]
tx = h.groupby("jour")["ta"].max()
nb = h.groupby("jour")["ta"].count()
valides = nb[nb >= 20].index
ete = h[h.m.isin([6, 7, 8])]
chauds = [j for j in tx[tx >= 30].index if j in set(valides) and j in set(ete.jour)]
prof = h[h.jour.isin(chauds)].groupby("hh")[CH].mean()
record = tx[valides].idxmax()
pr = h[h.jour == record].groupby("hh")[CH].mean()

def liste(p):
    return [{k: round(float(p.loc[hh, k]), 1) for k in CH} if hh in p.index else None for hh in range(24)]

d = {
    "source": "Météo-France, station 44020001 Nantes-Bouguenais, données horaires 2016-2025 (Licence Ouverte Etalab 2.0)",
    "def": "profils[cle].heures[heure locale 0-23] = {ta °C, hr %, v m/s à 10 m, ghi, dni, dhi W/m² (heure écoulée ; direct et diffus : modèle d'Erbs)}",
    "profils": {
        "chaude": {"libelle": f"Journée chaude type (moyenne des {len(chauds)} jours d'été à 30 °C ou plus, 2016-2025)", "date": "06-21", "n": len(chauds), "heures": liste(prof)},
        "record": {"libelle": f"Jour le plus chaud mesuré ({record[8:10]}/{record[5:7]}/{record[:4]}, {tx[record]:.1f} °C)".replace(".", ","), "date": record[5:], "jourMesure": record, "heures": liste(pr)},
    },
}
json.dump(d, open(sortie, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(chauds), "jours chauds ; record", record, tx[record], "; 15 h chaude :", d["profils"]["chaude"]["heures"][15], "; record 15 h :", d["profils"]["record"]["heures"][15])
