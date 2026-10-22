/*
 * Modified for Greenmole by its maintainers.
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * A directive which displays the Guacamole text input method.
 */
angular.module('textInput').directive('guacTextInput', [function guacTextInput() {

    return {
        restrict: 'E',
        replace: true,
        scope: {
            nativeKeyboard: '=?'
        },

        templateUrl: 'app/textInput/templates/guacTextInput.html',
        controller: ['$scope', '$rootScope', '$element', '$timeout', 'guacNativeKeyboard', '$window',
            function guacTextInput($scope, $rootScope, $element, $timeout, guacNativeKeyboard, $window) {

            /**
             * The number of characters to include on either side of text input
             * content, to allow the user room to use backspace and delete.
             *
             * @type Number
             */
            var TEXT_INPUT_PADDING = 4;

            /**
             * The Unicode codepoint of the character to use for padding on
             * either side of text input content.
             *
             * @type Number
             */
            var TEXT_INPUT_PADDING_CODEPOINT = 0x200B;

            /**
             * Keys which should be allowed through to the client when in text
             * input mode, providing corresponding key events are received.
             * Keys in this set will be allowed through to the server.
             * 
             * @type Object.<Number, Boolean>
             */
            var ALLOWED_KEYS = {
                0xFE03: true, /* AltGr */
                0xFF08: true, /* Backspace */
                0xFF09: true, /* Tab */
                0xFF0D: true, /* Enter */
                0xFF1B: true, /* Escape */
                0xFF50: true, /* Home */
                0xFF51: true, /* Left */
                0xFF52: true, /* Up */
                0xFF53: true, /* Right */
                0xFF54: true, /* Down */
                0xFF57: true, /* End */
                0xFF64: true, /* Insert */
                0xFFBE: true, /* F1 */
                0xFFBF: true, /* F2 */
                0xFFC0: true, /* F3 */
                0xFFC1: true, /* F4 */
                0xFFC2: true, /* F5 */
                0xFFC3: true, /* F6 */
                0xFFC4: true, /* F7 */
                0xFFC5: true, /* F8 */
                0xFFC6: true, /* F9 */
                0xFFC7: true, /* F10 */
                0xFFC8: true, /* F11 */
                0xFFC9: true, /* F12 */
                0xFFE1: true, /* Left shift */
                0xFFE2: true, /* Right shift */
                0xFFE3: true, /* Left ctrl */
                0xFFE4: true, /* Right ctrl */
                0xFFE9: true, /* Left alt */
                0xFFEA: true, /* Right alt */
                0xFFE7: true, /* Left meta */
                0xFFE8: true, /* Right meta */
                0xFFEB: true, /* Left super/command */
                0xFFEC: true, /* Right super/command */
                0xFFED: true, /* Left option (Mac) */
                0xFFEE: true, /* Right option (Mac) */
                0xFFFF: true  /* Delete */
            };

            /**
             * Recently-sent text, ordered from oldest to most recent.
             *
             * @type String[]
             */
            $scope.sentText = [];

            /**
             * Whether the "Alt" key is currently pressed within the text input
             * interface.
             * 
             * @type Boolean
             */
            $scope.altPressed = false;

            /**
             * Whether the "Ctrl" key is currently pressed within the text
             * input interface.
             * 
             * @type Boolean
             */
            $scope.ctrlPressed = false;

            /**
             * The text area input target.
             *
             * @type Element
             */
            var target = $element.find('.target')[0];

            /**
             * Whether the text input target currently has focus. Setting this
             * attribute has no effect, but any bound property will be updated
             * as focus is gained or lost.
             *
             * @type Boolean
             */
            var hasFocus = false;

            var updateFocus = function updateFocus(focused) {
                hasFocus = focused;
                if ($scope.nativeKeyboard)
                    guacNativeKeyboard.setFocused(focused);
            };

            target.onfocus = function targetFocusGained() {
                updateFocus(true);
                resetTextInputTarget(TEXT_INPUT_PADDING);
            };

            target.onblur = function targetFocusLost() {
                updateFocus(false);
                composingText = false;
            };

            /**
             * Focus must remain inside the original click/tap call stack. iOS
             * deliberately refuses delayed focus requests from timers/digests.
             * The target is already mounted, including while the keyboard is
             * hidden, so no render or automatic refocus is necessary.
             */
            $scope.showNativeKeyboard = function showNativeKeyboard(event) {
                event.preventDefault();
                // Explicit Show also handles iOS hiding its software keyboard
                // while leaving this editor focused. Never interrupt an IME.
                if (composingText)
                    return;
                if (hasFocus)
                    target.blur();
                // Blur ends the previous Pan cycle. Rearm only afterwards,
                // still synchronously inside the trusted Show gesture.
                guacNativeKeyboard.setPanning(true);
                try {
                    target.focus({ preventScroll: true });
                }
                catch (unsupportedFocusOptions) {
                    target.focus();
                }
            };

            $scope.hideNativeKeyboard = function hideNativeKeyboard(event) {
                event.preventDefault();
                target.blur();
                guacNativeKeyboard.setPanning(false);
            };

            $scope.showConnectionSettings = function showConnectionSettings(event) {
                event.preventDefault();
                // Give the connection panel the available viewport. Emit only
                // toward this bar's owner, without toggling other client views
                // or automatically reopening the device keyboard afterwards.
                target.blur();
                guacNativeKeyboard.setPanning(false);
                $scope.$emit('guacShowMenu');
            };

            $scope.nativeKeyboardState = guacNativeKeyboard;

            $scope.toggleDesktopPan = function toggleDesktopPan(event) {
                event.preventDefault();
                guacNativeKeyboard.setPanning(!guacNativeKeyboard.panning);
            };

            var toolbar = $element[0];
            var toolbarFrame = null;
            var toolbarObserver = null;
            var toolbarAlive = true;

            var measureToolbar = function measureToolbar() {
                if (!toolbarAlive)
                    return;
                var height = $scope.nativeKeyboard && toolbar
                    ? toolbar.getBoundingClientRect().height : 0;
                guacNativeKeyboard.setToolbarHeight(height);
            };

            var scheduleToolbarMeasurement = function scheduleToolbarMeasurement() {
                if (toolbarFrame === null) {
                    if ($window.requestAnimationFrame)
                        toolbarFrame = $window.requestAnimationFrame(function() {
                            toolbarFrame = null;
                            measureToolbar();
                        });
                    else
                        measureToolbar();
                }
            };

            // Measure this control strip itself, including wrapping, safe-area
            // padding and user font scaling. The enclosing flex layout
            // reserves it once above the remote desktop.
            if ($window.ResizeObserver) {
                toolbarObserver = new $window.ResizeObserver(measureToolbar);
                toolbarObserver.observe(toolbar);
            }
            $window.addEventListener('resize', scheduleToolbarMeasurement);

            $scope.$watch('nativeKeyboard', function nativeKeyboardChanged(enabled) {
                if (!enabled) {
                    guacNativeKeyboard.setFocused(false);
                    guacNativeKeyboard.setToolbarHeight(0);
                    guacNativeKeyboard.setPanning(false);
                }
                else {
                    guacNativeKeyboard.setFocused(hasFocus);
                    scheduleToolbarMeasurement();
                }
            });

            /**
             * Whether composition is currently active within the text input
             * target element, such as when an IME is in use.
             *
             * @type Boolean
             */
            var composingText = false;

            var targetComposeStart = function targetComposeStart() {
                composingText = true;
            };

            var targetComposeEnd = function targetComposeEnd(e) {
                composingText = false;
                // Some iOS/IME versions deliver the final input before
                // compositionend. Flush it here as well; reset padding makes a
                // following final input event harmless.
                handleTextInput(e);
            };

            target.addEventListener('compositionstart', targetComposeStart, false);
            target.addEventListener('compositionend', targetComposeEnd, false);

            /**
             * Translates a given Unicode codepoint into the corresponding X11
             * keysym.
             * 
             * @param {Number} codepoint
             *     The Unicode codepoint to translate.
             *
             * @returns {Number}
             *     The X11 keysym that corresponds to the given Unicode
             *     codepoint, or null if no such keysym exists.
             */
            var keysymFromCodepoint = function keysymFromCodepoint(codepoint) {

                // Keysyms for control characters
                if (codepoint <= 0x1F || (codepoint >= 0x7F && codepoint <= 0x9F))
                    return 0xFF00 | codepoint;

                // Keysyms for ASCII chars
                if (codepoint >= 0x0000 && codepoint <= 0x00FF)
                    return codepoint;

                // Keysyms for Unicode
                if (codepoint >= 0x0100 && codepoint <= 0x10FFFF)
                    return 0x01000000 | codepoint;

                return null;

            };

            /**
             * Presses and releases the key corresponding to the given keysym,
             * as if typed by the user.
             * 
             * @param {Number} keysym The keysym of the key to send.
             */
            var sendKeysym = function sendKeysym(keysym) {
                $rootScope.$broadcast('guacSyntheticKeydown', keysym);
                $rootScope.$broadcast('guacSyntheticKeyup', keysym);
            };

            /**
             * Presses and releases the key having the keysym corresponding to
             * the Unicode codepoint given, as if typed by the user.
             * 
             * @param {Number} codepoint
             *     The Unicode codepoint of the key to send.
             */
            var sendCodepoint = function sendCodepoint(codepoint) {

                if (codepoint === 10) {
                    sendKeysym(0xFF0D);
                    releaseStickyKeys();
                    return;
                }

                var keysym = keysymFromCodepoint(codepoint);
                if (keysym) {
                    sendKeysym(keysym);
                    releaseStickyKeys();
                }

            };

            /**
             * Translates each character within the given string to keysyms and
             * sends each, in order, as if typed by the user.
             * 
             * @param {String} content
             *     The string to send.
             */
            var sendString = function sendString(content) {

                var sentText = "";

                // Send each codepoint within the string
                for (var i=0; i<content.length; i++) {
                    var codepoint = content.codePointAt ? content.codePointAt(i) : content.charCodeAt(i);

                    // For surrogate pairs, skip the second 16 bits.
                    if (content.charCodeAt(i) !== codepoint) {
                        i++;
                    }
                    if (codepoint !== TEXT_INPUT_PADDING_CODEPOINT) {
                        sentText += String.fromCodePoint ? String.fromCodePoint(codepoint) : String.fromCharCode(codepoint);
                        sendCodepoint(codepoint);
                    }
                }

                // The native keyboard is a control surface, not an echo of
                // remote text (which may include passwords). Keep the legacy
                // text-input history only for its existing input method.
                if (sentText && !$scope.nativeKeyboard) {
                    $scope.$apply(function addSentText() {
                        $scope.sentText.push(sentText);
                    });

                    $timeout(function removeSentText() {
                        $scope.sentText.shift();
                    }, 1000);
                }

            };

            /**
             * Releases all currently-held sticky keys within the text input UI.
             */
            var releaseStickyKeys = function releaseStickyKeys() {

                // Reset all sticky keys
                $scope.$apply(function clearAllStickyKeys() {
                    $scope.altPressed = false;
                    $scope.ctrlPressed = false;
                });

            };

            /**
             * Removes all content from the text input target, replacing it
             * with the given number of padding characters. Padding of the
             * requested size is added on both sides of the cursor, thus the
             * overall number of characters added will be twice the number
             * specified.
             * 
             * @param {Number} padding
             *     The number of characters to pad the text area with.
             */
            var resetTextInputTarget = function resetTextInputTarget(padding) {

                var paddingChar = String.fromCharCode(TEXT_INPUT_PADDING_CODEPOINT);

                // Pad text area with an arbitrary, non-typable character (so there is something
                // to delete with backspace or del), and position cursor in middle.
                target.value = new Array(padding*2 + 1).join(paddingChar);
                target.setSelectionRange(padding, padding);

            };

            function handleTextInput(e) {

                // Ignore input events during text composition
                if (composingText || !hasFocus)
                    return;

                var i;
                var content = target.value;
                var expectedLength = TEXT_INPUT_PADDING*2;

                // If content removed, update
                if (content.length < expectedLength) {

                    // Calculate number of backspaces and send
                    var backspaceCount = TEXT_INPUT_PADDING - target.selectionStart;
                    for (i = 0; i < backspaceCount; i++)
                        sendKeysym(0xFF08);

                    // Calculate number of deletes and send
                    var deleteCount = expectedLength - content.length - backspaceCount;
                    for (i = 0; i < deleteCount; i++)
                        sendKeysym(0xFFFF);

                }

                else
                    sendString(content);

                // Reset content
                resetTextInputTarget(TEXT_INPUT_PADDING);
                e.preventDefault();

            }

            target.addEventListener('input', handleTextInput, false);

            // Do not allow event target contents to be selected during input.
            var preventSelection = function preventSelection(e) {
                e.preventDefault();
            };
            target.addEventListener('selectstart', preventSelection, false);

            // Native mode must also work with an attached hardware keyboard.
            // Ordinary text still uses the IME; Ctrl/Command shortcuts use the
            // physical key path and must have their corresponding keyup sent.
            var shortcutKeys = {};
            $scope.$on('guacBeforeKeydown', function filterKeydown(event, keysym, keyboard) {
                var modifiers = keyboard && keyboard.modifiers || {};
                var shortcut = $scope.nativeKeyboard && (modifiers.super
                    || modifiers.command || (modifiers.ctrl && !modifiers.alt));
                if (hasFocus && !ALLOWED_KEYS[keysym]) {
                    if (shortcut)
                        shortcutKeys[keysym] = true;
                    else
                        event.preventDefault();
                }
            });

            $scope.$on('guacBeforeKeyup', function filterKeyup(event, keysym) {
                if (shortcutKeys[keysym])
                    delete shortcutKeys[keysym];
                else if (hasFocus && !ALLOWED_KEYS[keysym])
                    event.preventDefault();
            });

            $scope.$on('$destroy', function destroyTextInput() {
                toolbarAlive = false;
                if (toolbarObserver)
                    toolbarObserver.disconnect();
                $window.removeEventListener('resize', scheduleToolbarMeasurement);
                if (toolbarFrame !== null && $window.cancelAnimationFrame)
                    $window.cancelAnimationFrame(toolbarFrame);
                if ($scope.nativeKeyboard) {
                    guacNativeKeyboard.setFocused(false);
                    guacNativeKeyboard.setPanning(false);
                    guacNativeKeyboard.setToolbarHeight(0);
                }
                target.onfocus = target.onblur = null;
                target.removeEventListener('input', handleTextInput, false);
                target.removeEventListener('compositionstart', targetComposeStart, false);
                target.removeEventListener('compositionend', targetComposeEnd, false);
                target.removeEventListener('selectstart', preventSelection, false);
                // Do not leave remote shortcut keys held when changing modes.
                Object.keys(shortcutKeys).forEach(function releaseShortcut(keysym) {
                    $rootScope.$broadcast('guacSyntheticKeyup', Number(keysym));
                });
                // guacKey's pressed-state watcher does not run as its scope is
                // destroyed. Release modifiers selected through the toolbar.
                if ($scope.ctrlPressed)
                    $rootScope.$broadcast('guacSyntheticKeyup', 0xFFE3);
                if ($scope.altPressed)
                    $rootScope.$broadcast('guacSyntheticKeyup', 0xFFE9);
            });

            // Native mode only focuses following a deliberate local gesture.
            // In particular, reconnects and keyboard dismissal must not reopen it.
            if (!$scope.nativeKeyboard)
                target.focus();

        }]

    };
}]);
