# Experimental AVC420 browser decoding

Private.13 adds an opt-in transport for the matching macrdp 0.1.16 release.
The default remains the existing image path. Production connection settings,
credentials, recording settings, volumes and server preferences are not changed
by installing these builds.

The private.14 Display menu replaces the original checkbox with an explicit
Images / AVC420 / AVC444 choice. Existing enabled preferences remain AVC420.
See [AVC444 browser decoding](experimental-avc444.md) for full-color support.

## Try it

1. Install macrdp 0.1.16 from the Mac mini Desktop DMG.
2. Use Balanced or High quality in macrdp, with hardware encoding when available.
   Lossless desktop deliberately keeps using images: AVC420 is lossy.
3. Open Guacamole through HTTPS, or a localhost URL. The browser must provide a
   compatible WebCodecs H.264 decoder. Ordinary HTTP on a LAN IP cannot use this
   API and automatically retains images.
4. In the Guacamole connection menu, open Display and enable **Experimental
   AVC420 browser decoding**. The preference is saved in that browser.
5. Fully disconnect and reconnect. The Display section reports whether video is
   waiting, playing or has fallen back to images. macrdp reports the negotiated
   RDP graphics path separately; that alone does not prove browser decoding.

Turn off the checkbox and reconnect to return to the original image path.
A browser fallback stays on images for that RDP connection; reconnecting makes a
fresh capability decision. No system browser security flags are needed.

## Transport and limits

The browser advertises `video/x-guacamole-avc420;v=1` only after an asynchronous,
bounded codec support check and an explicit opt-in. Guacamole enables FreeRDP's
AVC420 capability only for this path and identifies it to macrdp with the exact
RDP client name `GuacamoleAVC420`. Other clients retain their normal behavior.
The marker requests a continuous AVC420 stream, including small updates, and
prevents AVC444 selection for this connection. It is a transport hint, not an
authentication or authorization mechanism.

Video travels through the existing Guacamole video stream and tunnel. There is
no new public port or direct browser-to-Mac connection. Every access unit carries
a versioned `GAV1` header: magic (32 bits), sequence (32 bits), visible width and
height (16 bits each), flags (32 bits; bit 0 means IDR), and payload length
(32 bits). Integers use network byte order. The payload is Annex B H.264;
Guacamole blobs may split a header or payload at any byte. Every IDR must include
SPS and PPS so a new decoder does not depend on a previous stream.

The matching macrdp build uses full-range BT.709 consistently for captured NV12,
RGB conversions and H.264 color metadata. This keeps generic browser decoding
and RDP's decoded image baseline consistent when changing paths.

The browser reserves ordered display tasks before decoding and crops macroblock
padding to the visible desktop. It acknowledges presentation after the canvas
operation, not merely receipt of encoded bytes. Decoder state, tasks and native
VideoFrames are disposed on fallback, reset, resize and disconnection. Payloads,
retained bytes, in-flight work and presentation deadlines are bounded.

## Image fallback and scope

This first version deliberately retains FreeRDP software decoding into its GDI
buffer while forwarding compressed video to the browser. It removes image
encoding and browser image decoding for active video frames; it does not yet
remove gateway H.264 decoding. That decoded buffer supplies a complete image
baseline if the browser rejects video or falls behind.

Initial images remain available until browser video has actually presented.
Invalid streams, unsupported graphics operations, missed presentation deadlines,
resize, sharing or recording requirements retain or restore the image path.
An explicit display refresh also returns the connection to images. Image/video
ordering barriers prevent an old image worker from overwriting newer video.

AVC420 can soften small colored text. This is an experiment to measure motion
and large desktop changes, not a promised performance improvement for every
workload. Compare the same resolution, quality, network and workload with the
checkbox off and on. Record browser presentation behavior, gateway CPU and both
network legs; macrdp throughput alone does not measure laptop performance.
