#include "../../shim/armv84.h"
#include "cases.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { ROUNDS = 20000, REGION = 1024 };

static uint32_t word_at(const void *code) {
    uint32_t word;
    memcpy(&word, code, sizeof word);
    return word;
}

static int check_vector(const struct vector_case *test, uint64_t *seed) {
    uint32_t instruction = word_at(test->instruction);
    for (int round = 0; round < ROUNDS; round++) {
        uint64_t x[31];
        uint64_t sp = 0;
        armv84_vector v[32];
        fill_random(seed, x, sizeof x);
        fill_random(seed, v, sizeof v);
        struct armv84_cpu cpu = {x, &sp, v};
        uint8x16_t input[4];
        for (int index = 0; index < 4; index++)
            memcpy(&input[index], &v[test->first_register + index], 16);
        uint8x16_t expected = test->run(input[0], input[1], input[2], input[3]);
        if (armv84_emulate(instruction, &cpu) == ARMV84_NONE || memcmp(&expected, &v[test->first_register], 16)) {
            fprintf(stderr, "FAIL %s (%08x) round %d\n", test->name, instruction, round);
            return 1;
        }
    }
    return 0;
}

static int check_memory(const struct memory_case *test, uint64_t *seed) {
    uint32_t instruction = word_at((const void *)test->run);
    for (int round = 0; round < ROUNDS; round++) {
        _Alignas(16) uint8_t native[REGION], emulated[REGION];
        fill_random(seed, native, sizeof native);
        memcpy(emulated, native, sizeof native);
        uint64_t value = next_random(seed);
        uint64_t x[31];
        uint64_t sp = 0;
        armv84_vector v[32];
        fill_random(seed, x, sizeof x);
        fill_random(seed, v, sizeof v);
        x[0] = value;
        x[1] = (uint64_t)(emulated + REGION / 2);
        struct armv84_cpu cpu = {x, &sp, v};
        uint64_t expected = test->run(value, native + REGION / 2);
        int handled = armv84_emulate(instruction, &cpu) == ARMV84_RCPC2;
        uint64_t result = test->stores ? expected : x[test->result_in_base ? 1 : 0];
        if (!handled || result != expected || memcmp(native, emulated, sizeof native)) {
            fprintf(stderr, "FAIL %s (%08x) round %d: %llx, expected %llx\n", test->name, instruction, round,
                    (unsigned long long)result, (unsigned long long)expected);
            return 1;
        }
    }
    return 0;
}

static int check_stack(uint64_t *seed) {
    for (int round = 0; round < ROUNDS; round++) {
        uint64_t frame[6] = {0};
        uint64_t x[31] = {0};
        uint64_t sp = (uint64_t)frame;
        armv84_vector v[32];
        struct armv84_cpu cpu = {x, &sp, v};
        uint64_t value = next_random(seed);
        frame[5] = value;
        if (armv84_emulate(word_at(load_stack_at), &cpu) != ARMV84_RCPC2 || x[0] != load_stack(value)) {
            fprintf(stderr, "FAIL load_stack round %d\n", round);
            return 1;
        }
        x[0] = value ^ 0x5555;
        if (armv84_emulate(word_at(store_stack_at), &cpu) != ARMV84_RCPC2 || frame[3] != store_stack(value ^ 0x5555)) {
            fprintf(stderr, "FAIL store_stack round %d\n", round);
            return 1;
        }
    }
    return 0;
}

int main(void) {
    uint64_t seed = 0x9E3779B97F4A7C15ull;
    int failures = 0;
    unsigned vectors = sizeof vector_cases / sizeof vector_cases[0];
    unsigned memories = sizeof memory_cases / sizeof memory_cases[0];
    for (unsigned index = 0; index < vectors; index++)
        failures += check_vector(&vector_cases[index], &seed);
    for (unsigned index = 0; index < memories; index++)
        failures += check_memory(&memory_cases[index], &seed);
    failures += check_stack(&seed);
    printf("%u vector and %u memory instructions plus 2 on the stack, %d rounds each: %d failed\n",
           vectors, memories, ROUNDS, failures);
    return failures != 0;
}
