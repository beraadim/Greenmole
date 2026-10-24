/*
 * Copyright 2026 Greenmole contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// A local package name is not a substitute for vulnerability monitoring. Ask
// npm about the actual original AngularJS version and reject new/unmapped
// advisories. This online release check complements offline source integrity
// checks and behavioral browser regressions; it does not prove patches correct.
import fs from 'node:fs/promises';

const provenance = JSON.parse(await fs.readFile(new URL('./provenance.json', import.meta.url)));
const upstream = provenance.upstream;
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ [upstream.name]: [upstream.version] }),
    signal: AbortSignal.timeout(30000)
});
if (!response.ok) throw new Error('Original AngularJS advisory lookup failed: HTTP ' + response.status);
const report = await response.json();
const advisories = report[upstream.name];
if (!Array.isArray(advisories) || !advisories.length)
    throw new Error('Original AngularJS advisory lookup returned an unexpected empty result');

const fixed = new Set(provenance.fixedAdvisories);
const assessed = advisories.map(advisory => {
    const match = /^https:\/\/github\.com\/advisories\/(GHSA-[\w-]+)$/.exec(advisory.url);
    const id = match && match[1];
    const status = fixed.has(id) ? 'backported-and-regression-tested'
        : Object.hasOwn(provenance.notShipped, id) ? 'affected-module-not-shipped' : 'unreviewed';
    return { id, title: advisory.title, severity: advisory.severity, url: advisory.url, status };
});
console.log(JSON.stringify({ originalPackage: upstream.name, originalVersion: upstream.version,
    note: 'Mapping is local remediation evidence, not an npm endorsement of vendored patches.',
    advisories: assessed }, null, 2));
if (assessed.some(advisory => advisory.status === 'unreviewed'))
    throw new Error('New or unidentified AngularJS advisory requires review before release');
