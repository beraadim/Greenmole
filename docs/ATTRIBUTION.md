# Greenmole attribution and source provenance

Greenmole is an independently maintained, modified distribution of Apache
Guacamole. It is not affiliated with, endorsed by, or sponsored by The Apache
Software Foundation. Apache Guacamole and Apache are trademarks of The Apache
Software Foundation.

The repository is distributed under the [Apache License, Version 2.0](../LICENSE).
The original Apache attribution is retained in [NOTICE](../NOTICE), followed by
a separate Greenmole addendum. Original component LICENSE and NOTICE files,
copyright headers, and third-party license notices are preserved. The component
license files and the notices under `client/doc/licenses/` continue to describe
their respective third-party dependencies; the root Apache license does not
replace their terms.

[UPSTREAM.json](../UPSTREAM.json) records the exact Apache server and client
source revisions imported into `server/` and `client/`. Both imported histories
remain ancestors of the maintained branch. Historical Apache project names,
package names, copyright notices, protocol names, and public APIs are kept where
they describe origin or preserve compatibility.

Every source file changed from those imported revisions carries a prominent
notice stating that the Greenmole maintainers modified it. Source formats that
support comments put this notice near the beginning of the file, alongside
existing Apache headers where present. JSON must remain valid, so modified JSON
objects instead include an unused `_greenmoleModificationNotice` string member
near the beginning. Translation loaders and npm ignore this metadata member; it
is not a product translation or a configuration setting.

[DOWNSTREAM-CHANGES.json](../DOWNSTREAM-CHANGES.json) is an index of those
modified files, with their exact upstream baselines. It supplements the notices
inside the files. Newly added downstream files are covered by the repository
license and keep any applicable source headers; they are not described as
modified upstream files in that index.

Before publication or after an upstream merge, run:

```sh
python3 scripts/check-attribution.py
```

The check verifies file-local notices, exact preservation of upstream license
and third-party attribution files, the original root Apache notice, and the
reachability of both imported source histories. After reviewing new modified
files and adding their notices, update the index with:

```sh
python3 scripts/check-attribution.py --update
```

This check does not scan for credentials, determine the licensing of newly
introduced dependencies, or replace review of the Apache License's redistribution
conditions. Those checks remain part of preparing a public release.
