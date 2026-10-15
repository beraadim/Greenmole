This is a private downstream repository for Apache Guacamole server and client.

- Keep native server changes in `server/` and web/browser changes in `client/`.
- Preserve upstream LICENSE, NOTICE, copyright headers and reachable history.
- Import upstream updates with Git subtree merges and record accepted source
  commits in `UPSTREAM.json`. Keep downstream fixes in focused commits.
- Push to the private `origin`; do not push to the Apache upstream remotes.
- Keep credentials, runtime configuration, logs and database data out of Git.
- Use component-root Docker build contexts. Pin dependencies and base images
  when making an internal release, and give downstream images distinct tags.
- Validate changed behavior with the relevant native or web tests. A Docker
  image build alone does not run all native server tests.
- Repository preparation is separate from deploying to running containers.
  Change live services only when the user requests deployment.
