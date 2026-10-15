# Guacamole private fork

Private development repository for our Guacamole fixes and releases. This is
independent of macronrdp and contains both upstream components:

- `server/`: guacd, native protocol handlers, and its Docker build.
- `client/`: the Java web application, browser client, extensions, and its Docker build.

The baseline comes from Apache's **unreleased `staging/1.6.1` branches**, not an
official 1.6.1 release. `UPSTREAM.json` records the exact imported commits. Both
component histories are preserved through Git subtree imports. Upstream LICENSE,
NOTICE, and source headers remain unchanged; private hosting does not change
the upstream Apache licensing terms.

## Repository

- GitHub: <https://github.com/beraadim/guacamole-private> (private).
- Development branch: `codex/private-1.6.1`.
- `origin`: our private GitHub repository; normal pushes go here.
- `upstream-server`, `upstream-client`: official Apache sources; their local push
  URLs are disabled to guard against accidental upstream pushes.

Future clones should add the optional upstream remotes before fetching updates:

```sh
git remote add upstream-server https://github.com/apache/guacamole-server.git
git remote set-url --push upstream-server disabled://upstream-read-only
git remote add upstream-client https://github.com/apache/guacamole-client.git
git remote set-url --push upstream-client disabled://upstream-read-only
git config remote.pushDefault origin
```

## Bring in upstream fixes

Start from a clean working tree and review the new upstream commits first:

```sh
git fetch --no-tags upstream-server staging/1.6.1
git fetch --no-tags upstream-client staging/1.6.1
git log --oneline <previous-server-commit>..upstream-server/staging/1.6.1
git log --oneline <previous-client-commit>..upstream-client/staging/1.6.1
git subtree merge --prefix=server upstream-server/staging/1.6.1
git subtree merge --prefix=client upstream-client/staging/1.6.1
```

Resolve conflicts, update `UPSTREAM.json`, and validate before publishing an
internal release. Keep local fixes in separate, descriptive commits. Our Git
history can move independently of Apache's release schedule.

## Build matched images

Each upstream Dockerfile expects its own component directory as the build
context. Use private/local tags, for example:

```sh
docker build -t guacamole-private/guacd:1.6.1-private.1 server/
docker build -t guacamole-private/web:1.6.1-private.1 client/
```

For the reviewed internal release, use the pinned build inputs instead:

```sh
python3 scripts/build-images.py releases/1.6.1-private.2.json --jobs 4
```

The script uses local image tags and does not publish or deploy them. It pins
base-image digests and native dependency commits; distribution packages and
Maven artifacts still resolve through their package repositories. Archive build
logs and final image IDs with each deployment. Use `--component server` or
`--component client` to build one image. When building an exported source
archive, supply its Git commit through `SOURCE_REVISION`.
Preserve source file permissions when extracting that archive (`tar -xp`);
the runtime entrypoints execute as unprivileged container users. The build
driver rejects entrypoints whose permissions would prevent this.

Native `make check` now gates the server image. The client build runs the Java
and Firefox browser tests with `-DskipTests=false`. These checks do not replace
testing a real remote desktop session.

The current deployment and validation record is
[`1.6.1-private.2`](releases/1.6.1-private.2.md), including performance changes,
the optional diagnostics overlay and rollback details.

This import does not include production configuration, credentials, database
contents, logs, or any change to the running Guacamole containers. Keep local
deployment files in the ignored `local/` directory.
