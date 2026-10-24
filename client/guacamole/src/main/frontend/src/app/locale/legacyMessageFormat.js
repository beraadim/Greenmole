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

/**
 * Preserve the MessageFormat 1 translation syntax while using the maintained
 * MessageFormat 3 compiler. Existing translations (including extensions) use
 * backslash-escaped braces and literal apostrophes. The maintained compiler instead uses ICU
 * apostrophe quoting and validates plural categories more strictly.
 */
function configureLegacyMessageFormat(format) {
    format.options.strictPluralKeys = false;
    var compile = format.compile;
    format.compile = function(message) {
        // Translation interpolation accepts individual strings, as required by
        // MessageFormat 3's public compile API. Do not pass nested message maps
        // into the compiler's internal object-processing path.
        if (typeof message !== 'string')
            throw new TypeError('MessageFormat translation source must be a string');

        var normalized = [];
        var text = [];
        var contexts = [{ kind: 'message', plural: false }];

        // Only a plural argument (or an inherited plural context) gives # its
        // special meaning. Stop at any brace so malformed/nested arguments do
        // not cause repeated scans over the rest of a translation.
        var argumentType = function(position) {
            var cursor = position + 1;
            while (cursor < message.length && message[cursor] !== ',') {
                if (message[cursor] === '{' || message[cursor] === '}') return null;
                cursor++;
            }
            if (cursor === message.length) return null;
            var start = ++cursor;
            while (cursor < message.length && message[cursor] !== ',') {
                if (message[cursor] === '{' || message[cursor] === '}') return null;
                cursor++;
            }
            var type = message.slice(start, cursor).trim();
            return cursor < message.length ? type : null;
        };

        var flushText = function() {
            if (!text.length) return;
            var value = text.join('');
            var plural = contexts[contexts.length - 1].plural;
            var firstQuoted = 0;
            while (firstQuoted < value.length && value[firstQuoted] !== '{' &&
                    value[firstQuoted] !== '}' && !(plural && value[firstQuoted] === '#'))
                firstQuoted++;

            // ICU quotes start only before a syntax character. Quote one
            // continuous literal run, rather than adjacent quoted characters:
            // adjacent closing/opening apostrophes would become a literal '.
            normalized.push(value.slice(0, firstQuoted).replace(/'/g, "''"));
            if (firstQuoted < value.length)
                normalized.push("'" + value.slice(firstQuoted).replace(/'/g, "''") + "'");
            text = [];
        };

        for (var i = 0; i < message.length; i++) {
            var character = message[i];
            if (character === '\\') {
                var escaped = message[++i];
                if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(message.slice(i + 1, i + 5))) {
                    text.push(String.fromCharCode(parseInt(message.slice(i + 1, i + 5), 16)));
                    i += 4;
                }
                else if (escaped === '\\' || escaped === '{' || escaped === '}' || escaped === '#')
                    text.push(escaped);
                else
                    throw new SyntaxError('Invalid legacy MessageFormat escape');
            }
            else if (character === '{' || character === '}' ||
                    (character === '#' && contexts[contexts.length - 1].plural)) {
                flushText();
                normalized.push(character);
                if (character === '{') {
                    var parent = contexts[contexts.length - 1];
                    // A choice's next brace opens a case body, not another
                    // argument. Literal "name, plural," in a select case
                    // must therefore not change how escaped # is quoted.
                    var type = parent.kind === 'choice' ? null : argumentType(i);
                    var isPlural = type === 'plural' || type === 'selectordinal';
                    contexts.push({
                        kind: parent.kind === 'choice' ? 'message'
                            : isPlural || type === 'select' ? 'choice' : 'argument',
                        plural: parent.plural || isPlural
                    });
                }
                else if (character === '}' && contexts.length > 1)
                    contexts.pop();
            }
            else text.push(character);
        }
        flushText();

        var args = Array.prototype.slice.call(arguments);
        args[0] = normalized.join('');
        return compile.apply(this, args);
    };
    return format;
}

module.exports = configureLegacyMessageFormat;
