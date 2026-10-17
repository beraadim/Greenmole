/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/* External primitive declarations contain platform extensions. */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <freerdp/codec/color.h>
#include <freerdp/primitives.h>
#include <winpr/crt.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include <CUnit/CUnit.h>
#include <stdlib.h>
#include <string.h>

/**
 * Exercise the installed dependency, rather than a copy of the SIMD code.
 * Distinct per-row/column values cover horizontal and vertical chroma details.
 * Width 62 also covers the scalar tail after the vector loop. Both chroma
 * versions share the inverse filter, so each must match its scalar oracle.
 */
void test_avc444_primitives__optimized_chroma_matches_scalar_pixels_and_v2() {
    enum { STRIDE = 64, HEIGHT = 48, PLANE = STRIDE * HEIGHT };
    BYTE* storage = _aligned_malloc(20 * PLANE, 16);
    CU_ASSERT_PTR_NOT_NULL_FATAL(storage);
    const BYTE* main[3] = { storage, storage + PLANE, storage + 2 * PLANE };
    const BYTE* auxiliary[3] = { storage + 3 * PLANE, storage + 4 * PLANE,
        storage + 5 * PLANE };
    BYTE* actual[3] = { storage + 6 * PLANE, storage + 7 * PLANE, storage + 8 * PLANE };
    BYTE* expected[3] = { storage + 9 * PLANE, storage + 10 * PLANE, storage + 11 * PLANE };
    BYTE* actual_rgb = storage + 12 * PLANE;
    BYTE* expected_rgb = storage + 16 * PLANE;
    const UINT32 src_stride[3] = { STRIDE, STRIDE / 2, STRIDE / 2 };
    const UINT32 dst_stride[3] = { STRIDE, STRIDE, STRIDE };
    primitives_t* optimized = primitives_get();
    primitives_t* scalar = primitives_get_generic();
    CU_ASSERT_PTR_NOT_NULL_FATAL(optimized);
    CU_ASSERT_PTR_NOT_NULL_FATAL(scalar);
    for (unsigned int i = 0; i < 6 * PLANE; i++)
        storage[i] = 80 + ((i % STRIDE) * 7 + (i / STRIDE) * 11) % 75;
    for (unsigned int version = 1; version <= 2; version++) {
        for (unsigned int tail = 0; tail <= 1; tail++) {
            const unsigned int width = tail ? 62 : 64;
            const unsigned int height = tail ? 30 : 32;
            RECTANGLE_16 rect = { .right = width, .bottom = height };
            prim_size_t size = { .width = width, .height = height };
            memset(actual[0], 0xCC, 3 * PLANE);
            memset(expected[0], 0xCC, 3 * PLANE);
            CU_ASSERT_EQUAL(optimized->YUV420CombineToYUV444(AVC444_LUMA,
                main, src_stride, STRIDE, 32, actual, dst_stride, &rect), PRIMITIVES_SUCCESS);
            CU_ASSERT_EQUAL(scalar->YUV420CombineToYUV444(AVC444_LUMA,
                main, src_stride, STRIDE, 32, expected, dst_stride, &rect), PRIMITIVES_SUCCESS);
            avc444_frame_type type = version == 1 ? AVC444_CHROMAv1 : AVC444_CHROMAv2;
            CU_ASSERT_EQUAL(optimized->YUV420CombineToYUV444(type,
                auxiliary, src_stride, STRIDE, 32, actual, dst_stride, &rect), PRIMITIVES_SUCCESS);
            CU_ASSERT_EQUAL(scalar->YUV420CombineToYUV444(type,
                auxiliary, src_stride, STRIDE, 32, expected, dst_stride, &rect), PRIMITIVES_SUCCESS);
            for (unsigned int p = 0; p < 3; p++)
                for (unsigned int y = 0; y < height; y++)
                    CU_ASSERT_EQUAL(memcmp(actual[p] + y * STRIDE,
                        expected[p] + y * STRIDE, width), 0);
            if (version == 1) {
                /* B6/B7 samples belong at odd columns on even rows. The bad
                 * SIMD stores overwrote the even-column average instead. */
                for (unsigned int p = 1; p < 3; p++)
                    for (unsigned int y = 0; y < height / 2; y++)
                        for (unsigned int x = 0; x < width / 2; x++)
                            CU_ASSERT_EQUAL(actual[p][2 * y * STRIDE + 2 * x + 1],
                                auxiliary[p][y * STRIDE / 2 + x]);
            }
            const BYTE* actual_const[3] = { actual[0], actual[1], actual[2] };
            const BYTE* expected_const[3] = { expected[0], expected[1], expected[2] };
            CU_ASSERT_EQUAL(optimized->YUV444ToRGB_8u_P3AC4R(actual_const, dst_stride,
                actual_rgb, STRIDE * 4, PIXEL_FORMAT_BGRA32, &size), PRIMITIVES_SUCCESS);
            CU_ASSERT_EQUAL(scalar->YUV444ToRGB_8u_P3AC4R(expected_const, dst_stride,
                expected_rgb, STRIDE * 4, PIXEL_FORMAT_BGRA32, &size), PRIMITIVES_SUCCESS);
            /* Scalar/SIMD fixed-point rounding may differ by one unit. */
            for (unsigned int y = 0; y < height; y++)
                for (unsigned int x = 0; x < width; x++)
                    for (unsigned int channel = 0; channel < 3; channel++) {
                        size_t offset = y * STRIDE * 4 + x * 4 + channel;
                        CU_ASSERT(abs((int) actual_rgb[offset] - expected_rgb[offset]) <= 2);
                    }
        }
    }
    _aligned_free(storage);
}
