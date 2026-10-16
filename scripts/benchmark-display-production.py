#!/usr/bin/env python3
"""Compare the real Guacamole planner/FIFO/encoder path without a live desktop."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "scripts/benchmarks/display-production.c"
PNG_CONTROL_SOURCE = ROOT / "scripts/benchmarks/png-compression-control.c"
PNG_CONTROL_HEADER = PNG_CONTROL_SOURCE.with_suffix(".h")
CASES = ["small-text", "scroll-text", "partial-text-redraw", "mixed-4k-desktop",
         "wallpaper-4k", "partial-photo-on-4k", "small-photo-on-4k",
         "window-1920x944", "window-2560x1304", "solid-color-4k", "no-copy-hit",
         "early-copy-hit", "late-copy-hit", "planner-reuse-alternating"]
CODECS = ["auto", "png", "webp-lossless", "webp-lossy", "jpeg"]


def bounded(minimum, maximum):
    def parse(text):
        value = int(text)
        if not minimum <= value <= maximum:
            raise argparse.ArgumentTypeError(f"expected {minimum}..{maximum}")
        return value
    return parse


def revision(text):
    if not re.fullmatch(r"[0-9a-fA-F]{40}", text):
        raise argparse.ArgumentTypeError("expected a full 40-character Git revision")
    return text.lower()


def run(image, mode, samples, warmup, workers, cpuset, selected_cases,
        verify_frames, expected_revision, codec, quality, render_diagnostics,
        encoded_fingerprints, png_settings=None):
    details = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
    source_revision = (details.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision")
    if expected_revision and source_revision != expected_revision:
        raise RuntimeError(f"{image}: source revision {source_revision!r} does not match {expected_revision}")
    binary_mode = "adaptive" if mode.startswith("adaptive") else mode
    # The private setter uses 1 to enable its shipped default (currently 12),
    # not a one-worker cap. Only values greater than 1 override that default.
    cap = int(mode.split("-")[1]) if "-" in mode else 1
    command = r"""set -eu
export TMPDIR=/run/encoderbench
export LD_LIBRARY_PATH=/opt/guacamole/lib
cd /run/encoderbench
extra_flags=
if grep -q worker_active_limit /tmp/guacamole-server/src/libguac/display-priv.h; then
    extra_flags=-DBENCH_CONCURRENCY_FIELDS
fi
cc -O2 -std=gnu11 -Wall -Werror -pedantic -pthread $extra_flags \
    -I/tmp/guacamole-server/src/libguac $(pkg-config --cflags cairo libwebp) PNG_FLAGS \
    /bench/display-production.c PNG_SOURCE -L/opt/guacamole/lib \
    -Wl,-rpath,/opt/guacamole/lib -Wl,-z,stack-size=8388608 -Wl,--export-dynamic \
    -lguac -ldl $(pkg-config --libs cairo libwebp) PNG_LIBS -o /run/encoderbench/benchmark
exec /run/encoderbench/benchmark MODE SAMPLES WARMUP ACTIVE_CAP CASE_FILTER VERIFY_FRAMES CODEC_CONTROL QUALITY_CONTROL PNG_ARGS
""".replace("MODE", shlex.quote(binary_mode)).replace("SAMPLES", str(samples)).replace("WARMUP", str(warmup)).replace(
        "ACTIVE_CAP", str(cap)).replace("CASE_FILTER", shlex.quote(",".join(selected_cases))).replace("VERIFY_FRAMES", str(verify_frames)).replace(
        "CODEC_CONTROL", shlex.quote(codec)).replace("QUALITY_CONTROL", str(quality)).replace(
        "PNG_FLAGS", "-DBENCH_PNG_CONTROLS $(pkg-config --cflags libpng)" if png_settings else "").replace(
        "PNG_SOURCE", "/bench/png-compression-control.c" if png_settings else "").replace(
        "PNG_LIBS", "$(pkg-config --libs libpng)" if png_settings else "").replace(
        "PNG_ARGS", " ".join(shlex.quote(png_settings[key]) for key in ["level", "filter", "strategy"])
        if png_settings else "")
    docker = ["docker", "run", "--rm", "--pull=never", "--network=none",
              "--read-only", "--tmpfs", "/run/encoderbench:rw,exec,size=128m",
              "--cap-drop=ALL", "--security-opt", "no-new-privileges",
              "--memory=1g", "--pids-limit=128", "--env",
              f"GUAC_DISPLAY_WORKER_THREADS={workers}", "--mount",
              f"type=bind,src={SOURCE},dst=/bench/display-production.c,readonly"]
    if png_settings:
        for path in [PNG_CONTROL_SOURCE, PNG_CONTROL_HEADER]:
            docker += ["--mount", f"type=bind,src={path},dst=/bench/{path.name},readonly"]
    if cpuset:
        docker += ["--cpuset-cpus", cpuset]
    docker += ["--env", f"GUAC_DISPLAY_DIAGNOSTICS={int(render_diagnostics)}"]
    docker += ["--env", f"GUAC_BENCH_PAYLOAD_FINGERPRINTS={int(encoded_fingerprints)}"]
    # Run the inspected immutable identity so a tag change cannot invalidate
    # the recorded source/image provenance between inspection and execution.
    docker += [details["Id"], "/bin/sh", "-c", command]
    result = subprocess.run(docker, text=True, stdout=subprocess.PIPE, check=True)
    cases = [json.loads(line) for line in result.stdout.splitlines() if line]
    if len(cases) != len(selected_cases) or any(case["mode"] != binary_mode for case in cases):
        raise RuntimeError(f"expected {len(selected_cases)} complete {mode} cases")
    if {case["scenario"] for case in cases} != set(selected_cases):
        raise RuntimeError("benchmark returned missing or unexpected scenarios")
    if verify_frames and any(case["verification"]["frames"] != verify_frames for case in cases):
        raise RuntimeError("lossless protocol/pixel verification did not finish")
    for case in cases:
        p50, p95, cpu = case["frame_p50_ms"], case["frame_p95_ms"], case["cpu_ms_per_frame"]
        if not all(math.isfinite(value) and value > 0 for value in (p50, p95, cpu)) or p50 > p95:
            raise RuntimeError(f"invalid timing summaries for {case['scenario']}")
        control = case["encoder_control"]
        if not control["hooks_verified"] or control["codec"] != codec or control["quality"] != quality:
            raise RuntimeError(f"encoder controls not verified for {case['scenario']}")
        status = case["render_statistics_status"]
        if status not in ["unsupported", "disabled", "enabled"] or (status == "enabled") != (case["render_statistics"] is not None):
            raise RuntimeError(f"inconsistent render diagnostic status for {case['scenario']}")
        if (render_diagnostics and status == "disabled") or (not render_diagnostics and status == "enabled"):
            raise RuntimeError(f"requested render diagnostic state not honored for {case['scenario']}")
        if case["encoded_payload_fingerprints"]["enabled"] != encoded_fingerprints:
            raise RuntimeError(f"requested payload fingerprints not honored for {case['scenario']}")
        png_control = case.get("png_compression_control")
        if png_settings:
            if (not png_control or not png_control.get("hooks_verified")
                    or any(png_control[key] != value for key, value in png_settings.items())):
                raise RuntimeError(f"PNG controls not honored for {case['scenario']}")
            for key, count_key in [("level", "level_applications"), ("filter", "filter_applications"),
                                   ("strategy", "strategy_applications")]:
                expected = png_control["indexed_calls"] if png_settings[key] != "default" else 0
                if png_control[count_key] != expected:
                    raise RuntimeError(f"PNG {key} coverage differs for {case['scenario']}")
            png_observation = case["encoder_observation"]["codecs"]["png"]
            if (not 0 <= png_control["indexed_calls"] <= png_observation["calls"]
                    or not 0 <= png_control["indexed_pixels"] <= png_observation["pixels"]
                    or bool(png_control["indexed_calls"]) != bool(png_control["indexed_pixels"])):
                raise RuntimeError(f"invalid indexed PNG coverage for {case['scenario']}")
            scopes = case["png_scope_observation"]
            for key in ["calls", "pixels", "encoded_bytes"]:
                if scopes["indexed"][key] + scopes["cairo_fallback"][key] != png_observation[key]:
                    raise RuntimeError(f"PNG scope observations disagree for {case['scenario']}: {key}")
            if (scopes["indexed"]["calls"] != png_control["indexed_calls"]
                    or scopes["indexed"]["pixels"] != png_control["indexed_pixels"]):
                raise RuntimeError(f"PNG scope observations missed indexed work for {case['scenario']}")
        elif png_control is not None:
            raise RuntimeError(f"unrequested PNG controls active for {case['scenario']}")
    return {"image": image, "image_id": details["Id"], "mode": mode,
            "source_revision": source_revision,
            "expected_source_revision": expected_revision,
            "source_revision_verified": bool(expected_revision),
            "png_settings": png_settings,
            "cases": cases}


def controlled_workloads(runs, codec, png_study=False):
    """Require equal realized encoding work before publishing fixed-codec runs."""
    if codec == "auto":
        return {"compared": False, "reason": "automatic format/quality decisions may differ"}
    if len(runs) < 2:
        return {"compared": False, "reason": "only one run requested"}
    reference = {case["scenario"]: case for case in runs[0]["cases"]}
    defaults = {"level": "default", "filter": "default", "strategy": "default"}
    byte_comparisons = []
    for run_index, run in enumerate(runs[1:], 1):
        settings_differ = (runs[0].get("png_settings") or defaults) != (run.get("png_settings") or defaults)
        if png_study and settings_differ and (not runs[0].get("png_settings") or not run.get("png_settings")):
            raise RuntimeError("different PNG settings require hooks on both sides; off is only a default/default overhead control")
        for case in run["cases"]:
            png_control = case.get("png_compression_control")
            reference_control = reference[case["scenario"]].get("png_compression_control")
            if png_control is not None and reference_control is not None:
                for key in ["indexed_calls", "indexed_pixels"]:
                    if png_control[key] != reference_control[key]:
                        raise RuntimeError(f"indexed PNG work differs for {case['scenario']}: {key}")
                fallback = case["png_scope_observation"]["cairo_fallback"]
                reference_fallback = reference[case["scenario"]]["png_scope_observation"]["cairo_fallback"]
                if fallback != reference_fallback:
                    raise RuntimeError(f"untouched PNG Cairo fallback differs for {case['scenario']}")
            indexed_calls = max((png_control or {}).get("indexed_calls", 0),
                                (reference_control or {}).get("indexed_calls", 0))
            # Different requested settings cannot excuse byte changes when no
            # indexed image exercised them (e.g. the untouched Cairo path).
            vary_png = png_study and settings_differ and indexed_calls > 0
            for key in ["width", "height", "dirty_width", "dirty_height", "plan_image_pixels_min",
                        "plan_image_pixels_max", "plan_images_min", "plan_images_max",
                        "committed_desktop_width", "committed_desktop_height"]:
                if case[key] != reference[case["scenario"]][key]:
                    raise RuntimeError(f"fixed-codec geometry differs for {case['scenario']}: {key}")
            verification = case.get("verification", {})
            expected_verification = reference[case["scenario"]].get("verification", {})
            if verification.get("enabled") != expected_verification.get("enabled"):
                raise RuntimeError(f"pixel replay state differs for {case['scenario']}")
            if verification.get("enabled"):
                for key in ["frames", "rgb_pixels_compared", "final_rgb_hash"]:
                    if verification[key] != expected_verification[key]:
                        raise RuntimeError(f"pixel replay differs for {case['scenario']}: {key}")
            expected = reference[case["scenario"]]["encoder_observation"]
            actual = case["encoder_observation"]
            for key in ["selector_calls", "webp_lossless_calls", "webp_lossy_calls"]:
                if actual[key] != expected[key]:
                    raise RuntimeError(f"fixed-codec workload differs for {case['scenario']}: {key}")
            for name in ["png", "jpeg", "webp"]:
                for key in ["calls", "pixels", "encoded_bytes", "quality_min", "quality_max",
                            "max_image_pixels", "images_input_gt_1mib", "images_input_gt_2mib"]:
                    if key == "encoded_bytes" and name == "png" and vary_png:
                        continue
                    if actual["codecs"][name][key] != expected["codecs"][name][key]:
                        raise RuntimeError(f"fixed-codec workload differs for {case['scenario']}: {name}.{key}")
            fingerprints = case["encoded_payload_fingerprints"]
            expected_fingerprints = reference[case["scenario"]]["encoded_payload_fingerprints"]
            if vary_png:
                if (fingerprints["enabled"] != expected_fingerprints["enabled"]
                        or any(fingerprints["codecs"][name] != expected_fingerprints["codecs"][name]
                               for name in ["jpeg", "webp"])):
                    raise RuntimeError(f"non-PNG payload fingerprints differ for {case['scenario']}")
            elif fingerprints != expected_fingerprints:
                raise RuntimeError(f"fixed-codec payload fingerprints differ for {case['scenario']}")
            if png_study:
                for name in ["png", "jpeg", "webp"]:
                    before = expected["codecs"][name]["encoded_bytes"]
                    after = actual["codecs"][name]["encoded_bytes"]
                    byte_comparisons.append({"run_index": run_index, "mode": run["mode"],
                                             "reference_mode": runs[0]["mode"], "scenario": case["scenario"],
                                             "codec": name, "reference_bytes": before, "run_bytes": after,
                                             "delta_bytes": after - before,
                                             "delta_percent": (after / before - 1) * 100 if before else None,
                                             "intentional_png_setting_variation": name == "png" and vary_png})
    return {"compared": True, "matched": True,
            "fields": "codec calls, geometry, actual image pixels, quality range, WebP lossless mode; encoded bytes/fingerprints stay strict except PNG across explicitly different study settings",
            "encoded_byte_comparisons": byte_comparisons} if png_study else {
                "compared": True, "matched": True,
                "fields": "codec calls, geometry, actual image pixels, encoded image bytes, quality range, WebP lossless mode and encoded payload fingerprints when enabled"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-image", required=True)
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--baseline-revision", type=revision,
                        help="require the baseline image's OCI label to match this build source")
    parser.add_argument("--candidate-revision", type=revision,
                        help="require the candidate image's OCI label to match this build source")
    parser.add_argument("--samples", type=bounded(2, 1000), default=30)
    parser.add_argument("--warmup", type=bounded(0, 100), default=5)
    parser.add_argument("--workers", type=bounded(1, 64), default=22)
    parser.add_argument("--verify-frames", type=bounded(0, 10), default=4,
                        help="untimed lossless protocol/pixel checks per case (0 disables)")
    parser.add_argument("--cpuset-cpus")
    parser.add_argument("--codec", choices=CODECS, default="auto",
                        help="benchmark-only fixed encoder control; auto preserves the library's original decisions")
    parser.add_argument("--quality", type=bounded(0, 100), default=75,
                        help="fixed JPEG/WebP quality (WebP lossless: compression effort); ignored for auto/PNG")
    parser.add_argument("--render-diagnostics", action="store_true",
                        help="opt in to newer libguac numeric render telemetry; older libraries report null")
    parser.add_argument("--encoded-fingerprints", action="store_true",
                        help="separate integrity run: fingerprint encoded image bytes; adds per-byte work, exclude from performance claims")
    parser.add_argument("--png-study", action="store_true",
                        help="benchmark indexed-PNG compression; only different explicit PNG settings may vary PNG bytes")
    for side in ["baseline", "candidate"]:
        parser.add_argument(f"--{side}-png-level", choices=["off", "default", "1", "3"], default="default",
                            help="off omits the hook for a default/default overhead control")
        parser.add_argument(f"--{side}-png-filter", choices=["default", "none", "up", "fast"], default="default")
        parser.add_argument(f"--{side}-png-strategy", choices=["default", "rle"], default="default")
    parser.add_argument("--modes", nargs="+", choices=["baseline", "fixed", "adaptive", "adaptive-8", "adaptive-12", "adaptive-16"],
                        default=["baseline", "adaptive"],
                        help="baseline keeps its library's shipped admission policy; fixed is diagnostic only")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=CASES)
    parser.add_argument("--reverse", action="store_true", help="reverse mode order to check host drift")
    args = parser.parse_args()
    if len(set(args.cases)) != len(args.cases):
        parser.error("--cases must not contain duplicates")
    png_settings = {}
    for side in ["baseline", "candidate"]:
        settings = {key: getattr(args, f"{side}_png_{key}") for key in ["level", "filter", "strategy"]}
        if not args.png_study and any(value != "default" for value in settings.values()):
            parser.error("PNG controls require --png-study")
        if settings["level"] == "off" and any(settings[key] != "default" for key in ["filter", "strategy"]):
            parser.error("off PNG hook requires default filter and strategy")
        png_settings[side] = settings if args.png_study and settings["level"] != "off" else None
    if args.png_study and args.codec != "png":
        parser.error("--png-study requires --codec png so realized encoding work remains controlled")
    defaults = {"level": "default", "filter": "default", "strategy": "default"}
    if (args.png_study and (png_settings["baseline"] is None or png_settings["candidate"] is None)
            and (png_settings["baseline"] or defaults) != (png_settings["candidate"] or defaults)):
        parser.error("off PNG hook is only for a default/default overhead control")
    modes = [(args.baseline_image if mode == "baseline" else args.candidate_image, mode)
             for mode in args.modes]
    if args.reverse:
        modes.reverse()
    runs = [run(image, mode, args.samples, args.warmup, args.workers, args.cpuset_cpus, args.cases,
                args.verify_frames, args.baseline_revision if mode == "baseline" else args.candidate_revision,
                args.codec, args.quality, args.render_diagnostics, args.encoded_fingerprints,
                png_settings["baseline" if mode == "baseline" else "candidate"])
            for image, mode in modes]
    print(json.dumps({
        "schema_version": 4,
        "measurement": "production display planner, copy search, FIFO, workers, codecs and serialization to a shared discard socket",
        "limitations": "synthetic fixtures; no capture, RDP transport, browser, Wi-Fi, physical input or frame pacing; copied pixels/planner/encoding included, fixture generation excluded",
        "fixture_note": "original nine scenarios preserved; added all-solid, zero-copy-hit, early/late exact-copy-hit and alternating-size planner-reuse fixtures",
        "policy_note": "baseline never calls the setter and preserves its shipped policy (including private.6 default12); adaptive passes setter value1, enabling the candidate default12 rather than limiting it to one worker; only values greater than1 override the adaptive cap; fixed passes0 as a separate full-pool diagnostic; test_active_cap is the legacy setter-control value, not necessarily an observed worker count",
        "verification": "separate untimed strict ASCII protocol replay with real PNG/lossless WebP decoding and exact RGB comparison of every fixture pixel after each checked frame; timing/RSS captured before verification; opaque fixed-size fixtures only, not a general browser or alpha/resize validator",
        "harness_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "wrapper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "png_compression_study": {"enabled": args.png_study, "settings": png_settings,
                                  "helper_sha256": hashlib.sha256(PNG_CONTROL_SOURCE.read_bytes()).hexdigest(),
                                  "header_sha256": hashlib.sha256(PNG_CONTROL_HEADER.read_bytes()).hexdigest(),
                                  "scope": "benchmark-only png_write_png interposition for indexed images; production defaults and Cairo fallback unchanged",
                                  "overhead": "enabled builds add header-prefix coverage, thread-local and relaxed numeric counter work per image; compare off/default to measure overhead; no PNG control helper linked when off"},
        "verification_frames": args.verify_frames,
        "statistics_note": "planner counter deltas cover measured frames only; scratch bytes are retained-capacity gauges; unavailable baseline counters are null, not zero",
        "planning_phase_timing_note": "existing numeric TRACE phase durations captured without formatting; per-frame mean/p95 use integer-millisecond wall times; search includes both candidate indexing and copy search; zero phase durations are valid; phase quantiles cannot be subtracted from full-frame quantiles",
        "encoder_control": {"codec": args.codec, "quality": args.quality,
                            "method": "benchmark-only ELF symbol interposition: auto forwards the original selector, fixed mode replaces only its decision, encoders always forward to the image's real implementations; hook coverage verified for every image; forced-lossless correctness replay disables overrides"},
        "controlled_workload_comparison": controlled_workloads(runs, args.codec, args.png_study),
        "encoded_fingerprints": {"enabled": args.encoded_fingerprints,
                                 "method": "per-image FNV-1a64 over concatenated encoded bytes before base64, aggregated as unsigned sum and XOR per codec independent of completion order; non-cryptographic integrity evidence alongside pixel replay, not a security proof",
                                 "timing_note": "enabled runs add per-byte hashing and must be excluded from headline performance comparisons; no encoded payloads retained or printed"},
        "encoder_timing_note": "summed per-image encoder wrapper wall times include codec work plus streaming/serialization/socket waits; concurrent sums are not frame latency or standalone codec CPU; instrumentation is identical on old/new libraries",
        "render_diagnostics": {"requested": args.render_diagnostics,
                               "note": "optional numeric telemetry adds clocks only in supporting libraries; use separate diagnostic runs when an older baseline cannot collect it; microsecond cumulative measured-frame deltas, maxima include initialization/warmup; overlapping phase sums and quantiles are not additive; no network-delivery timing"},
        "worker_pool": args.workers, "cpuset_cpus": args.cpuset_cpus,
        "samples": args.samples, "warmup": args.warmup, "runs": runs,
    }, indent=2))


if __name__ == "__main__":
    main()
