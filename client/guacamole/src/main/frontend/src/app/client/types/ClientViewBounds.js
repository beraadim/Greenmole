/*
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

// Modified for Greenmole by its maintainers.

/**
 * Measures the visible desktop in remote pixels without changing its scroll,
 * zoom or mouse position. The native input toolbar is already outside main;
 * keyboard occlusion and browser pinch are represented by the visual viewport.
 */
angular.module('client').factory('ClientViewBounds', [function ClientViewBoundsFactory() {

    const rectangle = function rectangle(element) {
        if (!element || typeof element.getBoundingClientRect !== 'function')
            return null;
        const rect = element.getBoundingClientRect();
        if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top))
            return null;
        const width = Number.isFinite(rect.width) ? rect.width : rect.right - rect.left;
        const height = Number.isFinite(rect.height) ? rect.height : rect.bottom - rect.top;
        return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
            ? { left: rect.left, top: rect.top } : null;
    };

    return {

        /**
         * Inclusive integer desktop coordinates whose cursor anchor is visible,
         * or null if no usable geometry/remote pixel is available. Bounding
         * rectangles already include nested positioning and local scrolling.
         */
        get: function get(main, displayContainer, display, visualViewport) {
            if (!main || !display || typeof display.getScale !== 'function'
                    || typeof display.getWidth !== 'function' || typeof display.getHeight !== 'function')
                return null;

            // Detached views and legacy DOM-less fixtures have no reliable
            // geometry. Never manufacture bounds or mutate input in that case.
            let view;
            let content;
            let scale;
            let width;
            let height;
            try {
                view = rectangle(main);
                content = rectangle(displayContainer);
                scale = display.getScale();
                width = display.getWidth();
                height = display.getHeight();
            }
            catch (error) {
                return null;
            }
            if (!view || !content || !(scale > 0) || !Number.isFinite(scale)
                    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
                    || !(main.clientWidth > 0) || !(main.clientHeight > 0)
                    || !Number.isFinite(main.clientWidth) || !Number.isFinite(main.clientHeight))
                return null;

            const borderLeft = main.clientLeft === undefined ? 0 : main.clientLeft;
            const borderTop = main.clientTop === undefined ? 0 : main.clientTop;
            if (!Number.isFinite(borderLeft) || !Number.isFinite(borderTop)
                    || borderLeft < 0 || borderTop < 0)
                return null;

            let left = view.left + borderLeft;
            let top = view.top + borderTop;
            let right = left + main.clientWidth;
            let bottom = top + main.clientHeight;

            if (visualViewport) {
                const viewportLeft = visualViewport.offsetLeft === undefined ? 0 : visualViewport.offsetLeft;
                const viewportTop = visualViewport.offsetTop === undefined ? 0 : visualViewport.offsetTop;
                if (!Number.isFinite(viewportLeft) || !Number.isFinite(viewportTop)
                        || !(visualViewport.width > 0) || !(visualViewport.height > 0)
                        || !Number.isFinite(visualViewport.width) || !Number.isFinite(visualViewport.height))
                    return null;

                // These offsets and DOMRect coordinates share layout-viewport
                // CSS pixels. pageLeft/pageTop and visualViewport.scale must
                // not be applied again, even when the browser is pinched.
                left = Math.max(left, viewportLeft);
                top = Math.max(top, viewportTop);
                right = Math.min(right, viewportLeft + visualViewport.width);
                bottom = Math.min(bottom, viewportTop + visualViewport.height);
            }

            const contentRight = content.left + width * scale;
            const contentBottom = content.top + height * scale;
            if (![left, top, right, bottom, contentRight, contentBottom].every(Number.isFinite)
                    || right <= left || bottom <= top)
                return null;

            // RDP sends floor(x/y). Rounding the lower bound up prevents a
            // fractional CSS clamp from sending that cursor just outside the
            // left/top edge. The upper CSS edge is exclusive.
            const minX = Math.max(0, Math.ceil((left - content.left) / scale));
            const minY = Math.max(0, Math.ceil((top - content.top) / scale));
            const maxX = Math.min(width - 1, Math.ceil((right - content.left) / scale) - 1);
            const maxY = Math.min(height - 1, Math.ceil((bottom - content.top) / scale) - 1);
            if (minX > maxX || minY > maxY)
                return null;

            return {
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY,
                clipped: left > content.left || top > content.top
                    || right < contentRight || bottom < contentBottom
            };
        }

    };

}]);
