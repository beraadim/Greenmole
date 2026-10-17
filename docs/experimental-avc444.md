# Experimental AVC444 browser decoding

The private.15 browser/gateway pair supports an explicit AVC444 option alongside
AVC420 and ordinary images. Use the matching macrdp 0.1.20 build for the browser
transport hint and corrected AVC444 encoder layout. Existing AVC420 preferences
retain their meaning; this update does not enable experimental video globally.

## Try it

1. Install macrdp 0.1.20 from the Mac mini Desktop test DMG.
2. Select **Full color (AVC444)** under Video color detail in macrdp. Use a video
   encoder and Performance, Balanced or High quality. Bitmap fallback and
   Lossless desktop deliberately use images.
3. Open Guacamole over HTTPS or localhost, then select AVC444 in the connection
   menu's Display settings and fully disconnect/reconnect.
4. Confirm the Display status reports actual AVC444 playback. If the Mac still
   selects AVC420, its compatible browser path can play that stream instead.

The browser needs H.264 WebCodecs, access to native decoded YUV planes and a
working WebGL reconstruction path. Unsupported browsers retain image updates.
The paired stream requests software H.264 decoding so the capability probe and
actual desktop use the same sample-preserving decoder policy. At 2560×1264,
Chrome's default hardware path buffered a VideoToolbox pair stream without
presenting a frame and altered OpenH264 chroma values; the software policy
passed both streams against independently decoded color references. GPU color
reconstruction remains enabled. This can use more browser CPU than hardware
AVC420; the compatibility result is not a general performance measurement.
AVC444 adds processing and bandwidth compared with AVC420; it preserves finer
color detail, particularly colored text, rather than guaranteeing a higher
frame rate. No production connection, authentication or recording setting is
changed by installing the matching images.

## Decoder and image fallback

RDP AVC444 packs one image into main and auxiliary YUV420 pictures. They form
one ordered H.264 stream, so a single decoder receives both access units in
order. This is not a request for a browser-native H.264 4:4:4 profile. Decoded
I420/NV12 planes are copied without an intervening RGB conversion, combined
according to RDP's AVC444 v1 macroblock mapping and rendered as full-range
BT.709. Unsupported decoded formats, failed copies or rendering failures return
the connection to its maintained image baseline.

This first implementation forwards complete, paired AVC444 v1 updates. Partial
regions, single-view refinement updates and AVC444 v2 remain on the gateway's
software-decoded image path. Decode, copy and presentation deadlines, frame
queues, dimensions, payload sizes and retained bytes are bounded. Fallback
cleans up outstanding display tasks and native frames and stays on images for
the current RDP connection. Reconnect the client to attempt browser video again;
the macrdp server can remain running.

The Display menu explains browser failures using a bounded, content-free cause
such as unsupported native YUV layout, decoder failure, lost graphics context,
or a frame deadline. `getVideoStatistics().fallbackReason` exposes the same
allowlisted code. The gateway accepts only those exact codes for its diagnostic
log and never logs browser exception text or arbitrary ACK content. A stream
ended by the gateway may show image fallback without a browser failure cause.

Recording, sharing, unsupported graphics operations and explicit refresh retain
the same image fallback rules as the AVC420 experiment. Gateway decoding remains
active to keep a complete fallback image; this release does not remove that CPU
cost. Browser display ordering and presentation acknowledgments remain part of
the existing Guacamole stream and tunnel, without a new public network port.

## Wire format

The explicit MIME capability is `video/x-guacamole-avc444;v=1`. The gateway uses
`GuacamoleAVC444` as its exact RDP client name; it is a transport hint, not an
authentication mechanism. AVC420 remains separately advertised for compatibility.
The new stream uses a versioned `GAV2` header and carries main/auxiliary region
metadata plus both Annex B access units. The legacy `GAV1` AVC420 stream is
unchanged. See the native header and player parser for precise field offsets
and enforced limits.

## References

- [Microsoft RFX_AVC444_BITMAP_STREAM](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/844018a5-d717-4bc9-bddb-8b4d6be5dd3f)
- [Microsoft YUV420p combination for YUV444](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/8131c1bc-1af8-4907-a05a-f72f4581160f)
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)

## Reproduce desktop-size decoding

The browser suite retains both the original small/cropped sequences and public
synthetic 2560×1264 software/VideoToolbox sequences with six pairs, predictive
auxiliary pictures and a forced main IDR reset. Native YUV format and allocation
geometry are included in the synthetic validation report; no desktop is read.
Regenerate the desktop fixture from the matching macrdp exporter:

```sh
cargo run -p macrdp-encode --release --example export_avc444_fixture -- \
  /tmp/avc444-desktop --size 2560 1264 --fps 60 --backend both --frames 6 --bitrate 50000000
python3 client/guacamole-common-js/test/export-avc444-fixture.py \
  /tmp/avc444-desktop/fixture.json \
  --output client/guacamole-common-js/src/test/javascript/AVC444DesktopSyntheticFixture.js \
  --variable AVC444_DESKTOP_SYNTHETIC_FIXTURE
```

Run the first command in macrdp and the second in this repository, then run
`npm run test:browser` from `client/guacamole-common-js`.
