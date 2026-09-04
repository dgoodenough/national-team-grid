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


if __name__ == "__main__":
    unittest.main(verbosity=2)
