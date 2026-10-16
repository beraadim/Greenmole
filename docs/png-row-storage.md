# PNG row storage and error cleanup

Private.9 preserves the PNG format and compression policy while reducing
Guacamole-owned allocation calls for an indexed image of height H from H+1 row
allocations to one. The existing palette allocation is separate and unchanged.
The single block contains an aligned H-entry row-pointer table followed by
H*width bytes of unpacked palette indices. Checked addition and multiplication
validate the allocation size before its contents are accessed.

This retains the existing `png_write_png()` call, `PNG_TRANSFORM_PACKING`, palette
insertion order, 1/2/4/8-bit depth thresholds, non-interlaced layout, libpng
compression/filter defaults and output buffering. RGB24's unused high byte is
still masked off. High-color and non-RGB24 surfaces continue to use Cairo's PNG
writer. No single-row streaming, persistent image cache, compression-level
change, palette approximation or pixel-quality change is introduced.

The block is acquired before libpng setup and before `setjmp()`. Its automatic
pointer is not changed during libpng calls, so a `longjmp()` cannot render the
cleanup pointer indeterminate. Both libpng creation failures and the longjmp
error branch free the row block and palette. Successful writes free the same
block once instead of freeing each row separately. Previously a libpng longjmp
leaked the row-pointer table and each already allocated row; allocation failure
could also lead to an unchecked pointer dereference. Palette creation now
checks its own allocation before accessing it, allowing the caller's existing
Cairo fallback on a null palette. Both touched row scans avoid advancing an
unused source pointer past the backing allocation when a nonzero-X
subrectangle reaches its parent surface's bottom row.

Eight focused native regressions compile the production PNG/palette code with
fault injection around allocation, libpng creation and output. Real libpng and
Cairo perform encoding and decoding. Successful cases compare the complete
concatenated encoded PNG payload byte for byte against a compatibility encoder
using private.8's separate-per-row staging and the installed library defaults;
this avoids golden data tied to a specific libpng/zlib version. They also decode
every pixel independently, verify PNG depth/color type, ensure the original
surface and surrounding padding are unchanged, and assert a constant row-block
allocation count.

Coverage includes exact palette sizes 1,2,3,4,5,16,17,255,256, an odd row width,
padded source stride, nonzero source-buffer origin reaching the parent bottom row, varied unused RGB24 high
bytes, a tall indexed image, and unchanged 257-color/ARGB32 Cairo fallbacks.
Fault tests verify no tracked allocations remain after row/palette allocation
failure, either libpng creation failure, or real libpng longjmps before and
after output begins, including a late IDAT error after an actual blob send. These unit tests do not establish an end-to-end speedup.
Matched optimized production/browser measurements remain the performance gate,
and high-color photo PNGs use the unchanged Cairo path.
