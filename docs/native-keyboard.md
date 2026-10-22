# Native device keyboard

Greenmole can use the keyboard provided by iPadOS and other devices instead of
the built-in Guacamole keyboard layout.

1. Open the Greenmole connection menu.
2. Under **Input method**, select **Native keyboard**.
3. Tap **Show keyboard** in the keyboard control bar. Type using the device's
   keyboard. **Show keyboard** is now a toggle: its green pressed indicator
   reflects the current opening, and tapping it again hides the keyboard.
   Confirmed device-keyboard dismissal also clears the indicator, including when
   iOS leaves the editor focused. A later tap deliberately reopens it.
4. **Show keyboard** enables **Pan desktop**. Drag in either direction to bring
   more of the remote screen into view, and pinch with two fingers to zoom the
   desktop around their midpoint. Turn Pan desktop off to operate the remote
   application while keeping the keyboard open and the chosen zoom. Hiding the
   keyboard or leaving the native editor turns panning off. When the browser reports the
   normal viewing area restored after its software keyboard was visible,
   panning also turns off even if the editor still has focus, as can happen
   with the iPad keyboard's dismiss button. Show keyboard enables it again.
5. **Scroll wheel** replaces the separate Hide button. Select it and drag with
   one finger to scroll the remote application at the pointer. It sends wheel
   movement rather than clicks or local desktop panning. Finger movement up
   scrolls down, and movement left scrolls right. Horizontal scrolling is enabled
   for RDP servers that advertise horizontal wheel support; other protocols keep
   their existing vertical scrolling. Pan/zoom and Scroll wheel are mutually
   exclusive. Two-finger contacts are suppressed in Scroll mode.

New iOS browser preferences default to **Native keyboard** and **Touchpad** mouse
mode, where dragging moves the remote pointer. Detection includes iPhone, iPod
touch and iPad using mobile or desktop browsing mode. Upgrading an existing iOS
browser initializes Touchpad mode once, replacing the old automatically saved
Touchscreen default. An independent one-time keyboard migration replaces a
legacy saved **None** preference with Native keyboard, including on iPhone.
Existing Text input and On-screen keyboard selections are preserved. Later
explicit choices, including switching back to None, survive reload. Unrelated
preferences remain unchanged. The native keyboard option remains available
manually on other devices.

The control bar remains available after the device keyboard is dismissed. Use
**Show keyboard** to reopen it, including after using the keyboard's own dismiss
button. Ctrl, Alt, Esc and Tab remain available for remote keyboard commands.
An attached hardware keyboard remains usable.

Scroll wheel can also be selected while the software keyboard is hidden. Hiding
via the Show toggle, blurring the editor, changing input mode or opening Settings
clears the selected touch tools. An OS dismissal which retains editor focus
clears the keyboard indicator and automatic Pan but leaves an explicitly chosen
Scroll tool available. Switching between tools cancels the current gesture;
lift all fingers and start a fresh drag. Scroll input uses bounded wheel pulses
without momentum. Clipboard synchronization, disconnect and teardown cancel
pending wheel movement rather than replaying stale gestures later.

Tap **Settings** (the gear button on narrow screens) in this bar to open the
connection settings panel, including display, input and clipboard options.
Opening settings dismisses the device keyboard and turns Pan desktop off;
closing settings leaves the keyboard hidden until you tap **Show keyboard**.

The control bar reserves its measured height in the layout. The remote desktop
is sized to the usable area above it, including when the bar wraps on a narrow
screen. Every input mode, including None, uses the browser's visible viewport
so browser controls do not hide the bottom of the desktop. Opening the device's
software keyboard then clips this desktop locally
without changing its resolution or zoom. You can pan to its bottom in the space
above the keyboard. Changing input mode, permanent control-bar height, rotation,
multitasking width or tiled connection layout can resize the remote desktop.
Pinching the desktop while Pan is on changes only its local zoom; it does not
change the remote resolution or reconnect the session. Browser page zoom remains
available outside this gesture area. Floating keyboards and attached hardware
keyboards may leave the visible area unchanged.

While Pan desktop is enabled, opening the keyboard scrolls just enough to reveal
the last remote click, or a known pointer position if there has been no click.
This gives typing a useful starting position without changing zoom. A manual
drag, pinch or scroll takes control for the rest of that keyboard opening, so
later keyboard animation or typing does not pull the view back. Pan gestures move
only the local view and do not click, drag or scroll the remote application.
After zooming, drag left/right as well as up/down to navigate the desktop. With
Native keyboard enabled and Pan off, the pointer stays inside the visible part
of the desktop instead of scrolling the view as it reaches an edge. Turn Pan on
again to navigate to another part of the desktop.

This mode does not detect focused text fields or the text caret inside remote
applications. The click/pointer hint can differ from the actual insertion point;
use Pan desktop to adjust it when needed.
Opening the keyboard requires a deliberate local tap, subject to the browser
and operating system's keyboard behavior. Text input is forwarded to the
remote session and is not retained in the native keyboard bar's visible text
history or saved in browser preferences.
