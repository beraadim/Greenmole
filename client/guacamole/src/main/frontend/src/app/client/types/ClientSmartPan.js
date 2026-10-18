/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information regarding
 * copyright ownership. The ASF licenses this file under the Apache
 * License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Modified for Greenmole by its maintainers.

/**
 * Reveals the last remote click (or a known pointer if no click exists) when
 * native keyboard geometry changes. RDP does not provide a text caret here;
 * this is a local input-location hint, never a guessed editable-field bound.
 */
angular.module('client').factory('ClientSmartPan', [function ClientSmartPanFactory() {

    return function ClientSmartPan(element, onScroll) {

        let click = null;
        let pointer = null;
        let keyboardActive = false;
        let keyboardFocused = false;
        let eligible = false;
        let manual = false;
        let geometryKey = null;
        let expectedScroll = null;
        let disposed = false;
        const scrollOptions = { passive: true };

        /** Remember only locations from remote-directed input, in desktop pixels. */
        this.recordPointer = function recordPointer(x, y, primary) {
            if (disposed || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)
                return;
            pointer = { x, y };
            if (primary)
                click = pointer;
        };

        /** Focus opens a fresh assistance cycle; Pan toggles do not erase manual intent. */
        this.setState = function setState(active, focused, enabled) {
            if (disposed)
                return;

            if (!active || !keyboardActive || (focused && !keyboardFocused)) {
                manual = false;
                geometryKey = null;
            }
            if (enabled && !eligible && !manual)
                geometryKey = null;

            keyboardActive = !!active;
            keyboardFocused = !!focused;
            eligible = keyboardActive && !!enabled;
        };

        this.markManual = function markManual() {
            if (keyboardActive)
                manual = true;
        };

        const localScrolled = () => {
            if (!keyboardActive || !expectedScroll)
                return;
            if (element.scrollLeft !== expectedScroll.left || element.scrollTop !== expectedScroll.top)
                this.markManual();
        };
        element.addEventListener('scroll', localScrolled, scrollOptions);

        /** Geometry is local CSS pixels; the recorded anchor remains remote pixels. */
        this.update = function update(geometry) {
            if (disposed || !eligible || manual)
                return;

            const { width, height, bottomInset, scale, left, top } = geometry;
            const visibleHeight = height - bottomInset;
            if (!(width > 0 && visibleHeight > 0 && scale > 0))
                return;

            const key = [width, height, bottomInset, scale, left, top].join(':');
            if (key === geometryKey)
                return;
            geometryKey = key;
            expectedScroll = { left: element.scrollLeft, top: element.scrollTop };

            const anchor = click || pointer;
            if (!anchor)
                return;

            const x = anchor.x * scale + left;
            const y = anchor.y * scale + top;
            const horizontalMargin = Math.min(32, width / 4);
            const verticalMargin = Math.min(32, visibleHeight / 4);
            let nextLeft = element.scrollLeft;
            let nextTop = element.scrollTop;

            // Move the shortest distance necessary to expose the input hint.
            // This does not center it, alter zoom, or follow a moving pointer.
            if (x - nextLeft < horizontalMargin)
                nextLeft = x - horizontalMargin;
            else if (x - nextLeft > width - horizontalMargin)
                nextLeft = x - width + horizontalMargin;
            if (y - nextTop < verticalMargin)
                nextTop = y - verticalMargin;
            else if (y - nextTop > visibleHeight - verticalMargin)
                nextTop = y - visibleHeight + verticalMargin;

            element.scrollLeft = Math.max(0, Math.min(
                Math.max(0, element.scrollWidth - element.clientWidth), nextLeft));
            element.scrollTop = Math.max(0, Math.min(
                Math.max(0, element.scrollHeight - element.clientHeight), nextTop));
            const changed = element.scrollLeft !== expectedScroll.left
                || element.scrollTop !== expectedScroll.top;
            expectedScroll = { left: element.scrollLeft, top: element.scrollTop };
            if (changed)
                onScroll(element.scrollLeft, element.scrollTop);
        };

        /** A managed client replacement must not reuse another session's hint. */
        this.clear = function clear() {
            click = null;
            pointer = null;
            keyboardActive = false;
            keyboardFocused = false;
            eligible = false;
            manual = false;
            geometryKey = null;
            expectedScroll = null;
        };

        this.dispose = function dispose() {
            disposed = true;
            element.removeEventListener('scroll', localScrolled, scrollOptions);
            this.clear();
        };

    };

}]);
