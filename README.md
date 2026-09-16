# FIFAGami

Morocco have never played Mexico. Spain have never played Senegal. Japan have never played
Portugal. Dozens of pairs of top-40 national teams have never met at all.

**Fewer than a third of the 22,155 possible men's international fixtures have been played**,
and fewer than one in six of the women's. Every pairing is one cell of this grid.

**▶ Live: https://dgoodenough.github.io/fifagami/**

![Every possible international fixture, split down the diagonal: the men's record above it, the women's below, played in grey and unplayed in red](docs/assets/hero.png)

Every current FIFA member is a row and a column. Each cell is a pairing. Red means those two
national teams have never played each other, in 150 years of trying. The grid is creased down
its diagonal: the men's record above it, the women's below.

## How to read it

**Rows and columns** are national teams, grouped by confederation and ordered by FIFA ranking
within each one. Teams mostly play their neighbours, so the grid fills in along the diagonal
and empties out between the blocks.

**Red** is a pairing that has never happened. **Grey** is one that has, darker for more
meetings. Turn off *Never-played* and the grid colours by meetings instead, a green ramp from
a single match up to Argentina against Uruguay, the most-played fixture in the game,
first contested in 1902.

The diagonal is blacked out. A team cannot play itself. It is also the crease: the same two
teams appear once above it in the men's game and once below it in the women's.

## Five views

Every view obeys the same controls. The confederation filter, the ticked teams and the
timeline scrubber narrow all five. Filter to CONMEBOL, scrub to 1950, open *One-offs*, and you
have the South American pairs that had met exactly once by 1950. The fold belongs to the grid,
which is the only view with a sheet to fold; the four lists read both archives either way.

| View | What it shows |
| --- | --- |
| **Grid** | The 211×211 matrix. |
| **Fixtures** | Pairings that have never met and have a date on the calendar, with a countdown. Also published as a [feed](#syndication). |
| **One-offs** | Pairings played exactly once across both archives, oldest first. Egypt beat Lithuania 10–0 in 1924 and the two have not met since. |
| **Near misses** | Pairs that have never met, ranked by opponents they already share. Canada and Sweden have more than seventy in common and have never played. |
| **Connect** | Tonga has played a dozen countries at most, and still reaches every other national team on earth within three matches. |

## What it does

- **Zoom and pan** the full grid, on a mouse or a phone. Tap a cell to aim, tap again to open it.
- **Both games on one sheet.** Every pairing appears twice in a symmetric matrix, so half the
  grid was only ever a mirror of the other half. *Unfolded*, that half carries the second
  archive instead: the men's record above the diagonal, the women's below it, on one shared
  scale, so the paler half is genuinely the emptier one.
- **Fold it in half and the two land on each other.** *Folded* creases the square along its
  diagonal and brings the women's half down on the men's, pairing for pairing — one triangle,
  in which every cell answers for both games at once: met in both, in the men's only, in the
  women's only, or in neither. 4,023 pairings have been played by men and not women; 325 the
  other way. The switch is the fold itself, animated; `prefers-reduced-motion` skips it.
- **Click any cell** for every meeting between those two teams, with scores, tournaments and
  the head-to-head record.
- **Timeline scrubber.** Drag through the years and watch the grid fill in. Press ▶ and it
  plays 1872 to today.
- **Tick one team** for its full record, ranked most- to least-played. Tick several to build a
  sub-grid.
- **Upcoming first meetings** highlighted in yellow, from scheduled fixtures up to two years out.
- **Sort** by confederation then rank, by global rank, by total matches played, or alphabetically.
- **Include defunct teams**, for Yugoslavia, Czechoslovakia, East Germany, the Saar, South
  Vietnam and South Yemen.
- **Three kinds of empty, told apart.** Never met, had not happened yet at the scrubbed year,
  and never played anyone at all. Brunei, Montserrat, Oman, San Marino, Somalia and Yemen have
  never played a women's international.
- **Keyboard and screen-reader access.** Arrow keys walk the cells, Enter opens a head-to-head,
  and a live region reads out whatever the focus lands on.
- **Everything is in the URL,** so any view can be linked, bookmarked or captioned. *Copy link*
  puts the current one on the clipboard.
- **Light and dark**, following the OS preference.

## The data

| Dataset | Source |
| --- | --- |
| Men's internationals, 1872–present, ~49k matches | [martj42/international_results](https://github.com/martj42/international_results) |
| Women's internationals, 1969–present, ~12k matches | [martj42/womens-international-results](https://github.com/martj42/womens-international-results) |
| Historical team renames | `former_names.csv` (martj42) |
| Current FIFA ranking, men's and women's | [FotMob](https://www.fotmob.com/fifaranking/men), mirroring the official ranking |
| Scheduled internationals | ESPN public scoreboard API |
| Confederation membership | [cnc8/fifa-world-ranking](https://github.com/cnc8/fifa-world-ranking) |
| FIFA code to ISO 3166-1 | `data/iso2.csv` |

### Whether you can trust the numbers

**Current FIFA members only**, 211 teams, unless you switch on defunct sides.

**Names are reconciled across three sources.** They disagree: `Côte d'Ivoire` against
`Ivory Coast`, `Korea Republic` against `South Korea`, FotMob's `USA` and `Turkiye` and
`Czechia`. `build.py` resolves them, and `former_names.csv` folds historical names into the
modern team, so `Zaïre` counts as DR Congo and `Upper Volta` as Burkina Faso. USSR resolves to
Russia and Serbia & Montenegro to Serbia, following the source's lineage. Teams that are
neither a current member nor a curated defunct side, mostly non-FIFA territories like
Martinique and Jersey, are excluded, and the build prints all of them.

**Rankings are current and per-gender**, pulled at build time. The publication date is recorded
in `members.json` and shown in the app footer. About 14 members have never been given a women's
ranking and sort last within their confederation.

**The archives have a cut-off.** martj42 updates within a day or two of most internationals.
The current cut-off for each is in `members.json` as `data_through`, and in the app footer.

**What counts as "upcoming"** is decided by the browser's date, not the build's, so a fixture
that has since been played stops being advertised as a first meeting between data refreshes.

## Build it yourself

`build.py` uses only the standard library.

```bash
python build.py            # download, reconcile, aggregate, write docs/data/*.json
python build.py --refresh  # force re-download of every source
python build.py --derive   # regenerate derived artifacts only, no network
```

It writes the artifacts the site loads:

- `members.json` — ordered members with confederation, ranks, flag, data vintage
- `matrix_men.json`, `matrix_women.json` — sparse `[i, j, meetings, firstYear, lastYear]`
- `matches_men.json`, `matches_women.json` — per-pair detail, fetched only when a cell is clicked
- `years_men.json`, `years_women.json` — meeting years per pair, delta-encoded, for the scrubber
- `defunct.json` — the defunct-teams layer
- `upcoming.json` — scheduled first-ever meetings
- `facts.json` — the lines the app shows under the headline, derived so they cannot go stale
- `feed.json`, `feed.xml` — upcoming first meetings, as a subscribable feed

`python render_hero.py` draws the README image, the share card and the touch icon. It reads the
palette out of `docs/style.css` and re-sorts the members the way the app does, so the pictures
cannot drift from the site. The share card quotes live figures, so the daily refresh
regenerates it.

Then serve it:

```bash
python -m http.server -d docs 8000
```

## Tests

```bash
python -m unittest discover -s tests -v
```

A daily GitHub Action commits the build straight to the repo, so nobody reads that diff. The
suite runs in CI on every push and again inside the refresh workflow before it is allowed to
commit. `build.py` raises on a structurally broken artifact. The tests catch the subtler drift:
a confederation losing members, the most-played fixture changing identity, the feeds falling
out of sync, a fact on the landing page that stopped being true when two teams finally met.

## Syndication

Upcoming first meetings are published as
[RSS](https://dgoodenough.github.io/fifagami/feed.xml) and
[JSON Feed](https://dgoodenough.github.io/fifagami/feed.json). Item ids are stable per
pair and date, so a reader shows an entry once: when a fixture between two nations that have
never met first appears on the calendar. Every item links back to that pairing in the app.

## Tech

A static site. Vanilla JavaScript and a canvas, no build step, no runtime dependencies, hosted
on GitHub Pages from `docs/`. The 44,000-cell grid is drawn with view-culling for smooth
zoom and pan, and Pointer Events give mouse and touch a single interaction path.

The fold is three sheets: the destination triangle on the live canvas, plus two offscreen
renders of the same grid — the half that stays put and the half that moves. Each is clipped to
a triangle, and the moving one is hinged on the square's diagonal by a CSS
`rotate3d(1, 1, 0)` about its top-left corner. Because the matrix is symmetric, a half-turn
lands every cell on the pairing it mirrors, which is what makes the fold mean something: the
flap's back face carries the women's record onto the men's, cell for cell, and the two then
resolve into the four-way key. The hypotenuse of each triangle is offset by one cell so the
diagonal squares stay whole and the two halves register exactly.

Two things keep it quick at 22,155 pairings. The never-played count is a prefix sum over each
pair's first-meeting year, so a timeline drag reads it in constant time per frame instead of
walking every pair. The played graph is held as bitsets, so common-opponent counts for every
never-played pair come out in a few milliseconds.

The one third-party script is [GoatCounter](https://www.goatcounter.com), which counts pageviews
without cookies or cross-site identifiers.

Styled with [Ledger](https://github.com/dgoodenough/style). Greyscale carries structure, colour
carries meaning: red is never, green is played, yellow is scheduled.

## Still to do

- **Cluster analysis.** The British Isles light up as a dense little block. Community detection
  over the played graph could surface clusters like that automatically.
- **The loneliest nodes.** Ranking teams by how few distinct opponents they have ever faced.

## Credits

Match data © the [martj42](https://github.com/martj42) datasets. Rankings via
[FotMob](https://www.fotmob.com). Upcoming fixtures via [ESPN](https://www.espn.com/soccer/).
Confederation mapping from [cnc8/fifa-world-ranking](https://github.com/cnc8/fifa-world-ranking).
Concept inspired by [Scorigami](https://nflscorigami.com) (Jon Bois). Code under the
[MIT License](LICENSE).
