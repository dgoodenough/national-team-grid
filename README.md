# National Team Matchup Grid

A Scorigami-inspired heatmap of international football. Every current FIFA member nation is a
row **and** a column of one massive grid; each cell is coloured by how many times those two
national teams have ever played each other. The point of the picture is the **negative space** —
the matchups that have *never* happened.

**▶ Live demo: https://dgoodenough.github.io/national-team-grid/**

![Matchup grid](docs/assets/hero.png)

Only **29% of all possible men's matchups** have ever been played — and only **13% of the women's**.
The rest of the grid is empty: pairs of countries that, in 150+ years of international football,
have simply never met.

## How to read it

- **Rows and columns** are national teams, **grouped by confederation** (AFC, CAF, CONCACAF,
  CONMEBOL, OFC, UEFA) and then ordered by FIFA ranking within each confederation. Teams in the
  same confederation play each other far more often, so the grid lights up in dense blocks down
  the diagonal, with sparse cross-confederation regions between them.
- **Cell colour** = number of times the pair has met (log-scaled, cool → hot). The most-played
  men's fixture is **Argentina–Uruguay (183 meetings since 1902)**.
- **Empty (near-black) cells** = the two teams have *never* played. Flip on **Highlight
  never-played** to invert the emphasis and make those cells glow.
- The **diagonal** is greyed out (a team can't play itself).

## Features

- **Zoom & pan** the full 211×211 grid (mouse wheel to zoom, drag to pan).
- **Men's ↔ Women's** toggle — two completely separate match archives.
- **Filter by confederation** — show one, several, or all.
- **Manual team checklist** — search and tick any set of teams to build a custom sub-grid
  (e.g. just the 2026 World Cup hosts, or your own rivalries).
- **Highlight never-played** mode for the full Scorigami effect.
- **Include defunct teams** (advanced) — adds historical sides with no single modern successor
  (Yugoslavia, Czechoslovakia, East Germany / German DR, the Saar, South Vietnam, South Yemen…).
- Live stats: how many of the possible matchups in the current view have ever happened.

## Data

| Dataset | Source | Used for |
| --- | --- | --- |
| Men's internationals (1872–present, ~49k matches) | [martj42/international_results](https://github.com/martj42/international_results) | match counts, first/last meeting |
| Women's internationals (1969–present, ~11k matches) | [martj42/womens-international-results](https://github.com/martj42/womens-international-results) | match counts, first/last meeting |
| Historical team renames | `former_names.csv` (martj42) | folding old names into current teams |
| FIFA ranking + confederation | [cnc8/fifa-world-ranking](https://github.com/cnc8/fifa-world-ranking) | confederation grouping + men's rank |

### Methodology notes

- **Current FIFA members only** (211 teams) in the default view. Membership and confederations are
  taken from the FIFA ranking snapshot, plus a tiny supplement (`data/members_extra.csv`) for any
  member unranked on the snapshot date (e.g. Cook Islands).
- **Name reconciliation.** The match data and ranking data spell some teams differently
  (`Côte d'Ivoire`↔`Ivory Coast`, `Korea Republic`↔`South Korea`, `China PR`↔`China`,
  `USA`↔`United States`, …). `build.py` reconciles them, and `former_names.csv` folds historical
  names into their modern team (`Zaïre`→`DR Congo`, `Upper Volta`→`Burkina Faso`; USSR→Russia and
  Serbia & Montenegro→Serbia, per the source's lineage). Any team that resolves to neither a
  current member nor a curated defunct side (mostly non-FIFA territories like Martinique or Jersey)
  is excluded, and the build prints a full report of them.
- **Ranking freshness.** The bundled FIFA ranking is a fixed, reproducible snapshot
  (men's, Dec 2020 — the last complete public scrape before FIFA gated its ranking API). Because
  confederation is the *primary* sort and rank is only the tiebreak *within* a confederation, this
  affects ordering inside blocks, not which teams exist or where they sit. To use fresher data,
  drop a replacement into `data/` (see below) — no code changes needed.
- **Women's ranking.** No complete, free women's ranking is bundled, so women's teams are ordered
  alphabetically within each confederation. Provide `data/ranking_women.csv` (`name,rank`) and the
  build will use it.

## Build it yourself

`build.py` uses only the Python standard library (no dependencies).

```bash
python build.py            # download sources, reconcile, aggregate, write docs/data/*.json
python build.py --refresh  # force re-download of the source CSVs
```

It downloads the source CSVs into `data/raw/` (gitignored), then writes the artifacts the site
loads:

- `docs/data/members.json` — ordered members with confederation + ranks
- `docs/data/matrix_men.json`, `matrix_women.json` — sparse `[i, j, meetings, firstYear, lastYear]`
- `docs/data/defunct.json` — the advanced defunct-teams layer

Then serve the static site from `docs/`:

```bash
python -m http.server -d docs 8000   # open http://localhost:8000
```

## Tech

Pure static site — vanilla JavaScript + HTML5 Canvas, no build step and no runtime dependencies.
The ~44,000-cell grid is drawn directly to a canvas with view-culling for smooth zoom/pan. Hosted
on GitHub Pages straight from `docs/`.

## Credits

Match data © the [martj42](https://github.com/martj42) datasets; FIFA ranking data via
[cnc8/fifa-world-ranking](https://github.com/cnc8/fifa-world-ranking). Concept inspired by
[Scorigami](https://nflscorigami.com) (Jon Bois). Code under the [MIT License](LICENSE).
