# Keyboard layouts and shortcut preferences

Greenmole forwards browser characters, composed text and modifier keys using
Guacamole keysyms. Guacd converts them into the connection's **Keyboard layout**
(`server-layout`) and advertises that Windows layout ID to the RDP host. This
setting describes the RDP transport layout, not the browser's language.
Characters absent from that layout use Unicode events.

For Greenmole RDP, leaving the connection layout blank retains the working US
transport layout (`en-us-qwerty`). The Mac's own layout and the browser's layout
can remain Norwegian. Greenmole RDP 0.1.32 additionally understands its supported
advertised layouts directly. Keep existing settings unless a particular layout
is needed. The old `nb-no-qwerty` spelling is accepted as an alias of
`no-no-qwerty`; both describe the same Norwegian keyboard. An unknown layout
logs a warning and retains the established US fallback.

## Shortcut preferences

In the connection menu's **Input method** section, **Greenmole RDP shortcuts**
selects a preference saved in this browser for the next connection:

- **Automatic (this device)** chooses native Mac shortcuts on macOS/iOS/iPadOS
  and Windows-friendly shortcuts elsewhere. Detection never guesses language.
- **Windows-friendly** preserves the existing Windows keyboard experience,
  including Greenmole RDP's Ctrl-to-Command editing conveniences.
- **Native Mac** retains Command and Option semantics and genuine Control chords.
- **Keep Control shortcuts** uses standard PC-to-Mac modifier identities
  (Alt to Option, Windows to Command) without Ctrl-to-Command substitution.
  It does not disable text-layout translation.

Changes require disconnect/reconnect, preventing a policy change while a key
is held. An administrator can override the browser with the connection's
`greenmole-keyboard-mode` parameter (`windows`, `mac`, or `physical`). Blank or
`auto` uses the browser preference. An explicit host policy takes final priority.
This preference requires Greenmole RDP 0.1.32 or later; it does not remap keys in
Greenmole itself or change ordinary Windows RDP key events. Browser/OS-reserved
shortcuts may still be unavailable to web applications.

## Compatibility and protocol

`GUAC_KEYBOARD_MODE` accepts only the resolved values `windows`, `mac`, and
`physical`. It is copied into client information, not arbitrary connection
configuration. The configured socket supplies it only for an RDP connection
whose guacd requests the optional `greenmole-keyboard-mode` argument. An older
guacd therefore ignores the extension. Existing authenticated connections and
shared-session owners retain their established input policy.

Guacd advertises the hint through the OEM-dependent `keyboardSubType` field in
RDP Client Core Data, as a Greenmole virtual keyboard convention:

| Hint | Exact subtype |
| --- | --- |
| Windows-friendly | `0x474D0101` |
| Native Mac | `0x474D0102` |
| Keep Control shortcuts | `0x474D0103` |

The prefix/version/mode values are exact, not bit masks. Missing or unsupported
modes leave FreeRDP's existing subtype unchanged. The hint carries no authority
and cannot alter authentication, desktop ownership, or security decisions.
Greenmole RDP accepts recognized values only for shortcut policy when its own
setting is automatic; other/older hosts need not interpret them. Layout IDs,
client names, AVC negotiation and outgoing key codes are unaffected.
See [MS-RDPBCGR Client Core Data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/00f1da4a-ee9c-421a-852f-c19f92343d73).

The Unicode-only `failsafe` layout is not a shortcut fix: because it omits normal
letter scancodes, some applications cannot recognize Control/Command chords.
The existing combination of scancodes, modifier tracking and Unicode text is
preserved.

## Validation

Focused tests exercise browser Auto/explicit preference persistence, locale
independence, Java request allowlisting and real optional-argument handshake,
administrator precedence, legacy daemon compatibility, native alias lookup,
content-free warnings and exact OEM subtype decoding. Existing native-keyboard
cases cover composition, Unicode codepoints, Ctrl/Command pass-through and
key release. Physical Windows/macOS browser and native RDP acceptance remains
necessary for layout/host-application combinations.


The French AltGr dead accents and German literal AltGr keys agree with
Microsoft's [French keyboard layout sample](https://github.com/microsoft/Windows-driver-samples/blob/main/input/layout/all_kbds/kbdfr/kbdfr.c)
and [German keyboard layout sample](https://github.com/microsoft/Windows-driver-samples/blob/main/input/layout/all_kbds/kbdgr/kbdgr.c).
French AltGr+2/7 produce dead tilde/grave; German AltGr+ß is a backslash,
while AltGr++ is a literal tilde. These correct inconsistencies in the inherited
Guacamole maps and keep the advertised Windows layout consistent with the host.
Supplementary Unicode characters (including many emoji) and full input-method
composition are outside this layout/shortcut change and remain separately unverified.
