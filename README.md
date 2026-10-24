# Greenmole

<img src="client/guacamole/src/main/frontend/src/images/greenmole-256.png" width="128" height="128" alt="A cute green mole with a pink nose and little digging paws">

Greenmole is an independently maintained fork of [Apache Guacamole](https://guacamole.apache.org/),
a browser-based remote desktop gateway for RDP, VNC, and SSH. It focuses on
responsive desktop updates, connection recovery, and experimental browser video
decoding. No browser plugin is required.

This project is not an Apache Software Foundation release and is not endorsed by
the Apache Software Foundation. Apache Guacamole and Apache are trademarks of
the Apache Software Foundation.

## Source and maintenance

The public repository is [beraadim/Greenmole](https://github.com/beraadim/Greenmole).
Its owner maintains the project and controls changes to this repository. Public
issues and pull requests are welcome; the Apache License also permits others to
maintain their own forks.

- `server/`: guacd, native protocol handlers, and the server Docker build.
- `client/`: the Java web application, browser client, extensions, and the client Docker build.
- `docs/`: downstream feature guides and performance measurements.
- `releases/`: reviewed build inputs and historical release records.

The imported baseline comes from Apache's **unreleased `staging/1.6.1` branches**,
not an official Apache Guacamole 1.6.1 release. [UPSTREAM.json](UPSTREAM.json)
records the exact imported commits. Both component histories are preserved
through Git subtree imports. Earlier downstream releases retain their original
`private.N` names as historical records.

Guacamole protocol, Java package, extension, configuration, and API names remain
unchanged for compatibility. Existing deployments do not need to rename their
configuration keys or authentication extensions.

## Features

Greenmole includes improvements to image encoding, browser update scheduling,
frame recovery, resizing, and clipboard handling. Experimental AVC420 and AVC444
browser decoding can improve desktop video performance with a compatible server
such as [Greenmole RDP](https://github.com/beraadim/Greenmole-RDP), the companion
macOS RDP server. These options default off, require a compatible secure-context
WebCodecs decoder, and need a full reconnect after opt-in. Ordinary connections
continue to use image updates.

See the [AVC444 activation guide](docs/experimental-avc444.md),
[AVC420 transport guide](docs/experimental-avc420.md), and
[performance review](docs/performance-review-2026-10.md). Published measurements
describe the tested workloads and are not a guarantee for every client or network.

On iPad, select **Input method → Native keyboard** in the connection menu.
The keyboard controls and visible-area layout adapt to the device keyboard;
the selection is remembered in that browser. See the
[native keyboard guide](docs/native-keyboard.md).

## Companion macOS RDP server

[Greenmole RDP](https://github.com/beraadim/Greenmole-RDP) is the macOS server
companion to Greenmole. It also supports Windows Remote Desktop Connection and
other compatible RDP clients. Greenmole RDP is an independently maintained fork
of [MacRDP by x6nux](https://github.com/x6nux/macrdp), separately licensed under
GPLv3. See its repository for setup instructions and downloads.

Keyboard layout and Windows/Mac shortcut preferences are described in the
[keyboard guide](docs/keyboard-layouts.md).

## Build

Each Dockerfile expects its own component directory as the build context:

```sh
docker build -t greenmole/guacd:dev server/
docker build -t greenmole/web:dev client/
```

For reviewed downstream releases, use the pinned build inputs:

```sh
python3 scripts/build-images.py releases/1.6.1-greenmole.13.json --jobs 4
```

The driver builds local images; it does not publish or deploy them. It pins base
image digests and native dependency commits. Distribution packages and Maven
artifacts still resolve through their package repositories. Archive build logs
and final image IDs with each release. Use `--component server` or
`--component client` to build one image.

When building an exported source archive, set `SOURCE_REVISION` to its Git commit
and preserve source file permissions when extracting it (`tar -xp`). Runtime
entrypoints execute as unprivileged container users; the driver rejects
entrypoints whose permissions would prevent this.

Native `make check` gates the server image. The client build runs Java, Firefox
browser, and frontend Node tests with `-DskipTests=false`. Also test a real remote
desktop session before deploying a new build.

Use the [upstream configuration guide](https://guacamole.apache.org/doc/gug/)
for standard gateway, authentication, and connection settings. Greenmole-specific
settings are documented in `docs/`. Runtime configuration, credentials, database
contents, and operational logs belong outside source control. `local/` is ignored
for private development and deployment material.

## Upstream updates

Optional upstream remotes are read-only sources:

```sh
git remote add upstream-server https://github.com/apache/guacamole-server.git
git remote set-url --push upstream-server disabled://upstream-read-only
git remote add upstream-client https://github.com/apache/guacamole-client.git
git remote set-url --push upstream-client disabled://upstream-read-only
```

Start from a clean working tree, fetch and review the upstream changes, and use
Git subtree merges to preserve their history:

```sh
git fetch --no-tags upstream-server staging/1.6.1
git fetch --no-tags upstream-client staging/1.6.1
git log --oneline <previous-server-commit>..upstream-server/staging/1.6.1
git log --oneline <previous-client-commit>..upstream-client/staging/1.6.1
git subtree merge --prefix=server upstream-server/staging/1.6.1
git subtree merge --prefix=client upstream-client/staging/1.6.1
```

Resolve conflicts, update `UPSTREAM.json`, and validate the result before a
release. Keep downstream fixes in separate, descriptive commits.

## License and attribution

Greenmole is distributed under the [Apache License 2.0](LICENSE). Preserve the
[NOTICE](NOTICE), component license and notice files, source copyright headers,
and bundled third-party notices when redistributing it. Downstream modifications
are identified separately from the original Apache work. See the component
`LICENSE` and `NOTICE` files for their full attribution and dependency notices.

[Attribution guidance](docs/ATTRIBUTION.md) explains the source history and
modification notices. Run `python3 scripts/check-attribution.py` before publishing
a source release.
