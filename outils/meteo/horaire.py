"""Météo horaire moyenne utilisée par l'outil Confort -> meteo_horaire.json (à côté de meteo.json).

Usage : python horaire.py meteofrance_44020001_horaire.csv meteo_horaire.json

Pour chaque mois et chaque heure locale (Europe/Paris) des années 2016 à 2025 : température (ta, °C),
humidité (hr, %), vent moyen à 10 m (v, m/s), rayonnement global (ghi, W/m², moyenne de l'heure écoulée,
d'après GLO en J/cm²), et sa décomposition en direct normal (dni) et diffus (dhi) par le modèle d'Erbs
(1982), la station ne mesurant que le global. Plus « chaudJuillet15h » : moyenne des 10 % d'heures de
juillet à 15 h les plus chaudes.
"""
import sys, json
import numpy as np
import pandas as pd

csv, sortie = sys.argv[1:3]
A0, A1 = 2016, 2025
LAT, LON = 47.15, -1.608333

df = pd.read_csv(csv, dtype={"AAAAMMJJHH": str})
t = pd.to_datetime(df["AAAAMMJJHH"], format="%Y%m%d%H").dt.tz_localize("UTC")
df = df[(t.dt.year >= A0) & (t.dt.year <= A1)].copy()
t = t[df.index]

# bornes du contrôle qualité d'analyse.py
for c, (lo, hi) in {"T": (-20, 45), "U": (1, 100), "FF": (0, 45), "GLO": (0, 4000)}.items():
    df.loc[(df[c] < lo) | (df[c] > hi), c] = np.nan

# position du soleil au milieu de l'heure écoulée (formules de la NOAA)
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

ghi = df["GLO"].values * 10000 / 3600  # J/cm² sur l'heure -> W/m² moyens
i0 = 1367 * (1 + 0.033 * np.cos(2 * np.pi * doy / 365)) * np.clip(cosz, 0, None)
with np.errstate(divide="ignore", invalid="ignore"):
    kt = np.where(i0 > 10, ghi / i0, 0)
kt = np.clip(kt, 0, 1)
kd = np.where(kt <= 0.22, 1 - 0.09 * kt,
              np.where(kt <= 0.8, 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4, 0.165))
dhi = np.where(cosz > 0.065, kd * ghi, ghi)  # soleil très bas : tout en diffus
with np.errstate(divide="ignore", invalid="ignore"):
    dni = np.where(cosz > 0.065, (ghi - dhi) / cosz, 0)
dni = np.clip(np.nan_to_num(dni), 0, 1100)
dni = np.where(np.isnan(ghi), np.nan, dni)

loc = t.dt.tz_convert("Europe/Paris")
h = pd.DataFrame({"m": loc.dt.month.values - 1, "hh": loc.dt.hour.values, "ta": df["T"].values, "hr": df["U"].values,
                  "v": df["FF"].values, "ghi": ghi, "dni": dni, "dhi": dhi})
h = h.dropna()
CH = ["ta", "hr", "v", "ghi", "dni", "dhi"]
moy = h.groupby(["m", "hh"])[CH].mean()
nb = h.groupby(["m", "hh"]).size()
moyennes = [[{**{k: round(float(moy.loc[(m, hh), k]), 1) for k in CH}, "n": int(nb.loc[(m, hh)])} for hh in range(24)] for m in range(12)]
j = h[(h.m == 6) & (h.hh == 15)].sort_values("ta", ascending=False)
top = j.head(max(1, round(len(j) / 10)))
chaud = {k: round(float(top[k].mean()), 1) for k in CH}
chaud["n"] = int(len(top))

d = {
    "source": "Météo-France, station 44020001 Nantes-Bouguenais, données horaires (Licence Ouverte Etalab 2.0)",
    "def": "moyennes[mois 0-11][heure locale 0-23] = {ta °C, hr %, v m/s à 10 m, ghi, dni, dhi W/m² (moyenne de l'heure écoulée), n heures}",
    "periode": f"{A0}-01-01/{A1}-12-31",
    "heure": "Europe/Paris",
    "rayonnement": "global mesuré (GLO), direct et diffus estimés par le modèle d'Erbs (1982)",
    "moyennes": moyennes,
    "chaudJuillet15h": chaud,
}
with open(sortie, "w", encoding="utf-8") as fh:
    json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))
print(len(h), "heures ;", "juillet 15 h :", moyennes[6][15], "; chaud :", chaud)
