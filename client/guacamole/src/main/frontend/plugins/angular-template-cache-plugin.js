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

const fs = require('node:fs/promises');
const path = require('node:path');
const { minify } = require('html-minifier-terser');

/**
 * Generates the AngularJS template cache with the maintained HTML minifier.
 * Template contents remain data: JSON encoding avoids executing template text
 * or treating template filenames as JavaScript. The emitted cache preserves
 * the previous plugin's URL keys and collapseWhitespace-only behavior.
 */
class AngularTemplateCachePlugin {

    constructor({ module, outputFilename, root, sourceDirectory }) {
        this.module = module;
        this.outputFilename = outputFilename;
        this.root = root;
        this.sourceDirectory = sourceDirectory;
    }

    apply(compiler) {
        const name = 'GreenmoleAngularTemplateCachePlugin';
        compiler.hooks.thisCompilation.tap(name, compilation => {
            compilation.hooks.processAssets.tapPromise({
                name,
                stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
            }, async () => {
                const sourceDirectory = path.resolve(compiler.context, this.sourceDirectory);
                const files = [];

                // Re-enumerate for every compilation so watch builds also pick
                // up newly created and removed templates.
                const visit = async directory => {
                    compilation.contextDependencies.add(directory);
                    const entries = await fs.readdir(directory, { withFileTypes: true });
                    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
                    for (const entry of entries) {
                        const filename = path.join(directory, entry.name);
                        if (entry.isDirectory())
                            await visit(filename);
                        else if (entry.isFile() && entry.name.endsWith('.html'))
                            files.push(filename);
                    }
                };
                await visit(sourceDirectory);

                // Escape separators for compatibility with older JS parsers.
                const quote = value => JSON.stringify(value)
                    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
                const source = [
                    'angular.module(' + quote(this.module) + ', [])',
                    '.run(["$templateCache", function($templateCache) {'
                ];

                for (const filename of files) {
                    compilation.fileDependencies.add(filename);
                    const relativePath = path.relative(sourceDirectory, filename).split(path.sep).join('/');
                    const key = this.root + relativePath;
                    const html = await minify(await fs.readFile(filename, 'utf8'), {
                        collapseWhitespace: true
                    });
                    source.push('$templateCache.put(' + quote(key) + ', ' + quote(html) + ');');
                }
                source.push('}]);');
                compilation.emitAsset(this.outputFilename,
                    new compiler.webpack.sources.RawSource(source.join('\n')));
            });
        });
    }
}

module.exports = AngularTemplateCachePlugin;
