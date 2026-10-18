# Native device keyboard

Greenmole can use the keyboard provided by iPadOS and other devices instead of
the built-in Guacamole keyboard layout.

1. Open the Greenmole connection menu.
2. Under **Input method**, select **Native keyboard**.
3. Tap **Show keyboard** in the keyboard control bar. Type using the device's
   keyboard, and use **Hide keyboard** when finished.

The selection is remembered in the current browser and can also be changed in
its default input preferences. An iPad recommendation recognizes both mobile
and desktop browsing modes. The option remains available manually on other
devices; detection does not force a different input method on existing users.

The control bar remains available after the device keyboard is dismissed. Use
**Show keyboard** to reopen it, including after using the keyboard's own dismiss
button. Ctrl, Alt, Esc and Tab remain available for remote keyboard commands.
An attached hardware keyboard remains usable.

When the browser reports a smaller visible area for its keyboard, Greenmole
adjusts its local view and preserves the remote desktop's resolution. Opening
and closing the keyboard does not repeatedly resize the remote desktop.
Browser pinch zoom remains under user control. Floating keyboards and attached
hardware keyboards may leave the visible area unchanged.

This mode does not detect focused text fields inside remote applications.
Opening the keyboard requires a deliberate local tap, subject to the browser
and operating system's keyboard behavior. Text input is forwarded to the
remote session and is not retained in the native keyboard bar's visible text
history or saved in browser preferences.
