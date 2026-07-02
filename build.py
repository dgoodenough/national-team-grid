#!/usr/bin/env python3
"""
Build the National Team Matchup Grid data artifacts.

Pipeline:
  1. Download (and cache) the source data:
       - martj42/international_results        -> men's match results + former_names
       - martj42/womens-international-results  -> women's match results
       - cnc8/fifa-world-ranking               -> confederation + men's FIFA rank snapshot
  2. Build the canonical "current FIFA member" table (name, code, confederation, rank)
     from the latest ranking snapshot, reconciling ranking names to match-data names.
  3. Normalise every match team name (former-name folding + aliases) so it resolves to a
     canonical member; anything left over is tagged defunct/other.
  4. Aggregate, for each unordered pair of members, the total meetings + first/last year,
     separately for the men's and women's archives.
  5. Emit compact JSON into docs/data/ for the static frontend:
       members.json, matrix_men.json, matrix_women.json, defunct.json

Run:  python build.py
"""
from __future__ import annotations

import csv
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
REF = ROOT / "data"
OUT = ROOT / "docs" / "data"

# --- Sources -----------------------------------------------------------------
# Match data + former names: martj42 (updated regularly — re-run with --refresh for newer
# matches). Confederation + membership: cnc8 snapshot (confederation is stable). Current FIFA
# ranking (both genders): FotMob, which mirrors the official ranking and, unlike FIFA's own
# gated API, is directly fetchable. cnc8's men's rank is kept only as an offline fallback.
SOURCES = {
    "results_men.csv":
        "https://raw.githubusercontent.com/martj42/international_results/master/results.csv",
    "former_names.csv":
        "https://raw.githubusercontent.com/martj42/international_results/master/former_names.csv",
    "results_women.csv":
        "https://raw.githubusercontent.com/martj42/womens-international-results/master/results.csv",
    "fifa_ranking_men.csv":
        "https://raw.githubusercontent.com/cnc8/fifa-world-ranking/master/fifa_ranking-2020-12-10.csv",
    "fotmob_men_ranking.json":
        "https://www.fotmob.com/api/data/fifarankings/ranking?gender=men",
    "fotmob_women_ranking.json":
        "https://www.fotmob.com/api/data/fifarankings/ranking?gender=women",
    "fotmob_men_period.json":
        "https://www.fotmob.com/api/data/fifarankings/period?gender=men",
    "fotmob_women_period.json":
        "https://www.fotmob.com/api/data/fifarankings/period?gender=women",
}

CONFED_ORDER = ["AFC", "CAF", "CONCACAF", "CONMEBOL", "OFC", "UEFA"]

# Ranking-snapshot team name  ->  canonical match-data team name.
# (Only the names that don't already match the martj42 spelling verbatim.)
RANKING_ALIASES = {
    "Brunei Darussalam": "Brunei",
    "Cabo Verde": "Cape Verde",
    "China PR": "China",
    "Chinese Taipei": "Taiwan",
    "Congo DR": "DR Congo",
    "Côte d'Ivoire": "Ivory Coast",
    "IR Iran": "Iran",
    "Korea DPR": "North Korea",
    "Korea Republic": "South Korea",
    "Kyrgyz Republic": "Kyrgyzstan",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Lucia": "Saint Lucia",
    "St. Vincent / Grenadines": "Saint Vincent and the Grenadines",
    "Swaziland": "Eswatini",
    "US Virgin Islands": "United States Virgin Islands",
    "USA": "United States",
}

# Duplicate / variant spellings within the match data that should collapse to one team.
MATCH_NAME_FIXUPS = {
    "U.S. Virgin Islands": "United States Virgin Islands",
}

# FotMob ranking team name -> canonical member name (only the ones that differ).
FOTMOB_ALIASES = {
    "USA": "United States",
    "UAE": "United Arab Emirates",
    "Turkiye": "Turkey",
    "Czechia": "Czech Republic",
    "Ireland": "Republic of Ireland",
    "Chinese Taipei": "Taiwan",
    "Curacao": "Curaçao",
    "Macao": "Macau",
    "Sao Tome and Principe": "São Tomé and Príncipe",
    "Central African Rep.": "Central African Republic",
    "Saint Vincent and The Grenadines": "Saint Vincent and the Grenadines",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "U.S. Virgin Islands": "United States Virgin Islands",
}

# --- ESPN fixtures (supplementary source for upcoming games) -----------------
# ESPN's public scoreboard API (no key) lists scheduled internationals further out than
# martj42 does — including women's competitions. Senior national-team competitions only.
ESPN_SLUGS_MEN = [
    "fifa.world", "fifa.worldq.uefa", "fifa.worldq.conmebol", "fifa.worldq.concacaf",
    "fifa.worldq.afc", "fifa.worldq.caf", "fifa.worldq.ofc", "fifa.wcq.ply",
    "fifa.friendly", "fifa.confederations_cup",
    "uefa.euro", "uefa.euroq", "uefa.nations",
    "conmebol.america", "concacaf.gold", "concacaf.gold_qual", "concacaf.nations.league",
    "caf.nations", "caf.nations_qual", "afc.asian.cup", "afc.cupq",
]
ESPN_SLUGS_WOMEN = [
    "fifa.wwc", "fifa.wwcq.ply", "fifa.wworldq.uefa", "fifa.friendly.w", "fifa.shebelieves",
    "uefa.weuro", "uefa.w.nations", "concacaf.womens.championship", "concacaf.w.gold",
    "conmebol.america.femenina", "caf.w.nations", "afc.w.asian.cup", "global.w.finalissima",
]
# How far ahead to look. ESPN caps the window per request, so we fetch in ~120-day chunks;
# 2 years is plenty to catch far-out tournaments without hammering the API.
ESPN_HORIZON_DAYS = 730
ESPN_CHUNK_DAYS = 120

# ESPN displayName -> canonical member name (only the ones that differ).
ESPN_ALIASES = {
    "USA": "United States",
    "Congo DR": "DR Congo",
    "Bosnia-Herzegovina": "Bosnia and Herzegovina",
    "Czechia": "Czech Republic",
    "Türkiye": "Turkey",
    "Turkiye": "Turkey",
    "Ireland": "Republic of Ireland",
    "Cabo Verde": "Cape Verde",
    "Côte d'Ivoire": "Ivory Coast",
    "Chinese Taipei": "Taiwan",
    "Curacao": "Curaçao",
    "Macao": "Macau",
    "Sao Tome and Principe": "São Tomé and Príncipe",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Lucia": "Saint Lucia",
    "St. Vincent and the Grenadines": "Saint Vincent and the Grenadines",
    "U.S. Virgin Islands": "United States Virgin Islands",
    "South Korea": "South Korea",
    "North Korea": "North Korea",
    "China PR": "China",
    "IR Iran": "Iran",
    "Korea Republic": "South Korea",
    "Korea DPR": "North Korea",
}

# Curated defunct national teams (no single current successor) for the advanced layer,
# with the confederation their grid block should sit in. Names are exactly as spelled in
# the martj42 match data. (USSR is omitted: martj42 folds it into Russia; Netherlands
# Antilles and Dutch East Indies fold into Curaçao / Indonesia via former_names.)
DEFUNCT_CONFED = {
    "Yugoslavia": "UEFA",              # SFR Yugoslavia; FR Yugoslavia + Serbia & Montenegro
                                       # fold into Serbia via former_names, so are not listed here
    "Czechoslovakia": "UEFA",
    "German DR": "UEFA",               # East Germany
    "Saarland": "UEFA",
    "Vietnam Republic": "AFC",         # South Vietnam
    "North Vietnam": "AFC",
    "Yemen DPR": "AFC",                # South Yemen (state)
    "South Yemen": "AFC",
}


# --- Helpers -----------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def download_sources(force: bool = False) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for fname, url in SOURCES.items():
        dest = RAW / fname
        if dest.exists() and not force:
            log(f"  cached  {fname}")
            continue
        log(f"  fetch   {fname}  <-  {url}")
        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        req = urllib.request.Request(url, headers={"User-Agent": ua})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                dest.write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            # FotMob rankings are best-effort (load_ranking falls back to last-known/cnc8);
            # for anything else keep a cached copy if we have one, else fail hard.
            if fname.startswith("fotmob"):
                log(f"  WARN: {fname} fetch failed ({e}); falling back")
            elif dest.exists():
                log(f"  WARN: {fname} fetch failed ({e}); using cached copy")
            else:
                raise


def read_csv(path: Path, encoding: str = "utf-8") -> list[dict]:
    with open(path, encoding=encoding, newline="") as f:
        return list(csv.DictReader(f))


def year_of(datestr: str) -> int | None:
    try:
        return int(datestr[:4])
    except (ValueError, TypeError):
        return None


def latest_match_date(results_file: str) -> str:
    """Most recent match date (ISO strings sort lexically)."""
    return max((row["date"] for row in read_csv(RAW / results_file)), default="")


# --- ESPN upcoming fixtures ---------------------------------------------------
def fetch_espn_fixtures(gender: str) -> dict[tuple[str, str], tuple[str, str]]:
    """Scheduled internationals from ESPN's public scoreboard, {(nameA, nameB): (date, comp)}.
    Names are ESPN displayNames run through ESPN_ALIASES (not yet validated against members).
    Entirely best-effort: any slug/chunk failure is skipped so the build never breaks on ESPN."""
    slugs = ESPN_SLUGS_MEN if gender == "men" else ESPN_SLUGS_WOMEN
    ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
    today = date.today()
    chunks = []
    start = today
    while (start - today).days < ESPN_HORIZON_DAYS:
        end = start + timedelta(days=ESPN_CHUNK_DAYS)
        chunks.append((start.strftime("%Y%m%d"), end.strftime("%Y%m%d")))
        start = end + timedelta(days=1)

    out: dict[tuple[str, str], tuple[str, str]] = {}
    fails = 0
    for slug in slugs:
        for a, b in chunks:
            url = (f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}"
                   f"/scoreboard?dates={a}-{b}")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": ua})
                data = json.loads(urllib.request.urlopen(req, timeout=30).read())
            except Exception:  # noqa: BLE001
                fails += 1
                continue
            comp_name = ((data.get("leagues") or [{}])[0].get("name")
                         or slug).strip()
            for ev in data.get("events", []):
                dt = ev.get("date", "")[:10]
                if not dt or dt < today.isoformat():
                    continue                     # only future fixtures from ESPN
                try:
                    teams = ev["competitions"][0]["competitors"]
                    names = [t["team"]["displayName"].strip() for t in teams]
                except (KeyError, IndexError, TypeError):
                    continue
                if len(names) != 2:
                    continue
                na, nb = (ESPN_ALIASES.get(n, n) for n in names)
                key = tuple(sorted((na, nb)))
                if key not in out or dt < out[key][0]:   # keep the earliest meeting
                    out[key] = (dt, comp_name)
    log(f"  ESPN {gender}: {len(out)} scheduled fixtures "
        f"({len(slugs)} comps x {len(chunks)} windows, {fails} skipped requests)")
    return out


# --- Step 2: canonical member table ------------------------------------------
def load_ranking(gender: str) -> tuple[dict[str, int], str | None]:
    """Return (canonical_name -> rank, source label). Priority: a hand-maintained
    data/ranking_<gender>.csv override, else the cached current FotMob ranking."""
    override = REF / f"ranking_{gender}.csv"
    if override.exists():
        ranks = {r["name"].strip(): int(r["rank"]) for r in read_csv(override)}
        return ranks, f"data/ranking_{gender}.csv ({len(ranks)} teams)"

    fm = RAW / f"fotmob_{gender}_ranking.json"
    if fm.exists():
        try:
            data = json.loads(fm.read_text(encoding="utf-8"))
            ranks = {FOTMOB_ALIASES.get(row["name"], row["name"]): int(row["rank"])
                     for row in data}
            label = ""
            per = RAW / f"fotmob_{gender}_period.json"
            if per.exists():
                p = json.loads(per.read_text(encoding="utf-8"))
                if p:
                    label = " " + p[0].get("periodName", "")
            return ranks, f"FotMob/FIFA {gender}'s ranking{label} ({len(ranks)} teams)"
        except Exception as e:  # noqa: BLE001
            log(f"  WARN: could not parse FotMob {gender} ranking ({e})")

    # FotMob unavailable (e.g. blocked in CI): keep the last-known ranks from the previously
    # built members.json so an auto-refresh never silently downgrades the ordering.
    prev = OUT / "members.json"
    if prev.exists():
        try:
            data = json.loads(prev.read_text(encoding="utf-8"))
            key = "mens_rank" if gender == "men" else "womens_rank"
            ranks = {m["name"]: m[key] for m in data.get("members", []) if m.get(key)}
            if ranks:
                return ranks, f"last build's ranking ({len(ranks)} teams)"
        except Exception:  # noqa: BLE001
            pass
    return {}, None


def build_members() -> tuple[list[dict], dict[str, int], dict]:
    """Return (members, name->id map, metadata)."""
    rows = read_csv(RAW / "fifa_ranking_men.csv", encoding="utf-8")
    snapshot = max(r["rank_date"] for r in rows)
    snap_rows = [r for r in rows if r["rank_date"] == snapshot]

    members: list[dict] = []
    for r in snap_rows:
        raw_name = r["country_full"].strip()
        name = RANKING_ALIASES.get(raw_name, raw_name)
        members.append({
            "name": name,
            "code": r["country_abrv"].strip(),
            "confed": r["confederation"].strip(),
            "mens_rank": int(r["rank"]),
            "womens_rank": None,   # drop-in: data/ranking_women.csv (name,rank)
            "defunct": False,
        })

    # Current FIFA members missing from the (stale) ranking snapshot, e.g. teams that were
    # unranked on the snapshot date. Added with a null rank so they sort last in-confederation.
    extra_path = REF / "members_extra.csv"
    if extra_path.exists():
        have = {m["name"] for m in members}
        added = 0
        for row in read_csv(extra_path):
            if row["name"].strip() in have:
                continue
            members.append({
                "name": row["name"].strip(), "code": row["code"].strip(),
                "confed": row["confed"].strip(), "mens_rank": None,
                "womens_rank": None, "defunct": False,
            })
            added += 1
        log(f"  members_extra.csv: +{added} member(s) absent from the ranking snapshot")

    # Overlay current FIFA rankings (men's + women's). The cnc8 men's rank set above is the
    # offline fallback; FotMob (or a drop-in CSV) supplies the current numbers.
    men_rank, men_src = load_ranking("men")
    wom_rank, wom_src = load_ranking("women")
    member_names = {m["name"] for m in members}
    for m in members:
        if m["name"] in men_rank:
            m["mens_rank"] = men_rank[m["name"]]
        m["womens_rank"] = wom_rank.get(m["name"])
    log(f"  men's ranking:    {men_src or 'cnc8 snapshot (fallback)'}")
    log(f"  women's ranking:  {wom_src or 'NONE -> women ordered alphabetically in-confed'}")
    for g, rk in (("men", men_rank), ("women", wom_rank)):
        miss = sorted(set(rk) - member_names)
        if miss:
            log(f"  note: {len(miss)} {g}'s ranking names matched no member "
                f"(ignored): {miss[:8]}{' …' if len(miss) > 8 else ''}")

    # Stable default ordering: confederation, then men's rank (unranked last), then name.
    members.sort(key=lambda m: (CONFED_ORDER.index(m["confed"]),
                                m["mens_rank"] if m["mens_rank"] is not None else 10**9,
                                m["name"]))
    for i, m in enumerate(members):
        m["id"] = i

    name_to_id = {m["name"]: m["id"] for m in members}
    meta = {"confed_snapshot": snapshot, "ranking_men": men_src, "ranking_women": wom_src}
    return members, name_to_id, meta


# --- Step 3 + 4: normalise names and aggregate pairs -------------------------
def build_name_resolver(name_to_id: dict[str, int]) -> dict[str, str]:
    """match-data team name -> canonical member name (or itself if not a member)."""
    resolver: dict[str, str] = {}
    # former -> current (martj42 already uses current names, applied for safety)
    for row in read_csv(RAW / "former_names.csv"):
        resolver[row["former"].strip()] = row["current"].strip()
    resolver.update(MATCH_NAME_FIXUPS)
    return resolver


def canonical(name: str, resolver: dict[str, str]) -> str:
    name = name.strip()
    seen = set()
    while name in resolver and name not in seen:
        seen.add(name)
        name = resolver[name]
    return name


def aggregate(results_file: str, resolver: dict[str, str], name_to_id: dict[str, int],
              defunct_ids: dict[str, int]):
    """Aggregate pairwise meetings.
    Returns (member_pairs, defunct_pairs, unmatched, details, tournaments, upcoming).
    `details[(lo, hi)]` is a per-meeting list of [year, goals_lo, goals_hi, tournament_idx]
    (goals from the perspective of the lower-id team); `tournaments` is the interning table;
    `upcoming[(lo, hi)]` is (date, tournament) for a scheduled-but-unplayed member fixture."""
    member_pairs: dict[tuple[int, int], list] = {}
    defunct_pairs: dict[tuple[int, int], list] = {}
    unmatched: dict[str, int] = {}
    details: dict[tuple[int, int], list] = {}
    upcoming: dict[tuple[int, int], tuple] = {}
    tournaments: list[str] = []
    tindex: dict[str, int] = {}

    def t_idx(name: str) -> int:
        if name not in tindex:
            tindex[name] = len(tournaments)
            tournaments.append(name)
        return tindex[name]

    for row in read_csv(RAW / results_file):
        ht = canonical(row["home_team"], resolver)
        at = canonical(row["away_team"], resolver)
        yr = year_of(row["date"])

        def resolve(team):
            if team in name_to_id:
                return name_to_id[team], False
            if team in defunct_ids:
                return defunct_ids[team], True
            unmatched[team] = unmatched.get(team, 0) + 1
            return None, None

        ia, da = resolve(ht)
        ib, db = resolve(at)
        if ia is None or ib is None or ia == ib:
            continue

        # A meeting only counts once it's actually been played. martj42 lists some fixtures in
        # advance (e.g. upcoming World Cup matches) with no score yet; skip those so a scheduled
        # game never lights up the grid as "played". Counting and detail use this same gate, so
        # the grid/tooltip count can never disagree with the click-through match list.
        try:
            hs, as_ = int(row["home_score"]), int(row["away_score"])
        except (ValueError, TypeError):
            if not (da or db):                       # scheduled member-vs-member fixture
                k = (min(ia, ib), max(ia, ib))
                upcoming.setdefault(k, (row["date"], row["tournament"].strip()))
            continue

        key = (min(ia, ib), max(ia, ib))
        bucket = defunct_pairs if (da or db) else member_pairs
        cell = bucket.get(key)
        if cell is None:
            bucket[key] = [1, yr, yr]
        else:
            cell[0] += 1
            if yr is not None:
                cell[1] = yr if cell[1] is None else min(cell[1], yr)
                cell[2] = yr if cell[2] is None else max(cell[2], yr)

        # Per-meeting detail (goals from the lower-id team's perspective).
        g_lo, g_hi = (hs, as_) if ia <= ib else (as_, hs)
        details.setdefault(key, []).append([yr, g_lo, g_hi, t_idx(row["tournament"].strip())])

    return member_pairs, defunct_pairs, unmatched, details, tournaments, upcoming


def pairs_to_json(pairs: dict[tuple[int, int], list]) -> tuple[list, int]:
    out = [[i, j, c, fy, ly] for (i, j), (c, fy, ly) in sorted(pairs.items())]
    max_count = max((p[2] for p in out), default=0)
    return out, max_count


# --- Main --------------------------------------------------------------------
def main() -> int:
    log("[1/5] Downloading sources...")
    download_sources(force="--refresh" in sys.argv)

    log("[2/5] Building canonical member table...")
    members, name_to_id, rmeta = build_members()
    log(f"  {len(members)} current FIFA members")

    log("[3/5] Resolving defunct teams present in match data...")
    resolver = build_name_resolver(name_to_id)
    # Assign defunct ids in a separate high range so they never collide with members.
    defunct_present = []
    for name in DEFUNCT_CONFED:
        defunct_present.append(name)
    defunct_ids = {name: 100000 + i for i, name in enumerate(defunct_present)}

    log("[4/5] Aggregating pairwise meetings...")
    men_pairs, men_def, men_unmatched, men_details, men_tourn, men_up = aggregate(
        "results_men.csv", resolver, name_to_id, defunct_ids)
    wom_pairs, wom_def, wom_unmatched, wom_details, wom_tourn, wom_up = aggregate(
        "results_women.csv", resolver, name_to_id, defunct_ids)

    men_json, men_max = pairs_to_json(men_pairs)
    wom_json, wom_max = pairs_to_json(wom_pairs)

    # Defunct members actually referenced in either archive.
    used_def = {i for k in (men_def | wom_def) for i in k if i >= 100000}
    id_to_defname = {v: k for k, v in defunct_ids.items()}
    defunct_members = [
        {"id": did, "name": id_to_defname[did], "code": "",
         "confed": DEFUNCT_CONFED[id_to_defname[did]],
         "mens_rank": None, "womens_rank": None, "defunct": True}
        for did in sorted(used_def)
    ]
    men_def_json, _ = pairs_to_json(men_def)
    wom_def_json, _ = pairs_to_json(wom_def)

    log("[5/5] Writing JSON artifacts...")
    OUT.mkdir(parents=True, exist_ok=True)
    generated = datetime.now().strftime("%Y-%m-%d")
    data_through = {"men": latest_match_date("results_men.csv"),
                    "women": latest_match_date("results_women.csv")}

    (OUT / "members.json").write_text(json.dumps({
        "generated": generated,
        "confederation_order": CONFED_ORDER,
        "ranking_men": rmeta["ranking_men"],
        "ranking_women": rmeta["ranking_women"],
        "confed_snapshot": rmeta["confed_snapshot"],
        "data_through": data_through,
        "members": members,
    }, ensure_ascii=False), encoding="utf-8")

    (OUT / "matrix_men.json").write_text(json.dumps({
        "metric": "matches", "max_count": men_max, "pairs": men_json,
    }, ensure_ascii=False), encoding="utf-8")

    (OUT / "matrix_women.json").write_text(json.dumps({
        "metric": "matches", "max_count": wom_max, "pairs": wom_json,
    }, ensure_ascii=False), encoding="utf-8")

    (OUT / "defunct.json").write_text(json.dumps({
        "members": defunct_members,
        "pairs_men": men_def_json,
        "pairs_women": wom_def_json,
    }, ensure_ascii=False), encoding="utf-8")

    # Per-meeting detail, lazy-loaded by the frontend only when a cell is first clicked.
    def write_matches(gender: str, details: dict, tournaments: list) -> int:
        ykey = lambda m: (m[0] is None, m[0] if m[0] is not None else 0)   # null years last
        pairs = {f"{lo},{hi}": sorted(v, key=ykey) for (lo, hi), v in details.items()}
        (OUT / f"matches_{gender}.json").write_text(json.dumps({
            "tournaments": tournaments, "pairs": pairs,
        }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return sum(len(v) for v in details.values())
    n_men = write_matches("men", men_details, men_tourn)
    n_wom = write_matches("women", wom_details, wom_tourn)

    # Upcoming FIFAGami: scheduled fixtures between members who have NEVER met, from
    # martj42's own advance listings merged with ESPN's scoreboard (which lists games much
    # further out, incl. women's). We emit every such fixture (with its date) and let the
    # client filter by the browser's current date, so the highlight stays accurate between
    # rebuilds. Sorted soonest-first.
    def merge_espn(upcoming: dict, gender: str) -> tuple[dict, int, list]:
        espn = fetch_espn_fixtures(gender)
        added, unknown = 0, []
        for (na, nb), (dt, comp) in espn.items():
            ia, ib = name_to_id.get(na), name_to_id.get(nb)
            if ia is None or ib is None:
                unknown.extend(n for n, i in ((na, ia), (nb, ib)) if i is None)
                continue
            key = (min(ia, ib), max(ia, ib))
            if key not in upcoming or dt < upcoming[key][0]:
                if key not in upcoming:
                    added += 1
                upcoming[key] = (dt, comp)
        return upcoming, added, sorted(set(unknown))

    men_up, men_added, men_unk = merge_espn(men_up, "men")
    wom_up, wom_added, wom_unk = merge_espn(wom_up, "women")
    log(f"  ESPN merge: +{men_added} men's, +{wom_added} women's fixtures beyond martj42")
    for g, unk in (("men", men_unk), ("women", wom_unk)):
        if unk:
            log(f"  note: ESPN {g} names not matching a member (ignored): "
                f"{unk[:8]}{' …' if len(unk) > 8 else ''}")

    def upcoming_gami(upcoming: dict, played: dict) -> list:
        out = [[lo, hi, d, t] for (lo, hi), (d, t) in upcoming.items() if (lo, hi) not in played]
        return sorted(out, key=lambda r: r[2])
    upcoming_json = {"men": upcoming_gami(men_up, men_pairs),
                     "women": upcoming_gami(wom_up, wom_pairs)}
    (OUT / "upcoming.json").write_text(json.dumps(upcoming_json, ensure_ascii=False),
                                       encoding="utf-8")

    # --- Report ---
    log("")
    log(f"  members:          {len(members)}")
    log(f"  men's pairs:      {len(men_json):>6}  (max meetings {men_max})")
    log(f"  women's pairs:    {len(wom_json):>6}  (max meetings {wom_max})")
    log(f"  defunct members:  {len(defunct_members)}  -> {[m['name'] for m in defunct_members]}")
    log(f"  match data through:  men {data_through['men']}  |  women {data_through['women']}")
    log(f"  ranking (men):    {rmeta['ranking_men']}")
    log(f"  ranking (women):  {rmeta['ranking_women']}")
    mm_kb = (OUT / "matches_men.json").stat().st_size / 1024
    mw_kb = (OUT / "matches_women.json").stat().st_size / 1024
    log(f"  match detail (lazy-loaded on click): "
        f"men {n_men} meetings / {mm_kb:.0f} KB, women {n_wom} / {mw_kb:.0f} KB")
    id_to_name = {m["id"]: m["name"] for m in members}
    log(f"  upcoming FIFAGami (scheduled first meetings): "
        f"men {len(upcoming_json['men'])}, women {len(upcoming_json['women'])}")
    for lo, hi, d, t in upcoming_json["men"][:12]:
        log(f"      {d}  {id_to_name[lo]} – {id_to_name[hi]}  ({t})")

    # Sanity asserts
    assert len(members) >= 200, "expected ~210 current members"
    assert men_max >= 100, "England-Scotland etc. should exceed 100 meetings"
    id_to_name = {m["id"]: m["name"] for m in members}
    top = max(men_json, key=lambda p: p[2])
    log(f"  most-played men's pair: {id_to_name[top[0]]} - {id_to_name[top[1]]} "
        f"({top[2]} meetings, {top[3]}-{top[4]})")

    # Unmatched (non-member, non-curated-defunct) teams — top 25 by appearances.
    merged_unmatched: dict[str, int] = {}
    for d in (men_unmatched, wom_unmatched):
        for k, v in d.items():
            merged_unmatched[k] = merged_unmatched.get(k, 0) + v
    log("")
    log(f"  unmatched teams (excluded as non-FIFA / other): {len(merged_unmatched)}")
    for name, cnt in sorted(merged_unmatched.items(), key=lambda x: -x[1])[:25]:
        log(f"      {cnt:>5}  {name}")

    log("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
