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
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const provenance = JSON.parse(await fs.readFile(new URL('./provenance.json', import.meta.url)));
for (const [filename, expected] of [
    ['angular.js', provenance.patchedAngularSha256],
    ['angular-1.8.3-security.patch', provenance.patchSha256],
    ['LICENSE.md', provenance.licenseSha256],
    ['index.js', provenance.indexSha256]
]) {
    const actual = createHash('sha256').update(await fs.readFile(new URL(filename, import.meta.url))).digest('hex');
    if (!expected || actual !== expected)
        throw new Error('Vendored AngularJS integrity check failed for ' + filename);
}
console.log('Vendored AngularJS source, patch, entry point and MIT license checksums verified.');
