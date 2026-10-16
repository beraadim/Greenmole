#!/usr/bin/env python3
"""Regression checks for the study's explicit-byte-variation comparison gate."""

import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("display_production", Path(__file__).with_name("benchmark-display-production.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def fixture():
    codecs = {name: {"calls": int(name == "png"), "pixels": 4 if name == "png" else 0,
                     "encoded_bytes": 100 if name == "png" else 0, "quality_min": None,
                     "quality_max": None, "max_image_pixels": 4 if name == "png" else 0,
                     "images_input_gt_1mib": 0, "images_input_gt_2mib": 0}
              for name in ["png", "jpeg", "webp"]}
    case = {key: 2 for key in ["width", "height", "dirty_width", "dirty_height",
                               "committed_desktop_width", "committed_desktop_height"]}
    case.update({"scenario": "example", "plan_image_pixels_min": 4, "plan_image_pixels_max": 4,
                 "plan_images_min": 1, "plan_images_max": 1,
                 "png_compression_control": {"indexed_calls": 1, "indexed_pixels": 4},
                 "png_scope_observation": {"indexed": {"calls": 1, "pixels": 4, "encoded_bytes": 100},
                                           "cairo_fallback": {"calls": 0, "pixels": 0, "encoded_bytes": 0,
                                                              "payload_sum": "0", "payload_xor": "0"}},
                 "encoder_observation": {"selector_calls": 1, "webp_lossless_calls": 0,
                                         "webp_lossy_calls": 0, "codecs": codecs},
                 "encoded_payload_fingerprints": {"enabled": True, "codecs": {
                     name: {"sum": "1", "xor": "1"} for name in codecs}},
                 "verification": {"enabled": True, "frames": 4, "rgb_pixels_compared": 16,
                                  "final_rgb_hash": "same-pixels"}})
    first = {"mode": "baseline", "png_settings": {"level": "default", "filter": "default",
                                                 "strategy": "default"}, "cases": [case]}
    second = copy.deepcopy(first)
    second["mode"] = "adaptive"
    return [first, second]


class ComparisonTests(unittest.TestCase):
    def test_default_stays_strict(self):
        runs = fixture()
        runs[1]["cases"][0]["encoder_observation"]["codecs"]["png"]["encoded_bytes"] += 1
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png")

    def test_study_with_identical_settings_stays_strict(self):
        runs = fixture()
        runs[1]["cases"][0]["encoded_payload_fingerprints"]["codecs"]["png"]["sum"] = "changed"
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)

    def test_explicit_png_settings_allow_only_png_byte_changes(self):
        runs = fixture()
        runs[1]["png_settings"]["filter"] = "fast"
        runs[1]["cases"][0]["encoder_observation"]["codecs"]["png"]["encoded_bytes"] = 90
        runs[1]["cases"][0]["encoded_payload_fingerprints"]["codecs"]["png"]["sum"] = "changed"
        result = benchmark.controlled_workloads(runs, "png", True)
        png = result["encoded_byte_comparisons"][0]
        self.assertTrue(result["matched"])
        self.assertEqual(png["delta_bytes"], -10)
        self.assertAlmostEqual(png["delta_percent"], -10)

    def test_omitted_hook_is_semantically_default_for_overhead_control(self):
        runs = fixture()
        runs[0]["png_settings"] = None
        self.assertTrue(benchmark.controlled_workloads(runs, "png", True)["matched"])
        runs[1]["cases"][0]["encoder_observation"]["codecs"]["png"]["encoded_bytes"] += 1
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)

    def test_settings_cannot_hide_different_work_or_pixels(self):
        for key in ["calls", "pixels", "quality_max", "max_image_pixels", "images_input_gt_1mib"]:
            runs = fixture()
            runs[1]["png_settings"]["level"] = "3"
            runs[1]["cases"][0]["encoder_observation"]["codecs"]["png"][key] = 123
            with self.assertRaises(RuntimeError):
                benchmark.controlled_workloads(runs, "png", True)
        for field in ["width", "dirty_height", "plan_images_max", "committed_desktop_width"]:
            runs = fixture()
            runs[1]["png_settings"]["level"] = "3"
            runs[1]["cases"][0][field] = 123
            with self.assertRaises(RuntimeError):
                benchmark.controlled_workloads(runs, "png", True)
        runs = fixture()
        runs[1]["png_settings"]["level"] = "3"
        runs[1]["cases"][0]["verification"]["final_rgb_hash"] = "different-pixels"
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)

    def test_other_codec_bytes_and_fingerprints_remain_strict(self):
        for name in ["jpeg", "webp"]:
            runs = fixture()
            runs[1]["png_settings"]["level"] = "3"
            runs[1]["cases"][0]["encoder_observation"]["codecs"][name]["encoded_bytes"] = 1
            with self.assertRaises(RuntimeError):
                benchmark.controlled_workloads(runs, "png", True)
            runs = fixture()
            runs[1]["png_settings"]["level"] = "3"
            runs[1]["cases"][0]["encoded_payload_fingerprints"]["codecs"][name]["sum"] = "changed"
            with self.assertRaises(RuntimeError):
                benchmark.controlled_workloads(runs, "png", True)

    def test_reverse_order_reports_reference_instead_of_false_baseline(self):
        runs = list(reversed(fixture()))
        runs[0]["png_settings"]["level"] = "3"
        result = benchmark.controlled_workloads(runs, "png", True)
        row = result["encoded_byte_comparisons"][0]
        self.assertEqual(row["reference_mode"], "adaptive")
        self.assertEqual(row["mode"], "baseline")
        self.assertEqual(row["run_index"], 1)

    def test_unexercised_settings_cannot_hide_cairo_byte_changes(self):
        runs = fixture()
        for run in runs:
            run["cases"][0]["png_compression_control"] = {"indexed_calls": 0, "indexed_pixels": 0}
        runs[1]["png_settings"]["level"] = "3"
        runs[1]["cases"][0]["encoder_observation"]["codecs"]["png"]["encoded_bytes"] += 1
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)

    def test_indexed_coverage_must_match(self):
        runs = fixture()
        runs[1]["png_settings"]["level"] = "3"
        runs[1]["cases"][0]["png_compression_control"]["indexed_calls"] += 1
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)

    def test_mixed_case_fallback_bytes_and_fingerprints_stay_strict(self):
        for field in ["calls", "pixels", "encoded_bytes", "payload_sum", "payload_xor"]:
            runs = fixture()
            runs[1]["png_settings"]["filter"] = "fast"
            runs[1]["cases"][0]["png_scope_observation"]["cairo_fallback"][field] = 123
            with self.assertRaises(RuntimeError):
                benchmark.controlled_workloads(runs, "png", True)

    def test_hook_off_cannot_be_combined_with_different_settings(self):
        runs = fixture()
        runs[0]["png_settings"] = None
        runs[1]["png_settings"]["level"] = "3"
        with self.assertRaises(RuntimeError):
            benchmark.controlled_workloads(runs, "png", True)


if __name__ == "__main__":
    unittest.main()
