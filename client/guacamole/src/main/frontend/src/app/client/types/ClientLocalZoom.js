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

/** Anchored local zoom; changes neither remote resolution nor remote input. */
angular.module('client').factory('ClientLocalZoom', [function ClientLocalZoomFactory() {

    const ClientLocalZoom = {};

    /**
     * Apply an incremental two-finger change synchronously. Read the display's
     * actual position again after scaling: centered displays can change origin
     * as they grow beyond the viewport, and zooming out can clamp existing scroll.
     */
    ClientLocalZoom.apply = function apply(main, container, display, properties, change) {
        if (!container.getBoundingClientRect || !display || !properties || !change)
            return null;

        const scale = display.getScale();
        const values = [scale, properties.minScale, properties.maxScale,
            change.scaleFactor, change.clientX, change.clientY,
            change.previousClientX, change.previousClientY];
        if (!values.every(Number.isFinite) || scale <= 0 || properties.minScale <= 0
                || properties.maxScale < properties.minScale || change.scaleFactor <= 0
                || !(main.clientWidth > 0 && main.clientHeight > 0)
                || !(display.getWidth() > 0 && display.getHeight() > 0))
            return null;

        const before = container.getBoundingClientRect();
        if (!Number.isFinite(before.left) || !Number.isFinite(before.top))
            return null;

        const anchorX = (change.previousClientX - before.left) / scale;
        const anchorY = (change.previousClientY - before.top) / scale;
        const nextScale = Math.max(properties.minScale,
            Math.min(properties.maxScale, scale * change.scaleFactor));

        properties.autoFit = false;
        properties.scale = nextScale;
        display.scale(nextScale);
        main.style.overflow = 'auto';

        const after = container.getBoundingClientRect();
        const left = main.scrollLeft + after.left + anchorX * nextScale - change.clientX;
        const top = main.scrollTop + after.top + anchorY * nextScale - change.clientY;

        // DOM writes must precede notification: subsequent touch events need the
        // new geometry even if Angular has not yet run a digest. Bounds also stop
        // Safari's rubber-band offsets from propagating into saved view state.
        main.scrollLeft = Math.max(0, Math.min(
            Math.max(0, main.scrollWidth - main.clientWidth), left));
        main.scrollTop = Math.max(0, Math.min(
            Math.max(0, main.scrollHeight - main.clientHeight), top));

        return { left: main.scrollLeft, top: main.scrollTop };
    };

    return ClientLocalZoom;

}]);
