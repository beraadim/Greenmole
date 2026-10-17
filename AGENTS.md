This is Greenmole, an independently maintained public fork of Apache Guacamole
server and client. It is not an Apache Software Foundation release.

- Keep native server changes in `server/` and web/browser changes in `client/`.
- Preserve upstream LICENSE, NOTICE, copyright headers and reachable history.
- Import upstream updates with Git subtree merges and record accepted source
  commits in `UPSTREAM.json`. Keep downstream fixes in focused commits.
- Push only to the maintainer's Greenmole repository; do not push to Apache
  upstream remotes or publish private backup refs.
- Keep credentials, runtime configuration, logs and database data out of Git.
- Use component-root Docker build contexts. Pin dependencies and base images
  when making a downstream release, and give Greenmole images distinct tags.
- Validate changed behavior with the relevant native or web tests. A Docker
  image build alone does not run all native server tests.
- Repository preparation is separate from deploying to running containers.
  Change live services only when the user requests deployment.
