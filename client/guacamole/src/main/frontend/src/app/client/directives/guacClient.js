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
 * A directive for the guacamole client.
 */
angular.module('client').directive('guacClient', [function guacClient() {

    const directive = {
        restrict: 'E',
        replace: true,
        templateUrl: 'app/client/templates/guacClient.html'
    };

    directive.scope = {

        /**
         * The client to display within this guacClient directive.
         * 
         * @type ManagedClient
         */
        client : '=',

        /**
         * Whether translation of touch to mouse events should emulate an
         * absolute pointer device, or a relative pointer device.
         *
         * @type boolean
         */
        emulateAbsoluteMouse : '='

    };

    directive.controller = ['$scope', '$injector', '$element',
        function guacClientController($scope, $injector, $element) {

        // Required types
        const ManagedClient = $injector.get('ManagedClient');
        const ManagedClientState = $injector.get('ManagedClientState');
        const ClientInputQueue = $injector.get('ClientInputQueue');
        const ClientLocalPan = $injector.get('ClientLocalPan');
        const ClientTouchScroll = $injector.get('ClientTouchScroll');
        const ClientLocalZoom = $injector.get('ClientLocalZoom');
        const ClientViewBounds = $injector.get('ClientViewBounds');
        const ClientSmartPan = $injector.get('ClientSmartPan');
        const ClientResizeQueue = $injector.get('ClientResizeQueue');
            
        // Required services
        const $rootScope = $injector.get('$rootScope');
        const $window = $injector.get('$window');
        const clipboardService = $injector.get('clipboardService');
        const viewportService = $injector.get('guacViewportService');
        const nativeKeyboard = $injector.get('guacNativeKeyboard');
            
        /**
         * Whether the local, hardware mouse cursor is in use.
         * 
         * @type Boolean
         */
        let localCursor = false;

        /**
         * The current Guacamole client instance.
         * 
         * @type Guacamole.Client 
         */
        let client = null;

        /**
         * The display of the current Guacamole client instance.
         * 
         * @type Guacamole.Display
         */
        let display = null;

        /**
         * The element associated with the display of the current
         * Guacamole client instance.
         *
         * @type Element
         */
        let displayElement = null;

        /**
         * The element which must contain the Guacamole display element.
         *
         * @type Element
         */
        const displayContainer = $element.find('.display')[0];

        /**
         * The main containing element for the entire directive.
         * 
         * @type Element
         */
        const main = $element[0];

        /**
         * Guacamole mouse event object, wrapped around the main client
         * display.
         *
         * @type Guacamole.Mouse
         */
        const mouse = new Guacamole.Mouse(displayContainer);

        /**
         * Guacamole absolute mouse emulation object, wrapped around the
         * main client display.
         *
         * @type Guacamole.Mouse.Touchscreen
         */
        const touchScreen = new Guacamole.Mouse.Touchscreen(displayContainer);

        /**
         * Guacamole relative mouse emulation object, wrapped around the
         * main client display.
         *
         * @type Guacamole.Mouse.Touchpad
         */
        const touchPad = new Guacamole.Mouse.Touchpad(displayContainer);

        /**
         * Guacamole touch event handling object, wrapped around the main
         * client dislay.
         *
         * @type Guacamole.Touch
         */
        const touch = new Guacamole.Touch(displayContainer);

        /**
         * Ordered input waiting for any in-progress clipboard synchronization.
         * Cursor feedback is local and does not wait for this gate.
         *
         * @type ClientInputQueue
         */
        const inputQueue = new ClientInputQueue();
        let clipboardBlocked = clipboardService.isSyncInProgress();
        inputQueue.setBlocked(clipboardBlocked);
        let inputViewActive = true;
        let remoteMouseButtons = { left: false, middle: false, right: false };

        const canSendTouchScroll = () => inputViewActive && client && display
            && !clipboardBlocked && $scope.client.clientState.connectionState
                === ManagedClientState.ConnectionState.CONNECTED;

        const sendTouchScroll = (dx, dy) => {
            if (!canSendTouchScroll()) {
                remoteScroll.cancel();
                return;
            }
            rebaseRelativePointer();
            const targetClient = client;
            const x = Math.max(0, Math.min(display.getWidth() - 1,
                Number.isFinite(display.cursorX) ? display.cursorX : 0));
            const y = Math.max(0, Math.min(display.getHeight() - 1,
                Number.isFinite(display.cursorY) ? display.cursorY : 0));
            const released = { x, y, ...remoteMouseButtons,
                up: false, down: false, scrollLeft: false, scrollRight: false };
            const pulses = [];
            for (let n = 0; n < Math.abs(dy); n++)
                pulses.push(dy < 0 ? 'up' : 'down');
            // The extra horizontal wheel bits are implemented by the RDP
            // backend. Other protocols retain their existing vertical wheel.
            if ($scope.client.protocol === 'rdp') {
                for (let n = 0; n < Math.abs(dx); n++)
                    pulses.push(dx < 0 ? 'scrollLeft' : 'scrollRight');
            }
            if (!pulses.length)
                return;
            inputQueue.enqueue(() => {
                // RDP servers may process wheel deltas without moving their
                // pointer to the wheel PDU's coordinates. Seed an ordinary
                // movement first so a locally clamped/zoomed cursor scrolls
                // the application actually shown beneath it.
                if (targetClient !== client || !canSendTouchScroll())
                    return;
                targetClient.sendMouseState(released);
                for (const direction of pulses) {
                    if (targetClient !== client || !canSendTouchScroll())
                        break;
                    // Keep a wheel press/release together inside one queue
                    // item, including a reentrant detach or transport failure.
                    try {
                        targetClient.sendMouseState({ ...released, [direction]: true });
                    }
                    finally {
                        targetClient.sendMouseState(released);
                    }
                }
            });
        };

        const syncLocalScroll = (left, top) => {
            const target = $scope.client;
            $scope.$evalAsync(() => {
                if (inputViewActive && target && $scope.client === target) {
                    target.clientProperties.scrollLeft = left;
                    target.clientProperties.scrollTop = top;
                }
            });
        };
        const smartPan = new ClientSmartPan(main, syncLocalScroll);

        const containedPointerBounds = () => nativeKeyboard.enabled && !nativeKeyboard.panning
            ? ClientViewBounds.get(main, displayContainer, display, $window.visualViewport) : null;

        // Touchpad movement accumulates in scaled CSS coordinates. Keep that
        // accumulator aligned after local zoom/pan so reversing at a view edge
        // responds immediately instead of first undoing invisible overshoot.
        const rebaseRelativePointer = () => {
            if (!display || !touchPad.currentState)
                return;
            let x = Number.isFinite(display.cursorX) ? display.cursorX : 0;
            let y = Number.isFinite(display.cursorY) ? display.cursorY : 0;
            const bounds = containedPointerBounds();
            if (bounds && bounds.clipped) {
                x = Math.max(bounds.minX, Math.min(bounds.maxX, x));
                y = Math.max(bounds.minY, Math.min(bounds.maxY, y));
                display.moveCursor(x, y);
            }
            touchPad.currentState.x = x * display.getScale();
            touchPad.currentState.y = y * display.getScale();
        };

        // Pan is an explicit native-keyboard tool. Capture the touch before
        // touchscreen/touchpad emulation can press a remote button, retaining
        // the focused text editor and leaving hardware mouse input unchanged.
        const localPan = new ClientLocalPan(main,
            () => client && display && nativeKeyboard.enabled && nativeKeyboard.panning,
            (left, top) => {
                smartPan.markManual();
                syncLocalScroll(left, top);
            }, () => smartPan.markManual(), change => {
                if (!client || !display)
                    return;
                smartPan.markManual();
                const scroll = ClientLocalZoom.apply(main, displayContainer, display,
                    $scope.client.clientProperties, change);
                if (scroll) {
                    rebaseRelativePointer();
                    syncLocalScroll(scroll.left, scroll.top);
                }
            });

        const remoteScroll = new ClientTouchScroll(main,
            () => client && display && nativeKeyboard.enabled && nativeKeyboard.scrolling,
            sendTouchScroll, $window);
        let lastTouchTool = `${nativeKeyboard.enabled}:${nativeKeyboard.panning}:${nativeKeyboard.scrolling}`;
        const stopNativeInputListener = nativeKeyboard.subscribe(() => {
            const tool = `${nativeKeyboard.enabled}:${nativeKeyboard.panning}:${nativeKeyboard.scrolling}`;
            if (tool !== lastTouchTool) {
                // Neither tool may resume a contact which began in another
                // mode, even if toggled away and back between touch events.
                localPan.cancel();
                remoteScroll.cancel();
                lastTouchTool = tool;
            }
        });

        const resizeQueue = new ClientResizeQueue((width, height) => {
            if (client)
                client.sendSize(width, height);
        });
        let connectionRequested = false;
        let lastRemoteSize = null;
        let lastRemoteRows = 0;
        let lastRemoteColumns = 0;
        let lastLayoutWidth = null;
        let lastToolbarHeight = 0;
        let viewportState = null;
        let primaryButtonDown = false;

        const updateSmartPanState = () => smartPan.setState(
            !!(viewportState && viewportState.keyboardActive),
            !!(viewportState && viewportState.keyboardFocused),
            client && display && nativeKeyboard.enabled && nativeKeyboard.panning
                && $scope.client.clientProperties.focused);

        const updateSmartPan = function updateSmartPan() {
            updateSmartPanState();
            if (!client || !display)
                return;

            smartPan.update({
                width: main.clientWidth,
                height: main.clientHeight,
                // The permanent controls are outside this view in the flex
                // layout. Its measured height already excludes them.
                bottomInset: 0,
                scale: display.getScale(),
                left: displayContainer.offsetLeft,
                top: displayContainer.offsetTop
            });
        };

        /** Native input clips the existing desktop instead of fitting it down. */
        const updateDisplayOverflow = function updateDisplayOverflow(scale) {
            main.style.overflow = (viewportState && viewportState.preserveLayout)
                    || scale !== $scope.client.clientProperties.minScale ? 'auto' : 'hidden';
        };

        /**
         * Updates the scale of the attached Guacamole.Client based on current window
         * size and "auto-fit" setting.
         */
        const updateDisplayScale = function updateDisplayScale() {

            if (!display || (viewportState && viewportState.layoutReady === false)) return;

            // The software keyboard changes the visible window onto the
            // desktop, not its scale. The baseline already excludes the
            // permanent controls, including a wrapped toolbar.
            const fittingSize = viewportState && viewportState.preserveLayout && lastRemoteSize
                ? lastRemoteSize : { width: main.offsetWidth, height: main.offsetHeight };

            // Calculate scale to fit the full, unoccluded layout.
            $scope.client.clientProperties.minScale = Math.min(
                fittingSize.width  / Math.max(display.getWidth(),  1),
                fittingSize.height / Math.max(display.getHeight(), 1)
            );

            // Calculate appropriate maximum zoom level
            $scope.client.clientProperties.maxScale = Math.max($scope.client.clientProperties.minScale, 3);

            // Clamp zoom level, maintain auto-fit
            if (display.getScale() < $scope.client.clientProperties.minScale || $scope.client.clientProperties.autoFit)
                $scope.client.clientProperties.scale = $scope.client.clientProperties.minScale;

            else if (display.getScale() > $scope.client.clientProperties.maxScale)
                $scope.client.clientProperties.scale = $scope.client.clientProperties.maxScale;

            updateDisplayOverflow($scope.client.clientProperties.scale);

        };

        /**
         * Scrolls the client view such that the mouse cursor is visible.
         *
         * @param {Guacamole.Mouse.State} mouseState The current mouse
         *                                           state.
         */
        const scrollToMouse = function scrollToMouse(mouseState) {

            // Determine mouse position within view
            const mouse_view_x = mouseState.x + displayContainer.offsetLeft - main.scrollLeft;
            const mouse_view_y = mouseState.y + displayContainer.offsetTop  - main.scrollTop;

            // Determine viewport dimensions
            const view_width  = main.offsetWidth;
            const view_height = main.offsetHeight;

            // Determine scroll amounts based on mouse position relative to document

            let scroll_amount_x;
            if (mouse_view_x > view_width)
                scroll_amount_x = mouse_view_x - view_width;
            else if (mouse_view_x < 0)
                scroll_amount_x = mouse_view_x;
            else
                scroll_amount_x = 0;

            let scroll_amount_y;
            if (mouse_view_y > view_height)
                scroll_amount_y = mouse_view_y - view_height;
            else if (mouse_view_y < 0)
                scroll_amount_y = mouse_view_y;
            else
                scroll_amount_y = 0;

            // Scroll (if necessary) to keep mouse on screen.
            main.scrollLeft += scroll_amount_x;
            main.scrollTop  += scroll_amount_y;

        };

        /**
         * Return the name of the angular event associated with the provided
         * mouse event.
         *
         * @param {Guacamole.Mouse.MouseEvent} event
         *     The mouse event to determine an angular event name for.
         *
         * @returns
         *     The name of the angular event associated with the provided
         *     mouse event.
         */
        const getMouseEventName = event => {
            switch (event.type) {
                case 'mousedown':
                    return 'guacClientMouseDown';
                case 'mouseup':
                    return 'guacClientMouseUp';
                default:
                    return 'guacClientMouseMove';
            }
        };

        /**
         * Handles real and emulated mouse input. All remote input shares one
         * clipboard gate so a pending click cannot be overtaken by its release,
         * a keyboard modifier change, or a subsequent paste.
         *
         * @param {Guacamole.Mouse.MouseEvent} event
         *     The mouse event to handle.
         *
         * @param {boolean} emulated
         *     Whether to display and scroll to the software cursor.
         */
        const handleMouseInput = function handleMouseInput(event, emulated, device) {

            // Do not attempt to handle mouse state changes if the client
            // or display are not yet available
            if (!client || !display)
                return;

            // Broadcast mousedown event before sending so that modifiers
            // inferred from its flags (especially Cmd+Click) are processed
            // before the click that depends on them
            if (event.type === 'mousedown')
                $rootScope.$broadcast('guacBeforeClientMouseDown', event, client);

            event.stopPropagation();
            event.preventDefault();

            // Capture display coordinates now, before a zoom change or later
            // event can alter how this pending input should be interpreted.
            const targetClient = client;
            const state = { ...event.state };
            state.x /= display.getScale();
            state.y /= display.getScale();

            const bounds = containedPointerBounds();
            const contained = bounds && bounds.clipped;
            if (contained) {
                state.x = Math.max(bounds.minX, Math.min(bounds.maxX,
                    Number.isFinite(state.x) ? state.x : bounds.minX));
                state.y = Math.max(bounds.minY, Math.min(bounds.maxY,
                    Number.isFinite(state.y) ? state.y : bounds.minY));
                // Rebase the source device too, preserving buttons/wheel pulses.
                event.state.x = state.x * display.getScale();
                event.state.y = state.y * display.getScale();
                if (device && device.currentState) {
                    device.currentState.x = event.state.x;
                    device.currentState.y = event.state.y;
                }
            }

            const primary = (event.type === 'mousedown' && state.left && !primaryButtonDown)
                || (event.type === 'mouseup' && !state.left && primaryButtonDown);
            smartPan.recordPointer(state.x, state.y, primary);
            primaryButtonDown = !!state.left;
            remoteMouseButtons = { left: !!state.left, middle: !!state.middle, right: !!state.right };

            display.showCursor(emulated || !localCursor);
            display.moveCursor(Math.floor(state.x), Math.floor(state.y));
            if (emulated && !contained)
                scrollToMouse(event.state);

            // Only adjacent free movement may be replaced. Drag paths, wheel
            // pulses, button transitions and interleaved keys remain ordered.
            const freeMovement = event.type === 'mousemove'
                && !state.left && !state.middle && !state.right
                && !state.up && !state.down;
            inputQueue.enqueue(() => {
                targetClient.sendMouseState(state);
                // Sending also moves Guacamole's local cursor. A queued input
                // keeps its original remote coordinates, but a later zoom or
                // keyboard opening may have made those coordinates invisible.
                // Correct local feedback without changing the ordered input.
                const currentBounds = targetClient === client && inputViewActive
                    ? containedPointerBounds() : null;
                if (currentBounds && currentBounds.clipped
                        && (display.cursorX < currentBounds.minX || display.cursorX > currentBounds.maxX
                            || display.cursorY < currentBounds.minY || display.cursorY > currentBounds.maxY))
                    rebaseRelativePointer();
            }, freeMovement);

            // Process modifier observations when the event occurs. Any keys
            // inferred by these listeners join the same input queue, after
            // mouse-up or before mouse-down as appropriate.
            $rootScope.$broadcast(getMouseEventName(event), event, client);

        };

        const handleMouseEvent = event => handleMouseInput(event, false, mouse);
        const handleEmulatedMouseEvent = event => handleMouseInput(event, true, touchScreen);
        const handleTouchpadMouseEvent = event => handleMouseInput(event, true, touchPad);

        /**
         * Return the name of the angular event associated with the provided
         * touch event.
         *
         * @param {Guacamole.Touch.TouchEvent} event
         *     The touch event to determine an angular event name for.
         *
         * @returns
         *     The name of the angular event associated with the provided
         *     touch event.
         */
        const getTouchEventName = event => {
            switch (event.type) {
                case 'touchstart':
                    return 'guacClientTouchStart';
                case 'touchend':
                    return 'guacClientTouchEnd';
                default:
                    return 'guacClientTouchMove';
            }
        };

        /**
         * Handles a touch event originating from the user's device.
         *
         * @param {Guacamole.Touch.Event} touchEvent
         *     The touch event.
         */
        const handleTouchEvent = function handleTouchEvent(event) {

            // Do not attempt to handle touch state changes if the client
            // or display are not yet available
            if (!client || !display)
                return;

            event.preventDefault();

            // Send touch state, hiding local cursor
            display.showCursor(false);
            const targetClient = client;
            const state = { ...event.state };
            state.x /= display.getScale();
            state.y /= display.getScale();
            // Guacamole's first touch is contact 0. Other fingers must not
            // replace the primary input hint with a pinch/scroll location.
            if (!state.id)
                smartPan.recordPointer(state.x, state.y, true);
            inputQueue.enqueue(() => targetClient.sendTouchState(state));

            // Broadcast the touch event
            $rootScope.$broadcast(getTouchEventName(event), event, client);

        };

        // Attach any given managed client
        $scope.$watch('client', function attachManagedClient(managedClient) {

            // Pending input belongs only to the client that received it.
            localPan.cancel();
            remoteScroll.cancel();
            smartPan.clear();
            primaryButtonDown = false;
            remoteMouseButtons = { left: false, middle: false, right: false };
            inputQueue.clear();
            resizeQueue.clear();
            connectionRequested = false;
            lastRemoteSize = null;
            lastRemoteRows = 0;
            lastRemoteColumns = 0;
            lastLayoutWidth = null;
            lastToolbarHeight = 0;
            client = null;
            display = null;
            displayElement = null;

            // Remove any existing display
            displayContainer.innerHTML = "";

            // Only proceed if a client is given 
            if (!managedClient)
                return;

            // Get Guacamole client instance
            client = managedClient.client;

            // Attach possibly new display
            display = client.getDisplay();
            display.scale($scope.client.clientProperties.scale);
            resizeQueue.acknowledge(display.getWidth(), display.getHeight());
            const states = ManagedClientState.ConnectionState;
            const state = managedClient.clientState && managedClient.clientState.connectionState;
            resizeQueue.setConnected(state === states.WAITING || state === states.CONNECTED);

            // Add display element
            displayElement = display.getElement();
            displayContainer.appendChild(displayElement);

            // Do nothing when the display element is clicked on
            display.getElement().onclick = function(e) {
                e.preventDefault();
                return false;
            };

            // Connect and update interface to match required size, deferring
            // connecting until a future element resize if the main element
            // size (desired display size) is not known and thus can't be sent
            // during the handshake
            $scope.mainElementResized();

        });

        // Update actual view scrollLeft when scroll properties change
        $scope.$watch('client.clientProperties.scrollLeft', function scrollLeftChanged(scrollLeft) {
            main.scrollLeft = scrollLeft;
            $scope.client.clientProperties.scrollLeft = main.scrollLeft;
        });

        // Update actual view scrollTop when scroll properties change
        $scope.$watch('client.clientProperties.scrollTop', function scrollTopChanged(scrollTop) {
            main.scrollTop = scrollTop;
            $scope.client.clientProperties.scrollTop = main.scrollTop;
        });

        // Update scale when display is resized
        $scope.$watch('client.managedDisplay.size', function setDisplaySize() {
            if (display)
                resizeQueue.acknowledge(display.getWidth(), display.getHeight());
            $scope.$evalAsync(updateDisplayScale);
        });

        // Layout can settle while the handshake is in flight, before the
        // element's resize sensor is ready. Remeasure before enabling the
        // queue so it cannot flush a stale initial viewport.
        $scope.$watch('client.clientState.connectionState', function connectionStateChanged(state) {
            remoteScroll.cancel();
            const states = ManagedClientState.ConnectionState;
            const active = state === states.WAITING || state === states.CONNECTED;
            if (active)
                $scope.mainElementResized();
            resizeQueue.setConnected(active);
        });

        $scope.$watch('client.protocol', function protocolChanged() {
            $scope.mainElementResized();
        });

        // Keep local cursor up-to-date
        $scope.$watch('client.managedDisplay.cursor', function setCursor(cursor) {
            if (cursor)
                localCursor = mouse.setCursor(cursor.canvas, cursor.x, cursor.y);
        });

        // Update touch event handling depending on remote multi-touch
        // support and mouse emulation mode
        $scope.$watchGroup([
                'client.multiTouchSupport',
                'emulateAbsoluteMouse'
            ], function touchBehaviorChanged() {

            // Clear existing event handling
            touch.offEach(['touchstart', 'touchmove', 'touchend'], handleTouchEvent);
            touchScreen.offEach(['mousedown', 'mousemove', 'mouseup'], handleEmulatedMouseEvent);
            touchPad.offEach(['mousedown', 'mousemove', 'mouseup'], handleTouchpadMouseEvent);

            // Direct touch belongs to absolute mode. An explicit relative
            // preference must remain a trackpad even if the server supports
            // touch contacts (including the iOS device default).
            if ($scope.client.multiTouchSupport && $scope.emulateAbsoluteMouse)
                touch.onEach(['touchstart', 'touchmove', 'touchend'], handleTouchEvent);

            // Switch to touchscreen if mouse emulation is required and
            // absolute mouse emulation is preferred
            else if ($scope.emulateAbsoluteMouse)
                touchScreen.onEach(['mousedown', 'mousemove', 'mouseup'], handleEmulatedMouseEvent);

            // Use touchpad for mouse emulation if absolute mouse emulation
            // is not preferred
            else
                touchPad.onEach(['mousedown', 'mousemove', 'mouseup'], handleTouchpadMouseEvent);

        });

        // Adjust scale if modified externally
        $scope.$watch('client.clientProperties.scale', function changeScale(scale) {

            // Fix scale within limits
            scale = Math.max(scale, $scope.client.clientProperties.minScale);
            scale = Math.min(scale, $scope.client.clientProperties.maxScale);

            // Native input keeps the same scale but exposes only part of the
            // desktop. It must remain scrollable even at the auto-fit minimum.
            updateDisplayOverflow(scale);

            // Apply scale if client attached
            if (display)
                display.scale(scale);
            rebaseRelativePointer();
            updateSmartPan();
            
            if (scale !== $scope.client.clientProperties.scale)
                $scope.client.clientProperties.scale = scale;

        });
        
        // If autofit is set, the scale should be set to the minimum scale, filling the screen
        $scope.$watch('client.clientProperties.autoFit', function changeAutoFit(autoFit) {
            if(autoFit)
                $scope.client.clientProperties.scale = $scope.client.clientProperties.minScale;
        });

        /**
         * Sends the current size of the main element (the display container)
         * to the Guacamole server, requesting that the remote display be
         * resized. If the Guacamole client is not yet connected, it will be
         * connected and the current size will sent through the initial
         * handshake. If the size of the main element is not yet known, this
         * function may need to be invoked multiple times until the size is
         * known and the client may be connected.
         */
        $scope.mainElementResized = function mainElementResized() {

            // Send new display size, if changed
            if (client && display && main.offsetWidth && main.offsetHeight) {

                // Keep the remote layout while native input UI clips the view.
                // A genuine rotation/multitasking width change or tile-row
                // change establishes a new layout instead of retaining stale
                // dimensions from the previous orientation/grid.
                const grid = main.closest ? main.closest('.tiled-client-grid') : null;
                const rows = grid ? grid.children.length : 1;
                const row = main.closest ? main.closest('.tiled-client-row') : null;
                const columns = row ? row.children.length : 1;
                const layoutWidth = viewportState ? viewportState.layoutWidth : null;
                const toolbarHeight = viewportState ? viewportState.toolbarHeight || 0 : 0;
                const remoteSize = viewportService.getRemoteSize(main.offsetWidth, main.offsetHeight, rows,
                    rows === lastRemoteRows && columns === lastRemoteColumns && layoutWidth === lastLayoutWidth
                            && toolbarHeight === lastToolbarHeight
                        ? lastRemoteSize : null);
                if (remoteSize) {
                    lastRemoteSize = remoteSize;
                    lastRemoteRows = rows;
                    lastRemoteColumns = columns;
                    lastLayoutWidth = layoutWidth;
                    lastToolbarHeight = toolbarHeight;

                    // Preserve the first known usable viewport for the initial
                    // handshake. Wait for native controls to finish measuring.
                    if (!connectionRequested) {
                        connectionRequested = true;
                        ManagedClient.connect($scope.client, remoteSize.width, remoteSize.height);
                    }

                    const size = ClientResizeQueue.normalize(remoteSize.width, remoteSize.height,
                        $window.devicePixelRatio || 1, $scope.client.protocol === 'rdp');
                    resizeQueue.request(size.width, size.height);
                }

            }

            $scope.$evalAsync(() => {
                updateDisplayScale();
                updateSmartPan();
                rebaseRelativePointer();
            });

        };

        // A monitor/DPI transition can change devicePixelRatio while CSS
        // dimensions stay unchanged, which the element sensor cannot detect.
        $window.addEventListener('resize', $scope.mainElementResized);

        // Inset changes can occur without a DOM size change (for example when
        // browser chrome settles after dismissal). Wait for viewport styles to
        // apply, coalescing notifications within the same Angular turn.
        let viewportResizeScheduled = false;
        let viewportListenerActive = true;
        const stopViewportListener = viewportService.subscribe(function(state) {
            viewportState = state;
            // Observe focus transitions synchronously, including a Show action
            // which briefly blurs/refocuses during the same Angular turn.
            updateSmartPanState();
            if (client)
                updateDisplayOverflow($scope.client.clientProperties.scale);
            if (viewportListenerActive && !viewportResizeScheduled) {
                viewportResizeScheduled = true;
                $scope.$evalAsync(function() {
                    viewportResizeScheduled = false;
                    if (viewportListenerActive)
                        $scope.mainElementResized();
                });
            }
        });

        $scope.$watch('client.clientProperties.focused', function focusedClientChanged() {
            $scope.$evalAsync(updateSmartPan);
        });

        $scope.$watch(() => nativeKeyboard.enabled && !nativeKeyboard.panning,
            rebaseRelativePointer);

        // Scroll client display if absolute mouse is in use (the same drag
        // gesture is needed for moving the mouse pointer with relative mouse)
        $scope.clientDrag = function clientDrag(inProgress, startX, startY, currentX, currentY, deltaX, deltaY) {

            // Native input has explicit local gesture ownership. Its Pan tool
            // handles navigation; disabling Pan restores remote touch input.
            if (nativeKeyboard.enabled)
                return false;

            if ($scope.emulateAbsoluteMouse) {
                $scope.client.clientProperties.scrollLeft -= deltaX;
                $scope.client.clientProperties.scrollTop -= deltaY;
            }

            return false;

        };

        /**
         * If a pinch gesture is in progress, the scale of the client display when
         * the pinch gesture began.
         *
         * @type Number
         */
        let initialScale = null;

        /**
         * If a pinch gesture is in progress, the X coordinate of the point on the
         * client display that was centered within the pinch at the time the
         * gesture began.
         * 
         * @type Number
         */
        let initialCenterX = 0;

        /**
         * If a pinch gesture is in progress, the Y coordinate of the point on the
         * client display that was centered within the pinch at the time the
         * gesture began.
         * 
         * @type Number
         */
        let initialCenterY = 0;

        // Zoom and pan client via pinch gestures
        $scope.clientPinch = function clientPinch(inProgress, startLength, currentLength, centerX, centerY) {

            // The capture-phase Pan tool performs native-input zoom directly.
            // Do not let bubbling legacy pinch/drag handlers navigate the view
            // while the user has selected remote pointer control instead.
            if (nativeKeyboard.enabled) {
                initialScale = null;
                return false;
            }

            // Do not handle pinch gestures if they would conflict with remote
            // handling of similar gestures
            if ($scope.client.multiTouchSupport > 1)
                return false;

            // Do not handle pinch gestures while relative mouse is in use (2+
            // contact point gestures are used by relative mouse emulation to
            // support right click, middle click, and scrolling)
            if (!$scope.emulateAbsoluteMouse)
                return false;

            // Stop gesture if not in progress
            if (!inProgress) {
                initialScale = null;
                return false;
            }

            // Set initial scale if gesture has just started
            if (!initialScale) {
                initialScale   = $scope.client.clientProperties.scale;
                initialCenterX = (centerX + $scope.client.clientProperties.scrollLeft) / initialScale;
                initialCenterY = (centerY + $scope.client.clientProperties.scrollTop)  / initialScale;
            }

            // Determine new scale absolutely
            let currentScale = initialScale * currentLength / startLength;

            // Fix scale within limits - scroll will be miscalculated otherwise
            currentScale = Math.max(currentScale, $scope.client.clientProperties.minScale);
            currentScale = Math.min(currentScale, $scope.client.clientProperties.maxScale);

            // Update scale based on pinch distance
            $scope.client.clientProperties.autoFit = false;
            $scope.client.clientProperties.scale = currentScale;

            // Scroll display to keep original pinch location centered within current pinch
            $scope.client.clientProperties.scrollLeft = initialCenterX * currentScale - centerX;
            $scope.client.clientProperties.scrollTop  = initialCenterY * currentScale - centerY;

            return false;

        };

        // Ensure focus is regained via mousedown before forwarding event
        const focusBody = document.body.focus.bind(document.body);
        mouse.on('mousedown', focusBody);

        // Forward all mouse events
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], handleMouseEvent);

        // Hide software cursor when mouse leaves display
        const hideCursor = function hideCursor() {
            if (!display) return;
            display.showCursor(false);
        };
        mouse.on('mouseout', hideCursor);

        // Update remote clipboard if local clipboard changes
        $scope.$on('guacClipboard', function onClipboard(event, data) {
            if (client)
                ManagedClient.setClipboard($scope.client, data);
        });

        /** Adds keyboard input to the same ordered clipboard gate as clicks. */
        const sendKey = function sendKey(pressed, keysym) {
            const targetClient = client;
            if (targetClient)
                inputQueue.enqueue(() => targetClient.sendKeyEvent(pressed, keysym));
        };

        // Translate local keydown events to remote keydown events if keyboard is enabled
        $scope.$on('guacKeydown', function keydownListener(event, keysym, keyboard) {
            if (client && $scope.client.clientProperties.focused) {
                sendKey(1, keysym);
                event.preventDefault();
            }
        });
        
        // Translate local keyup events to remote keyup events if keyboard is enabled
        $scope.$on('guacKeyup', function keyupListener(event, keysym, keyboard) {
            if (client && $scope.client.clientProperties.focused) {
                sendKey(0, keysym);
                event.preventDefault();
            }   
        });

        // Universally handle all synthetic keydown events
        $scope.$on('guacSyntheticKeydown', function syntheticKeydownListener(event, keysym) {
            if (client && $scope.client.clientProperties.focused)
                sendKey(1, keysym);
        });
        
        // Universally handle all synthetic keyup events
        $scope.$on('guacSyntheticKeyup', function syntheticKeyupListener(event, keysym) {
            if (client && $scope.client.clientProperties.focused)
                sendKey(0, keysym);
        });

        // Track clipboard synchronization status
        const stopClipboardSyncListener = $rootScope.$on('clipboardSyncInProgress', function clipboardSyncStatus(event, status) {
            // A gesture begun during clipboard synchronization must not replay
            // old wheel motion after the gate opens. Own it through release.
            clipboardBlocked = !!status;
            remoteScroll.cancel();
            inputQueue.setBlocked(status);
        });

        $scope.$on('$destroy', function destroyClientInput() {
            inputViewActive = false;
            stopClipboardSyncListener();
            stopNativeInputListener();
            viewportListenerActive = false;
            stopViewportListener();
            localPan.dispose();
            remoteScroll.dispose();
            smartPan.dispose();
            inputQueue.dispose();
            resizeQueue.dispose();
            $window.removeEventListener('resize', $scope.mainElementResized);
            client = null;
            display = null;
            mouse.off('mousedown', focusBody);
            mouse.off('mouseout', hideCursor);
            mouse.offEach(['mousedown', 'mousemove', 'mouseup'], handleMouseEvent);
            touchScreen.offEach(['mousedown', 'mousemove', 'mouseup'], handleEmulatedMouseEvent);
            touchPad.offEach(['mousedown', 'mousemove', 'mouseup'], handleTouchpadMouseEvent);
            touch.offEach(['touchstart', 'touchmove', 'touchend'], handleTouchEvent);
        });

        /**
         * Whether a drag/drop operation is currently in progress (the user has
         * dragged a file over the Guacamole connection but has not yet
         * dropped it).
         *
         * @type boolean
         */
        $scope.dropPending = false;
            
        /**
         * Displays a visual indication that dropping the file currently
         * being dragged is possible. Further propagation and default behavior
         * of the given event is automatically prevented.
         * 
         * @param {Event} e
         *     The event related to the in-progress drag/drop operation.
         */
        const notifyDragStart = function notifyDragStart(e) {

            e.preventDefault();
            e.stopPropagation();

            $scope.$apply(() => {
                $scope.dropPending = true;
            });

        };

        /**
         * Removes the visual indication that dropping the file currently
         * being dragged is possible. Further propagation and default behavior
         * of the given event is automatically prevented.
         * 
         * @param {Event} e
         *     The event related to the end of the former drag/drop operation.
         */
        const notifyDragEnd = function notifyDragEnd(e) {

            e.preventDefault();
            e.stopPropagation();

            $scope.$apply(() => {
                $scope.dropPending = false;
            });

        };

        main.addEventListener('dragenter', notifyDragStart, false);
        main.addEventListener('dragover',  notifyDragStart, false);
        main.addEventListener('dragleave', notifyDragEnd,   false);

        // File drop event handler
        main.addEventListener('drop', function(e) {

            notifyDragEnd(e);

            // Ignore file drops if no attached client
            if (!$scope.client)
                return;

            // Upload each file 
            const files = e.dataTransfer.files;
            for (let i = 0; i < files.length; i++)
                ManagedClient.uploadFile($scope.client, files[i]);

        }, false);

    }];

    return directive;

}]);
