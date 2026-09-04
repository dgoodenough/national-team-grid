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
       members.json, matrix_men.json, matrix_women.json, defunct.json,
       matches_*.json (per-meeting detail), years_*.json (slim per-pair meeting years),
       upcoming.json - plus docs/feed.json + docs/feed.xml (the FIFAGami fixture feed).
  6. Validate the artifacts before anything is written where anyone will see it.

Run:  python build.py             # build from cached sources (downloads what is missing)
      python build.py --refresh   # force re-download of every source
      python build.py --derive    # regenerate only the derived artifacts (years, feed,
                                  # flags) from docs/data - no network, seconds not minutes
"""
from __future__ import annotations

import csv
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

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

# Canonical public URL - absolute links in the syndication feeds and share cards.
SITE_URL = "https://dgoodenough.github.io/national-team-grid/"

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


def load_flags() -> dict[str, str]:
    """FIFA/IOC three-letter code -> flag emoji, from data/iso2.csv.

    Most flags are the two regional-indicator letters for the country's ISO 3166-1
    alpha-2 code. The three UK home nations with RGI tag sequences carry them verbatim
    in the `emoji` column; Kosovo and Northern Ireland have no emoji flag at all and
    map to "" (the frontend falls back to the three-letter code)."""
    path = REF / "iso2.csv"
    if not path.exists():
        log("  WARN: data/iso2.csv missing - team flags will be omitted")
        return {}
    with open(path, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(line for line in f if not line.startswith("#")))
    flags = {}
    for r in rows:
        code = (r.get("code") or "").strip()
        iso2 = (r.get("iso2") or "").strip()
        emoji = (r.get("emoji") or "").strip()
        if not code:
            continue
        if emoji:
            flags[code] = emoji
        elif len(iso2) == 2 and iso2.isalpha():
            # regional indicator symbols: 'A' (U+0041) -> U+1F1E6
            flags[code] = "".join(chr(0x1F1E6 + ord(ch.upper()) - ord("A")) for ch in iso2)
        else:
            flags[code] = ""
    return flags


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
    # ESPN's edge now 403s browser-like User-Agents (bot detection on fake "Mozilla" strings);
    # a plain curl UA passes. If they ever block this too, every request will 403 and the
    # all-requests-failed guard below will surface it instead of silently emptying the list.
    ua = "curl/8.4.0"
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
    total_reqs = len(slugs) * len(chunks)
    log(f"  ESPN {gender}: {len(out)} scheduled fixtures "
        f"({len(slugs)} comps x {len(chunks)} windows, {fails} skipped requests)")
    if fails == total_reqs and total_reqs:
        log(f"  WARNING: ESPN {gender} — ALL {total_reqs} requests failed; the ESPN feed is "
            f"down or blocking us (upcoming FIFAGami will rely on martj42 alone).")
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

    # Flag emoji per team (blank where no emoji flag exists, e.g. Kosovo, Northern Ireland).
    flags = load_flags()
    unflagged = [m["name"] for m in members if not flags.get(m["code"])]
    for m in members:
        m["flag"] = flags.get(m["code"], "")
    if unflagged:
        log(f"  flags: {len(members) - len(unflagged)}/{len(members)} teams have one "
            f"(no emoji flag for: {', '.join(unflagged)})")

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


# --- Derived artifacts: slim meeting-years, syndication feed -----------------
def years_payload(pair_years: dict[str, list[int]],
                  undated: dict[str, int] | None = None) -> dict:
    """Delta-encode each pair's meeting years: [firstYear, d1, d2, ...], every d >= 0.

    The frontend needs one thing from the match archive to drive the timeline scrubber -
    "how many times had these two met by year Y" - which is a prefix count over this list.
    Shipping just the years, delta-encoded, is a fraction of the size of matches_*.json,
    so the scrubber no longer blocks on a multi-hundred-KB download. `undated` carries the
    handful of meetings whose source row has no parseable date, so the client can say
    "+N undated" rather than silently disagreeing with the matrix total."""
    pairs = {}
    for key, ys in pair_years.items():
        ys = sorted(y for y in ys if y is not None)
        if not ys:
            continue
        enc = [ys[0]]
        enc.extend(b - a for a, b in zip(ys, ys[1:]))
        pairs[key] = enc
    return {"encoding": "delta", "pairs": pairs,
            "undated": {k: v for k, v in (undated or {}).items() if v}}


def write_years(gender: str, details: dict[tuple[int, int], list]) -> int:
    """docs/data/years_<gender>.json from the per-meeting detail."""
    pair_years, undated = {}, {}
    for (lo, hi), meetings in details.items():
        key = f"{lo},{hi}"
        pair_years[key] = [m[0] for m in meetings if m[0] is not None]
        n_undated = sum(1 for m in meetings if m[0] is None)
        if n_undated:
            undated[key] = n_undated
    payload = years_payload(pair_years, undated)
    (OUT / f"years_{gender}.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return sum(len(v) for v in payload["pairs"].values())


def build_feed_items(members: list[dict], upcoming: dict, today: str,
                     limit: int = 60) -> list[dict]:
    """Upcoming FIFAGami as feed items: pairs of nations that have never met, with a
    fixture on the calendar. Soonest first, past fixtures dropped."""
    by_id = {m["id"]: m for m in members}
    items = []
    for gender in ("men", "women"):
        for row in upcoming.get(gender, []):
            lo, hi, when, comp = row[0], row[1], row[2], row[3]
            a, b = by_id.get(lo), by_id.get(hi)
            if not a or not b or when < today:
                continue
            label = "men's" if gender == "men" else "women's"
            link = f"{SITE_URL}?view=fixtures&g={gender}&up=1&pair={lo},{hi}"
            items.append({
                "guid": f"fifagami-{gender}-{lo}-{hi}-{when}",
                "gender": gender,
                "date": when,
                "competition": comp,
                "title": f"{a['name']} v {b['name']} - first ever {label} meeting",
                "url": link,
                "text": (f"{a['name']} and {b['name']} have never played a {label} "
                         f"international against each other. They are scheduled to meet "
                         f"for the first time on {when} ({comp})."),
            })
    items.sort(key=lambda it: (it["date"], it["title"]))
    return items[:limit]


def write_feeds(members: list[dict], upcoming: dict, generated: str) -> int:
    """docs/feed.json (JSON Feed 1.1) + docs/feed.xml (RSS 2.0).

    Every item is a fixture between two nations that have never met. `guid` is stable per
    pair+date, so a reader shows an entry once, when the fixture first appears on the
    calendar - which is exactly the thing worth being notified about. Publication date is
    the build date (when this entry was published); the kick-off date is in the title."""
    docs = ROOT / "docs"
    items = build_feed_items(members, upcoming, date.today().isoformat())
    title = "FIFAGami - first-ever international meetings"
    desc = ("Scheduled fixtures between national teams that have never played each other, "
            "from the National Team Matchup Grid.")
    pub = f"{generated}T00:00:00Z"

    docs.joinpath("feed.json").write_text(json.dumps({
        "version": "https://jsonfeed.org/version/1.1",
        "title": title,
        "home_page_url": SITE_URL,
        "feed_url": SITE_URL + "feed.json",
        "description": desc,
        "items": [{
            "id": it["guid"],
            "url": it["url"],
            "title": it["title"],
            "content_text": it["text"],
            "date_published": pub,
            "tags": [it["gender"], it["competition"]],
        } for it in items],
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    rss_items = "".join(
        "    <item>\n"
        f"      <title>{xml_escape(it['title'])}</title>\n"
        f"      <link>{xml_escape(it['url'])}</link>\n"
        f"      <guid isPermaLink=\"false\">{xml_escape(it['guid'])}</guid>\n"
        f"      <pubDate>{rfc822(generated)}</pubDate>\n"
        f"      <category>{xml_escape(it['competition'])}</category>\n"
        f"      <description>{xml_escape(it['text'])}</description>\n"
        "    </item>\n" for it in items)
    docs.joinpath("feed.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
        "  <channel>\n"
        f"    <title>{xml_escape(title)}</title>\n"
        f"    <link>{xml_escape(SITE_URL)}</link>\n"
        f"    <description>{xml_escape(desc)}</description>\n"
        "    <language>en</language>\n"
        f'    <atom:link href="{xml_escape(SITE_URL)}feed.xml" rel="self" '
        'type="application/rss+xml"/>\n'
        f"    <lastBuildDate>{rfc822(generated)}</lastBuildDate>\n"
        f"{rss_items}"
        "  </channel>\n"
        "</rss>\n", encoding="utf-8")
    return len(items)


def rfc822(iso_day: str) -> str:
    """YYYY-MM-DD -> RFC 822 date, which is what RSS pubDate wants."""
    d = datetime.strptime(iso_day, "%Y-%m-%d")
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return (f"{days[d.weekday()]}, {d.day:02d} {months[d.month - 1]} {d.year} "
            f"00:00:00 +0000")


# --- Validation --------------------------------------------------------------
class BuildError(AssertionError):
    """An artifact is wrong enough that it must not be published."""


def validate_artifacts(out: Path = OUT, docs: Path | None = None) -> list[str]:
    """Check the built artifacts hang together. Raises BuildError on anything that would
    ship a broken or misleading site; returns a list of non-fatal notes.

    This runs at the end of every build AND in tests/test_build.py, so the daily
    auto-refresh cannot quietly commit a site built from a source that changed shape."""
    docs = docs or out.parent
    notes: list[str] = []

    def need(cond, msg):
        if not cond:
            raise BuildError(msg)

    def load(path: Path):
        need(path.exists(), f"{path.name} is missing")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise BuildError(f"{path.name} is not valid JSON: {e}") from e

    members_doc = load(out / "members.json")
    members = members_doc.get("members", [])
    need(len(members) >= 200, f"expected ~211 current members, got {len(members)}")
    need([m["id"] for m in members] == list(range(len(members))),
         "member ids must be contiguous 0..n-1 in file order")
    need(len({m["name"] for m in members}) == len(members), "duplicate member names")
    for key in ("confederation_order", "data_through", "generated"):
        need(members_doc.get(key), f"members.json is missing {key}")
    confeds = set(members_doc["confederation_order"])
    bad_confed = sorted({m["confed"] for m in members} - confeds)
    need(not bad_confed, f"members with an unknown confederation: {bad_confed}")
    for g in ("men", "women"):
        through = members_doc["data_through"].get(g, "")
        need(len(through) == 10 and through[4] == "-",
             f"data_through.{g} should be an ISO date, got {through!r}")
    flagged = sum(1 for m in members if m.get("flag"))
    need(flagged >= len(members) - 5,
         f"only {flagged}/{len(members)} members carry a flag - check data/iso2.csv")

    defunct = load(out / "defunct.json")
    ids = {m["id"] for m in members} | {m["id"] for m in defunct.get("members", [])}

    for g in ("men", "women"):
        matrix = load(out / f"matrix_{g}.json")
        need(matrix["pairs"], f"matrix_{g}.json has no pairs")
        need(matrix["max_count"] == max(p[2] for p in matrix["pairs"]),
             f"matrix_{g}.json max_count disagrees with its pairs")
        # The match detail spans both layers, so pair-level checks do too: current members
        # live in matrix_<g>.json, teams with no modern successor in defunct.json.
        pairs = matrix["pairs"] + defunct.get(f"pairs_{g}", [])
        seen = set()
        for i, j, c, fy, ly in pairs:
            need(i in ids and j in ids, f"matrix_{g}: pair ({i},{j}) references an unknown team")
            need(i < j, f"matrix_{g}: pair ({i},{j}) is not stored low-id-first")
            need((i, j) not in seen, f"matrix_{g}: duplicate pair ({i},{j})")
            seen.add((i, j))
            need(c >= 1, f"matrix_{g}: pair ({i},{j}) has a non-positive count")
            need(fy is None or ly is None or fy <= ly,
                 f"matrix_{g}: pair ({i},{j}) has firstYear after lastYear")

        counts = {f"{i},{j}": c for i, j, c, _, _ in pairs}
        firsts = {f"{i},{j}": fy for i, j, _, fy, _ in pairs}
        years = load(out / f"years_{g}.json")
        need(years.get("encoding") == "delta", f"years_{g}.json is not delta-encoded")
        undated = years.get("undated", {})
        for key, enc in years["pairs"].items():
            need(key in counts, f"years_{g}: pair {key} is absent from the matrix")
            need(all(d >= 0 for d in enc[1:]), f"years_{g}: pair {key} has a negative delta")
            need(len(enc) + undated.get(key, 0) == counts[key],
                 f"years_{g}: pair {key} has {len(enc)} dated + "
                 f"{undated.get(key, 0)} undated meetings, matrix says {counts[key]}")
            need(enc[0] == firsts[key],
                 f"years_{g}: pair {key} starts at {enc[0]}, matrix firstYear is {firsts[key]}")
        missing_years = set(counts) - set(years["pairs"]) - set(undated)
        need(not missing_years,
             f"years_{g}: {len(missing_years)} played pairs have no meeting years")

        matches = load(out / f"matches_{g}.json")
        need(set(matches["pairs"]) == set(counts),
             f"matches_{g}.json and matrix_{g}.json cover different pairs")
        n_t = len(matches["tournaments"])
        for key, lst in matches["pairs"].items():
            need(len(lst) == counts[key], f"matches_{g}: pair {key} has the wrong meeting count")
            for _yr, _a, _b, ti in lst:
                need(0 <= ti < n_t, f"matches_{g}: pair {key} has a bad tournament index")

        played = {f"{i},{j}" for i, j, _, _, _ in matrix["pairs"]}
        upcoming = load(out / "upcoming.json")
        for lo, hi, when, _comp in upcoming.get(g, []):
            need(lo in ids and hi in ids, f"upcoming {g}: ({lo},{hi}) references an unknown team")
            need(f"{lo},{hi}" not in played,
                 f"upcoming {g}: ({lo},{hi}) is listed as a first meeting but has already met")
            need(len(when) == 10, f"upcoming {g}: ({lo},{hi}) has a malformed date {when!r}")
        if not upcoming.get(g):
            notes.append(f"upcoming.json has no {g}'s fixtures - ESPN/martj42 may be down")

    feed = load(docs / "feed.json")
    need(feed.get("version", "").startswith("https://jsonfeed.org/"),
         "feed.json is not a JSON Feed")
    need(len({it["id"] for it in feed["items"]}) == len(feed["items"]),
         "feed.json has duplicate item ids")
    rss = (docs / "feed.xml")
    need(rss.exists(), "feed.xml is missing")
    head = rss.read_text(encoding="utf-8")[:64]
    need(head.startswith("<?xml"), "feed.xml does not start with an XML declaration")
    return notes


# --- Derived-only rebuild (no network) ---------------------------------------
def derive_only() -> int:
    """Regenerate just the artifacts that are pure functions of what is already in
    docs/data: the flag column on members.json, years_*.json, and the feeds. Useful for
    iterating on the frontend (or on this file) without re-downloading ~60 MB of sources."""
    log("[derive] Regenerating derived artifacts from docs/data (no network)...")
    members_doc = json.loads((OUT / "members.json").read_text(encoding="utf-8"))
    flags = load_flags()
    for m in members_doc["members"]:
        m["flag"] = flags.get(m["code"], "")
    (OUT / "members.json").write_text(
        json.dumps(members_doc, ensure_ascii=False), encoding="utf-8")
    log(f"  members.json: flags for "
        f"{sum(1 for m in members_doc['members'] if m['flag'])} teams")

    for g in ("men", "women"):
        matches = json.loads((OUT / f"matches_{g}.json").read_text(encoding="utf-8"))
        details = {tuple(int(x) for x in k.split(",")): v for k, v in matches["pairs"].items()}
        n = write_years(g, details)
        kb = (OUT / f"years_{g}.json").stat().st_size / 1024
        mkb = (OUT / f"matches_{g}.json").stat().st_size / 1024
        log(f"  years_{g}.json: {n} dated meetings, {kb:.0f} KB "
            f"(vs {mkb:.0f} KB for the full match detail)")

    upcoming = json.loads((OUT / "upcoming.json").read_text(encoding="utf-8"))
    generated = members_doc.get("generated") or date.today().isoformat()
    n_feed = write_feeds(members_doc["members"], upcoming, generated)
    log(f"  feed.json + feed.xml: {n_feed} upcoming first-ever meetings")

    for note in validate_artifacts():
        log(f"  note: {note}")
    log("\nDerived artifacts OK.")
    return 0


# --- Main --------------------------------------------------------------------
def main() -> int:
    if "--derive" in sys.argv:
        return derive_only()

    log("[1/6] Downloading sources...")
    download_sources(force="--refresh" in sys.argv)

    log("[2/6] Building canonical member table...")
    members, name_to_id, rmeta = build_members()
    log(f"  {len(members)} current FIFA members")

    log("[3/6] Resolving defunct teams present in match data...")
    resolver = build_name_resolver(name_to_id)
    # Assign defunct ids in a separate high range so they never collide with members.
    defunct_present = []
    for name in DEFUNCT_CONFED:
        defunct_present.append(name)
    defunct_ids = {name: 100000 + i for i, name in enumerate(defunct_present)}

    log("[4/6] Aggregating pairwise meetings...")
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

    log("[5/6] Writing JSON artifacts...")
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

    # Slim per-pair meeting years. The timeline scrubber needs only "how many by year Y",
    # so it loads this instead of the full match detail.
    y_men = write_years("men", men_details)
    y_wom = write_years("women", wom_details)

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

    # Syndication: the same upcoming first-ever meetings as a JSON Feed + RSS, so the
    # project can notify rather than wait to be visited.
    n_feed = write_feeds(members, upcoming_json, generated)

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
    ym_kb = (OUT / "years_men.json").stat().st_size / 1024
    yw_kb = (OUT / "years_women.json").stat().st_size / 1024
    log(f"  match detail (lazy-loaded on click): "
        f"men {n_men} meetings / {mm_kb:.0f} KB, women {n_wom} / {mw_kb:.0f} KB")
    log(f"  meeting years (lazy-loaded for the scrubber): "
        f"men {y_men} / {ym_kb:.0f} KB, women {y_wom} / {yw_kb:.0f} KB")
    log(f"  feed.json + feed.xml: {n_feed} upcoming first-ever meetings")
    id_to_name = {m["id"]: m["name"] for m in members}
    log(f"  upcoming FIFAGami (scheduled first meetings): "
        f"men {len(upcoming_json['men'])}, women {len(upcoming_json['women'])}")
    for lo, hi, d, t in upcoming_json["men"][:12]:
        log(f"      {d}  {id_to_name[lo]} – {id_to_name[hi]}  ({t})")

    # Validation. Anything that would publish a broken or misleading site raises here,
    # before the caller (the daily refresh workflow) gets a chance to commit it.
    if men_max < 100:
        raise BuildError(f"most-played men's pair has only {men_max} meetings - "
                         "Argentina-Uruguay et al should exceed 100; the source looks wrong")
    for note in validate_artifacts():
        log(f"  note: {note}")
    log("  validation: artifacts OK")
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
