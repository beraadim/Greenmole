# AngularJS security backports for Greenmole

This is the **core** AngularJS 1.8.3 distribution with a small, reviewed security
patch set maintained in this repository. It is not a Google, Apache, HeroDevs,
or PebblePad release, and carries no commercial support agreement. The original
Google MIT license is preserved in `LICENSE.md`. The unmodified `angular-route`
1.8.3 package remains a separate dependency.

`provenance.json` records the original npm tarball/source checksums and the
patched source/patch checksums. `angular-1.8.3-security.patch` is the complete
diff against the original `angular.js`; no third-party minified file is used.
Webpack minifies this reviewed source when producing `angular/angular.min.js`.
Run `python3 verify-source.py` to independently download and verify the original
tarball, reapply the patch in a temporary directory, and compare the result.
Pass an already downloaded tarball as its first argument for an offline check.

| Advisory | Remediation |
| --- | --- |
| GHSA-2vrf-hf26-jrp5 / CVE-2023-26116 | `angular.copy()` copies `RegExp.flags`; it does not run a backtracking expression on the string representation. |
| GHSA-m2h2-264f-f486 / CVE-2022-25844 | Currency formatting uses split/trim rather than a whitespace-matching regular expression, including when a symbol exists elsewhere in a malicious prefix. |
| GHSA-qwqh-hm9m-p5hr / CVE-2023-26118 | URL inputs use the browser URL parser after a linear scheme check. |
| GHSA-4w4v-5hc9-xrr2 / CVE-2024-21490 | The srcset parser scans each character once; no ambiguous whitespace regular expressions. |
| GHSA-m9gf-397r-hwpg / CVE-2024-8372 | Each srcset candidate is sanitized independently, including fractional density descriptors. URL/data-URL commas and descriptor boundaries follow HTML tokenization. |
| GHSA-mqm9-c95h-x2p6 / CVE-2024-8373 | `<source>` srcset attributes receive the same sanitization as `<img>`; property bindings also use the corrected parser. |
| GHSA-j58c-ww9w-pwp5 / CVE-2025-0716 | SVG `<image href>` / `ng-href` uses the media URL context, matching existing `xlink:href` handling. |
| GHSA-prc3-vjfx-vhm9 / CVE-2022-25869 | Internet Explorer cannot interpolate restored textarea DOM text. Other browsers and model bindings retain their existing behavior. Actual IE execution is not part of the supported-browser test matrix. |
| GHSA-7x27-g8rg-x87w / CVE-2026-11998 | SCE resource URL regular expressions are grouped before anchoring, so alternatives cannot match partial URLs. |

GHSA-2qqx-w9hr-q5gx / CVE-2023-26117 affects the separate `angular-resource`
module, which is **not shipped** by this package or Greenmole. Likewise,
`angular-sanitize`, its SVG sanitizer and `linky` are not included. Adding any
additional AngularJS module requires its own security review.

The copy and currency changes adapt the Debian security backports by Bastien
Roucariès, with currency work also credited to Alister Stevens / PebblePad.
The source/SVG context changes follow Debian's backports of PebblePad work by
Alister Stevens and Chris Rowe. The srcset scanner deliberately retains data
URL commas rather than using the simpler comma split from those patches.
The URL-parser approach also appears in PebblePad's maintained branch. The IE
and SCE corrections follow the published advisory behavior and are locally
implemented here.

Primary references:

- [Debian AngularJS security patch series](https://sources.debian.org/src/angular.js/1.8.3-3/debian/patches/series)
- [PebblePad's maintained AngularJS source](https://github.com/PebblePad/angular.js/tree/lts-v1.8)
- [HTML srcset parsing algorithm](https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute)
- [AngularJS SCE advisory](https://github.com/advisories/GHSA-7x27-g8rg-x87w)
- [AngularJS textarea advisory](https://github.com/advisories/GHSA-prc3-vjfx-vhm9)

The local package name makes ownership explicit. A clean npm audit does **not**
independently certify this vendored code: the public advisory database does not
track Greenmole's package. The original advisory list, source diff, checksums,
and real-browser security regressions must be reviewed together. No advisory is
silently dismissed or treated as fixed merely because the package was renamed.

Run the browser regressions from the frontend directory with
`npm run test:security:browser`. The same runner accepts a packaged/minified
AngularJS file as its argument, allowing release builds to verify the actual
deployed asset. Continued use of this end-of-life framework requires reviewing
new advisories and maintaining these backports until a framework migration.

Before each release also run `npm run audit:angular-upstream`. This queries the
original npm package and fails on unmapped advisories or lookup errors. Normal
builds verify the vendored source, patch, entry point and MIT license checksums
offline before compilation.
