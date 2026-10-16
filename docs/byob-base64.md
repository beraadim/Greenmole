# Direct Base64 decoding for outstanding BYOB reads

`Guacamole.InputStream.toReadableStream()` can decode a complete Guacamole
`blob` directly into an outstanding byte stream BYOB request when the browser
supplies `Uint8Array.prototype.setFromBase64()`. This avoids the intermediate
decoded payload buffer and its copy for each eligible blob. It still creates a
typed array view and receives the native decoder's result object; this is not an
allocation-free decoder.

There is no image quality, protocol, blob framing, flow control or buffer-size
change. The fast path only runs when:

- a consumer has already supplied a BYOB buffer;
- the entire independently decoded blob fits that view;
- the blob uses complete standard Base64 quartets, canonical padding and zero
  unused bits; and
- the browser supplies the native decode-into method.

The alphabet and padding guard scans the complete eligible string before any
write. This additional scan costs work, so avoiding a copy alone does not prove
a latency improvement. The guard uses a true end-of-string assertion: JavaScript
`$` also accepts a position before a trailing line break, which could produce an
incorrect decoded size. Native `setFromBase64()` can partly write before throwing
on malformed input, so optimistic decode-then-fallback would corrupt a consumer's
pending buffer. Full prevalidation prevents that behavior.

Normal readers, oversized blobs, empty blobs, whitespace, unpadded input and
nonzero unused bits retain `ArrayBufferReader`'s existing decoding path and
accepted-input/error behavior. Browsers without the decode-into API keep the
original blob handler directly. Offsets and non-Uint8 BYOB views are honored as
byte ranges. Cancellation, EOF and queued excess data keep the established
stream behavior. Each Guacamole blob remains independent; no trailing Base64
characters are carried between blobs. The
[native API specification](https://tc39.es/proposal-arraybuffer-base64/spec/)
defines the decode-into method's capacity, errors and returned counts.

## Validation and observed browser behavior

`InputStreamSpec.js` covers canonical padding variants and all byte values,
native decoding when present, native methods disabled, deterministic decode-into
support, exact-fit and offset views, a BYOB `DataView`, oversized fallback,
multiple reads, empty input, cancellation and pending EOF. Its malformed-input
cases retain sentinel bytes around and within the pending consumer buffer after
the existing decoder rejects the blob. Noncanonical inputs accepted by the
existing decoder are also checked, including terminal ASCII line breaks and
nonzero padding bits. Tests assert that eligible direct reads do not invoke the
allocating decoder. The real native decoder case is explicitly pending when the
browser does not provide the API.

The initial full-pipeline Chrome 155 probe observed **zero outstanding BYOB
requests** from its actual `ImageDecoder` stream consumption for both PNG and
WebP. Both client versions used the existing allocating path and performed no
BYOB payload copies. Thus this change provides an opportunistic improvement for
explicit BYOB consumers, with **no demonstrated image decoding speedup in the
tested Chrome implementation**. Browser support for the API alone does not mean
the image decoder uses BYOB. Release measurements must include the normal
non-BYOB path to detect overhead from the new capability check and callback.

## Test-only full-pipeline observations

Use the paced WebSocket-to-browser replay with the same production fixture for
both source versions:

```sh
node scripts/benchmark-browser-image-pipeline.mjs \
  --baseline 1.6.1-private.11 \
  --fixture local/private11-candidate-browser-fixture-final.json \
  --base64-counts on \
  --output local/byob-image-pipeline.json
```

The optional counters are installed only in separate untimed verification
documents, after reference image construction. Timing runs never install them
and report `base64_read_counts: null`. Counters record native direct decodes and
their byte count, decoded buffers delivered by `ArrayBufferReader`, copies from
those buffers through `Uint8Array.set()`, and unique BYOB requests observed via
the controller's native getter. Request-query counts are not request counts:
the fallback may query one request several times. They do not measure garbage
collection, heap allocation bytes, decoder-internal copies or CPU savings.

`--pipeline-diagnostics on` additionally enables the optional Client diagnostics
API and stores its numeric aggregate snapshot in each result. Both selected
client versions must provide that API; use `--client-ref` with the committed new
client to compare identical bundles. Diagnostics stay disabled by default. See
[the full pipeline replay documentation](browser-image-pipeline.md) for pacing,
pixel verification, environment and measurement limitations.
