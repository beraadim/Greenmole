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

/* Run the actual encoder's existing independent-pixel/payload/fault fixtures
 * under each benchmark setting. Compile this isolated runner with the helper,
 * real Cairo/libpng/CUnit and the image's libguac. No installed test/production
 * policy or native gate is modified. */
#include "png-compression-control.h"
#ifndef GUAC_PNG_TEST_SOURCE
#define GUAC_PNG_TEST_SOURCE "../../server/src/libguac/tests/encode/png.c"
#endif
#include GUAC_PNG_TEST_SOURCE
#include <CUnit/Basic.h>

#define PNG_TEST(name) { #name, name }

int main(int argc, char** argv) {
    if (argc != 4)
        return 2;
    if (benchmark_png_control_initialize(NULL, "default", "default")
            || benchmark_png_control_initialize("2", "default", "default")
            || benchmark_png_control_initialize("default", "invalid", "default")
            || benchmark_png_control_initialize("default", "default", "invalid"))
        return 1;
    if (!benchmark_png_control_initialize(argv[1], argv[2], argv[3]))
        return 2;
    if (benchmark_png_control_initialize(argv[1], argv[2], argv[3]))
        return 1;
    if (CU_initialize_registry() != CUE_SUCCESS)
        return 1;
    CU_pSuite suite = CU_add_suite("PNG compression study", NULL, NULL);
    const struct { const char* name; void (*function)(void); } tests[] = {
        PNG_TEST(test_encode_png__fused_palette_order_collisions_and_signed_stride),
        PNG_TEST(test_encode_png__palette_growth_after_prefix_preserves_packing),
        PNG_TEST(test_encode_png__speculation_bound_includes_row_table),
        PNG_TEST(test_encode_png__large_high_color_fallback_does_not_stage_indices),
        PNG_TEST(test_encode_png__speculative_oom_preflights_and_retries_safely),
        PNG_TEST(test_encode_png__speculative_and_final_oom_cleans_up),
        PNG_TEST(test_encode_png__palette_depths_match_legacy_payload),
        PNG_TEST(test_encode_png__tall_palette_uses_single_row_block),
        PNG_TEST(test_encode_png__cairo_fallback_payloads_unchanged),
        PNG_TEST(test_encode_png__row_allocation_failure_cleans_up),
        PNG_TEST(test_encode_png__palette_allocation_failure_uses_cairo),
        PNG_TEST(test_encode_png__libpng_creation_failure_cleans_up),
        PNG_TEST(test_encode_png__libpng_longjmp_cleans_up_rows),
        PNG_TEST(test_encode_png__libpng_longjmp_after_blob_cleans_up_rows)
    };
    if (suite == NULL)
        return 1;
    for (size_t i = 0; i < sizeof(tests) / sizeof(*tests); i++)
        if (CU_add_test(suite, tests[i].name, tests[i].function) == NULL)
            return 1;
    CU_basic_set_mode(CU_BRM_SILENT);
    CU_ErrorCode status = CU_basic_run_tests();
    unsigned int failures = CU_get_number_of_failures();
    CU_cleanup_registry();
    if (status != CUE_SUCCESS || failures) {
        fprintf(stderr, "PNG compression regression failures: %u\n", failures);
        return 1;
    }
    benchmark_png_statistics start = { 0 }, end = benchmark_png_control_snapshot();
    benchmark_png_control_json(stdout, &start, &end);
    putchar('\n');
    return 0;
}
