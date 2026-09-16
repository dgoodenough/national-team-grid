#!/usr/bin/env python3
"""Smoke tests for the built data artifacts in docs/data.

The site is a static build committed straight to the repo by a daily GitHub Action, so
these run in CI *before* that action is allowed to commit: if an upstream source changes
shape (a renamed FotMob field, a country martj42 respells), the build fails loudly here
rather than quietly shipping a wrong grid.

    python -m unittest discover -s tests -v

Stdlib only, same as build.py. Everything is read from the committed artifacts, so the
tests need no network and run in under a second.
"""
from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
sys.path.insert(0, str(ROOT))

import build  # noqa: E402


def load(name: str):
    return json.loads((OUT / name).read_text(encoding="utf-8"))


class TestValidator(unittest.TestCase):
    """build.validate_artifacts is the shared gate; run it as a test too."""

    def test_artifacts_validate(self):
        notes = build.validate_artifacts()
        for note in notes:
            print(f"  note: {note}")

    def test_validator_rejects_a_broken_artifact(self):
        """A validator that never fails is worse than no validator — prove it bites."""
        import shutil
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp) / "docs"
            data = docs / "data"
            shutil.copytree(OUT, data)
            for f in ("feed.json", "feed.xml"):
                shutil.copy(ROOT / "docs" / f, docs / f)

            matrix = json.loads((data / "matrix_men.json").read_text())
            matrix["pairs"][0][2] += 5          # a count the years file cannot account for
            (data / "matrix_men.json").write_text(json.dumps(matrix))

            with self.assertRaises(build.BuildError):
                build.validate_artifacts(data, docs)


class TestMembers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load("members.json")
        cls.members = cls.doc["members"]

    def test_current_fifa_membership(self):
        self.assertEqual(len(self.members), 211, "FIFA has 211 member associations")

    def test_every_confederation_is_represented(self):
        by_confed = {}
        for m in self.members:
            by_confed.setdefault(m["confed"], []).append(m)
        self.assertEqual(set(by_confed), set(self.doc["confederation_order"]))
        # Known membership sizes. These move about once a decade, so a mismatch means the
        # confederation mapping drifted, not that FIFA reorganised overnight.
        self.assertEqual({c: len(ms) for c, ms in by_confed.items()},
                         {"UEFA": 55, "CAF": 54, "AFC": 46,
                          "CONCACAF": 35, "OFC": 11, "CONMEBOL": 10})

    def test_ids_are_positional(self):
        self.assertEqual([m["id"] for m in self.members], list(range(len(self.members))))

    def test_ranks_are_plausible(self):
        mens = [m["mens_rank"] for m in self.members if m["mens_rank"]]
        self.assertGreater(len(mens), 200, "nearly every member should have a men's rank")
        self.assertEqual(min(mens), 1)
        # ~14 members have never held a women's ranking; they sort last in-confederation.
        womens = [m["womens_rank"] for m in self.members if m["womens_rank"]]
        self.assertGreater(len(womens), 180)
        self.assertEqual(min(womens), 1)

    def test_flags(self):
        flagged = [m for m in self.members if m["flag"]]
        self.assertGreaterEqual(len(flagged), len(self.members) - 2)
        # Kosovo has no ISO 3166-1 code and Northern Ireland no RGI tag sequence.
        self.assertEqual(sorted(m["code"] for m in self.members if not m["flag"]),
                         ["KVX", "NIR"])
        japan = next(m for m in self.members if m["name"] == "Japan")
        self.assertEqual(japan["flag"], "\U0001F1EF\U0001F1F5")

    def test_well_known_teams_are_present_and_correctly_placed(self):
        by_name = {m["name"]: m for m in self.members}
        for name, confed in (("Brazil", "CONMEBOL"), ("England", "UEFA"),
                             ("Japan", "AFC"), ("Nigeria", "CAF"),
                             ("United States", "CONCACAF"), ("New Zealand", "OFC")):
            self.assertIn(name, by_name, f"{name} should be a current FIFA member")
            self.assertEqual(by_name[name]["confed"], confed)


class TestMatrices(unittest.TestCase):
    """The grid itself: one entry per pair of teams that have met."""

    def _matrix(self, gender):
        return load(f"matrix_{gender}.json")

    def test_scale_of_the_archives(self):
        n = len(load("members.json")["members"])
        possible = n * (n - 1) // 2
        men = len(self._matrix("men")["pairs"])
        women = len(self._matrix("women")["pairs"])
        # The whole point of the picture: most of the grid is empty. If either archive
        # ever covers most of the grid, something has gone wrong upstream.
        self.assertLess(men / possible, 0.5, "men's coverage should still be a minority")
        self.assertGreater(men / possible, 0.2)
        self.assertLess(women / possible, men / possible,
                        "the women's archive is the sparser of the two")

    def test_most_played_fixture_is_a_famous_one(self):
        matrix = self._matrix("men")
        names = {m["id"]: m["name"] for m in load("members.json")["members"]}
        top = max(matrix["pairs"], key=lambda p: p[2])
        self.assertEqual(matrix["max_count"], top[2])
        self.assertGreater(top[2], 150, "the most-played men's pair has met 180+ times")
        self.assertEqual({names[top[0]], names[top[1]]}, {"Argentina", "Uruguay"})

    def test_first_years_predate_the_modern_game(self):
        firsts = [p[3] for p in self._matrix("men")["pairs"] if p[3]]
        self.assertEqual(min(firsts), 1872, "Scotland v England, the first international")
        self.assertLessEqual(max(firsts), 2100)


class TestYears(unittest.TestCase):
    """years_*.json drives the timeline scrubber; it must agree with the matrix."""

    def test_delta_decoding_reproduces_sorted_years(self):
        for gender in ("men", "women"):
            years = load(f"years_{gender}.json")
            self.assertEqual(years["encoding"], "delta")
            for key, enc in list(years["pairs"].items())[:500]:
                decoded, run = [enc[0]], enc[0]
                for d in enc[1:]:
                    run += d
                    decoded.append(run)
                self.assertEqual(decoded, sorted(decoded), f"{gender} {key} not ascending")

    def test_much_smaller_than_the_full_match_detail(self):
        """The reason this file exists: the scrubber should not pull the whole archive."""
        for gender in ("men", "women"):
            slim = (OUT / f"years_{gender}.json").stat().st_size
            full = (OUT / f"matches_{gender}.json").stat().st_size
            self.assertLess(slim, full * 0.5,
                            f"years_{gender}.json should be well under half of matches_")

    def test_counts_match_the_matrix(self):
        for gender in ("men", "women"):
            years = load(f"years_{gender}.json")
            counts = {f"{i},{j}": c for i, j, c, _, _ in load(f"matrix_{gender}.json")["pairs"]}
            checked = 0
            for key, count in counts.items():
                dated = len(years["pairs"].get(key, []))
                undated = years["undated"].get(key, 0)
                self.assertEqual(dated + undated, count, f"{gender} {key}")
                checked += 1
            self.assertGreater(checked, 1000)


class TestUpcoming(unittest.TestCase):
    def test_upcoming_pairs_have_genuinely_never_met(self):
        upcoming = load("upcoming.json")
        for gender in ("men", "women"):
            played = {f"{i},{j}" for i, j, _, _, _ in load(f"matrix_{gender}.json")["pairs"]}
            for lo, hi, when, comp in upcoming[gender]:
                self.assertNotIn(f"{lo},{hi}", played,
                                 f"{gender}: a scheduled 'first meeting' has already happened")
                self.assertRegex(when, r"^\d{4}-\d{2}-\d{2}$")
                self.assertTrue(comp.strip(), "every fixture should name a competition")

    def test_sorted_soonest_first(self):
        upcoming = load("upcoming.json")
        for gender in ("men", "women"):
            dates = [row[2] for row in upcoming[gender]]
            self.assertEqual(dates, sorted(dates))


class TestFeeds(unittest.TestCase):
    def test_json_feed_shape(self):
        feed = json.loads((ROOT / "docs" / "feed.json").read_text(encoding="utf-8"))
        self.assertTrue(feed["version"].startswith("https://jsonfeed.org/"))
        self.assertTrue(feed["home_page_url"].startswith("https://"))
        ids = [it["id"] for it in feed["items"]]
        self.assertEqual(len(ids), len(set(ids)), "feed item ids must be stable and unique")
        for item in feed["items"]:
            for field in ("id", "url", "title", "content_text", "date_published"):
                self.assertTrue(item.get(field), f"feed item missing {field}")

    def test_rss_parses_and_matches_the_json_feed(self):
        import xml.etree.ElementTree as ET

        tree = ET.parse(ROOT / "docs" / "feed.xml")
        channel = tree.getroot().find("channel")
        self.assertIsNotNone(channel)
        rss_titles = [i.findtext("title") for i in channel.findall("item")]
        json_titles = [it["title"] for it in
                       json.loads((ROOT / "docs" / "feed.json").read_text())["items"]]
        self.assertEqual(rss_titles, json_titles, "the two feeds should carry the same items")


class TestSiteAssets(unittest.TestCase):
    """The static site references these by name; a rename should fail here, not in a browser."""

    def test_referenced_files_exist(self):
        docs = ROOT / "docs"
        html = (docs / "index.html").read_text(encoding="utf-8")
        for name in ("tokens.css", "style.css", "app.js", "assets/favicon.svg",
                     "assets/og.png", "feed.xml"):
            # assertTrue, not assertIn: a failed assertIn would dump the whole page.
            self.assertTrue(name in html, f"index.html should reference {name}")
            self.assertTrue((docs / name).exists(), f"docs/{name} is missing")

    def test_index_html_social_copy_matches_the_data(self):
        """build.py stamps live figures into the meta description; they can go stale if the
        refresh stops committing index.html, and a wrong number there is what gets pasted
        into Slack and search results."""
        html = (ROOT / "docs" / "index.html").read_text(encoding="utf-8")
        members = load("members.json")["members"]
        n = len(members)
        possible = n * (n - 1) // 2
        played = len(load("matrix_men.json")["pairs"])
        played_women = len(load("matrix_women.json")["pairs"])
        for tag, text in build.social_copy(members, played, possible, played_women).items():
            self.assertTrue(text in html,
                            f"<meta {tag[0]}=\"{tag[1]}\"> is out of date; "
                            f"run python build.py --derive")

    def test_the_refresh_commits_the_stamped_index(self):
        wf = (ROOT / ".github/workflows/refresh.yml").read_text(encoding="utf-8")
        commit_step = wf.split("git add", 1)[1].split("\n", 1)[0]
        self.assertTrue("docs/index.html" in commit_step,
                        f"refresh.yml must commit the restamped index.html; git add is:"
                        f"{commit_step}")

    def test_the_share_card_is_regenerated_by_the_daily_refresh(self):
        """The card quotes a live figure ("15,635 ... have never been played").

        It is generated from the data, so if the refresh workflow stops regenerating or
        stops committing it, a pasted link starts quoting a number that moved several
        international windows ago — silently, because nothing else would notice."""
        wf = (ROOT / ".github/workflows/refresh.yml").read_text(encoding="utf-8")
        self.assertTrue("render_hero.py" in wf,
                        "refresh.yml must regenerate the images after rebuilding the data")
        commit_step = wf.split("git add", 1)[1].split("\n", 1)[0]
        self.assertTrue("docs/assets" in commit_step,
                        f"refresh.yml must commit the regenerated images; git add is:{commit_step}")

    def test_every_data_file_the_app_fetches_exists(self):
        app = (ROOT / "docs" / "app.js").read_text(encoding="utf-8")
        for name in ("members", "matrix_men", "matrix_women", "defunct", "upcoming"):
            self.assertTrue(f"data/{name}.json" in app,
                            f"app.js should fetch data/{name}.json")
            self.assertTrue((OUT / f"{name}.json").exists())
        for gender in ("men", "women"):
            self.assertTrue((OUT / f"matches_{gender}.json").exists())
            self.assertTrue((OUT / f"years_{gender}.json").exists())


class TestStories(unittest.TestCase):
    """The findings the site puts in front of people. If the data stops supporting a
    claim the UI makes, that is a content bug and it should fail here."""

    def test_teams_with_no_womens_internationals_at_all(self):
        members = load("members.json")["members"]
        names = {m["id"]: m["name"] for m in members}
        played = set()
        for i, j, *_ in load("matrix_women.json")["pairs"]:
            played.add(i)
            played.add(j)
        silent = sorted(names[m["id"]] for m in members if m["id"] not in played)
        self.assertGreater(len(silent), 0,
                           "the empty women's rows are a story the app tells explicitly")
        self.assertIn("San Marino", silent)

    def test_one_off_fixtures_exist_in_bulk(self):
        """The one-offs view needs a decent population to be worth a tab."""
        for gender, floor in (("men", 500), ("women", 200)):
            ones = [p for p in load(f"matrix_{gender}.json")["pairs"] if p[2] == 1]
            self.assertGreater(len(ones), floor)

    def test_the_loneliest_teams_are_genuinely_isolated(self):
        degree = {}
        for i, j, *_ in load("matrix_men.json")["pairs"]:
            degree[i] = degree.get(i, 0) + 1
            degree[j] = degree.get(j, 0) + 1
        members = load("members.json")["members"]
        fewest = min(degree.get(m["id"], 0) for m in members)
        self.assertLess(fewest, 25, "some members have faced only a handful of opponents")

    def test_the_played_graph_is_connected(self):
        """Degrees of separation only means anything if a path exists between any two
        teams that have played at all."""
        adj = {}
        for i, j, *_ in load("matrix_men.json")["pairs"]:
            adj.setdefault(i, set()).add(j)
            adj.setdefault(j, set()).add(i)
        start = next(iter(adj))
        seen, stack = {start}, [start]
        while stack:
            for nxt in adj[stack.pop()]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        self.assertEqual(len(seen), len(adj),
                         "every team that has played anyone should be reachable")


class TestFacts(unittest.TestCase):
    """facts.json is generated prose committed by a daily robot that nobody reads.

    A fact that has quietly become false is worse than no fact at all, so every claim is
    re-derived here from the matrices rather than trusted."""

    def setUp(self):
        self.facts = load("facts.json")["facts"]
        self.members = load("members.json")["members"]
        self.by_id = {m["id"]: m for m in self.members}
        self.counts = {
            g: {(p[0], p[1]): p[2] for p in load(f"matrix_{g}.json")["pairs"]}
            for g in ("men", "women")
        }

    def test_the_strip_has_something_to_show(self):
        self.assertGreaterEqual(len(self.facts), 6, "too few facts to be worth rotating")
        for f in self.facts:
            self.assertTrue(f["stat"] and f["text"], f"empty fact: {f}")
            self.assertIn(f["archive"], ("men", "women"), f"unknown archive: {f}")
            self.assertTrue(f["text"].endswith("."), f"fact should be a sentence: {f}")
            self.assertLess(len(f["text"]), 260, f"too long for the strip: {f}")

    def test_every_fact_links_somewhere_the_app_understands(self):
        """A fact whose link 404s or lands on the wrong view is a broken promise."""
        known = {"view", "pair", "teams", "path", "g", "never", "up", "confed",
                 "sort", "year", "defunct"}
        views = {"grid", "fixtures", "oneoffs", "misses", "path"}
        for f in self.facts:
            self.assertTrue(f["url"].startswith("?"), f"not a query link: {f['url']}")
            for part in f["url"][1:].split("&"):
                key, _, val = part.partition("=")
                self.assertIn(key, known, f"app.js does not read ?{key}= ({f['url']})")
                if key == "view":
                    self.assertIn(val, views, f"unknown view in {f['url']}")
                if key in ("pair", "path"):
                    for tid in val.split(","):
                        self.assertIn(int(tid), self.by_id, f"unknown team in {f['url']}")
                if key == "teams":
                    self.assertIn(int(val), self.by_id, f"unknown team in {f['url']}")

    def test_pair_links_agree_with_the_matrix(self):
        """Each ?pair= fact names a meeting count or a never-met; check the archive."""
        for f in self.facts:
            if not f["url"].startswith("?pair="):
                continue
            lo, hi = (int(x) for x in f["url"].split("=", 1)[1].split(","))
            played = self.counts["men"].get((min(lo, hi), max(lo, hi)), 0)
            names = (self.by_id[lo]["name"], self.by_id[hi]["name"])
            for n in names:
                self.assertIn(n, f["text"], f"{f['text']!r} should name {n}")
            if "never" in f["text"]:
                self.assertEqual(played, 0, f"claims never met, but they have: {f['text']}")
            else:
                self.assertEqual(f"{played:,}", f["stat"],
                                 f"stat disagrees with the matrix: {f['text']}")

    def test_the_never_played_claims_are_still_true(self):
        """Teams meet. A fact built on 'these two have never played' has a shelf life.

        Each fact records the pairs it asserts have not met, so this re-checks the claim
        against the archive instead of trying to read it back out of the sentence."""
        checked = 0
        for f in self.facts:
            for a, b in f["never"]:
                # assertTrue, not assertNotIn: a failed assertNotIn would dump the whole
                # 6,520-entry counts dict into the report.
                self.assertTrue(
                    (a, b) not in self.counts[f["archive"]],
                    f"{self.by_id[a]['name']} and {self.by_id[b]['name']} have now played "
                    f"({f['archive']}'s); this fact is out of date: {f['text']}")
                # A recorded pair that is not actually named in the prose means the claim
                # and the sentence have drifted apart.
                for tid in (a, b):
                    self.assertIn(self.by_id[tid]["name"], f["text"],
                                  f"fact claims about {self.by_id[tid]['name']} but does "
                                  f"not name it: {f['text']}")
                checked += 1
        self.assertGreaterEqual(checked, 2, "no never-played claim was actually checked")

    def test_facts_that_read_as_never_met_record_the_claim(self):
        """The structured field is only useful if the prose cannot assert more than it."""
        for f in self.facts:
            if "have never met" in f["text"] or "never played each other" in f["text"]:
                self.assertTrue(f["never"],
                                f"fact asserts a never-met pair but records none: {f['text']}")

    def test_the_build_regenerates_them(self):
        """Facts quote live figures, so the daily refresh has to rebuild this file."""
        self.assertTrue(hasattr(build, "write_facts"))
        app = (ROOT / "docs" / "app.js").read_text(encoding="utf-8")
        self.assertIn("data/facts.json", app, "app.js should fetch the facts")


class TestReadme(unittest.TestCase):
    """The README opens on specific pairings and specific figures.

    A daily robot commits new data over the top of it, so those claims can rot without
    anyone touching the file. These are the ones a reader would check."""

    def setUp(self):
        raw = (ROOT / "README.md").read_text(encoding="utf-8")
        self.readme = raw
        # Line-wrapped prose breaks a literal substring match, so flatten for phrase checks.
        self.flat = " ".join(raw.split())
        self.members = load("members.json")["members"]
        self.by_name = {m["name"]: m for m in self.members}
        self.counts = {
            g: {(p[0], p[1]): p[2] for p in load(f"matrix_{g}.json")["pairs"]}
            for g in ("men", "women")
        }

    def never_met(self, a: str, b: str) -> bool:
        x, y = self.by_name[a]["id"], self.by_name[b]["id"]
        return (min(x, y), max(x, y)) not in self.counts["men"]

    def test_the_opening_pairings_have_still_never_met(self):
        # assertTrue with a short message throughout: a failed assertIn against the README
        # would dump the whole file into the report.
        for a, b in (("Morocco", "Mexico"), ("Spain", "Senegal"), ("Japan", "Portugal")):
            self.assertTrue(f"{a} have never played {b}" in self.flat,
                            f"README should still open on {a} v {b}")
            self.assertTrue(
                self.never_met(a, b),
                f"README says {a} have never played {b}, but they now have. "
                f"Rewrite the opening.")
        # Named further down, in the Near misses row.
        self.assertTrue(self.never_met("Canada", "Sweden"),
                        "README says Canada and Sweden have never played; they now have.")

    def test_the_opening_bounds_still_hold(self):
        """The opening states bounds rather than counts, so it does not need editing every
        time two teams play. Exact figures were unusable here: 29% was sixteen first-ever
        meetings from rounding to 30%, with thirty already on the calendar. These bounds are
        roughly 870 meetings away each, and both sides only ever grow."""
        n = len(self.members)
        possible = n * (n - 1) // 2
        self.assertTrue(f"{possible:,} possible men's international fixtures" in self.flat,
                        f"README should quote {possible:,} possible fixtures")
        men = len(self.counts["men"]) / possible
        women = len(self.counts["women"]) / possible
        self.assertLess(men, 1 / 3,
                        f"README says fewer than a third of men's fixtures have been played; "
                        f"it is now {men:.1%}. Widen the bound.")
        self.assertLess(women, 1 / 6,
                        f"README says fewer than one in six women's fixtures have been "
                        f"played; it is now {women:.1%}. Widen the bound.")

    def test_the_hedged_claims_still_hold(self):
        """Each of these is phrased as a bound the data can only move away from, except the
        top-40 count, which moves with the rankings in both directions."""
        import itertools
        elite = [m for m in self.members if (m["mens_rank"] or 999) <= 40]
        unmet = sum(1 for a, b in itertools.combinations(elite, 2)
                    if self.never_met(a["name"], b["name"]))
        self.assertGreaterEqual(unmet, 24, f"README says dozens of top-40 pairs have never "
                                           f"met; it is now {unmet}.")

        opponents = {}
        for a, b in self.counts["men"]:
            opponents.setdefault(a, set()).add(b)
            opponents.setdefault(b, set()).add(a)
        ids = {m["name"]: m["id"] for m in self.members}
        shared = len(opponents[ids["Canada"]] & opponents[ids["Sweden"]])
        self.assertGreater(shared, 70, f"README says Canada and Sweden share more than "
                                       f"seventy opponents; it is now {shared}.")

        tonga = len(opponents[ids["Tonga"]])
        self.assertLessEqual(tonga, 12, f"README says Tonga has played a dozen countries at "
                                        f"most; it is now {tonga}.")

    def test_every_team_is_within_three_matches_of_every_other(self):
        """The README's Connect row claims it, and the diameter can only shrink as teams
        play, so this is a bound rather than a moving figure."""
        from collections import deque
        adj = {}
        for a, b in self.counts["men"]:
            adj.setdefault(a, set()).add(b)
            adj.setdefault(b, set()).add(a)
        worst = 0
        for src in adj:
            dist = {src: 0}
            queue = deque([src])
            while queue:
                u = queue.popleft()
                for v in adj[u]:
                    if v not in dist:
                        dist[v] = dist[u] + 1
                        worst = max(worst, dist[v])
                        queue.append(v)
        self.assertLessEqual(worst, 3, f"README says every team is within three matches of "
                                       f"every other; the longest chain is now {worst}.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
