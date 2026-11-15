#ifndef CLAUDE_TESTS_ARMV84_CASES_H
#define CLAUDE_TESTS_ARMV84_CASES_H

#include <arm_neon.h>
#include <stdint.h>

typedef uint8x16_t vector_stub(uint8x16_t, uint8x16_t, uint8x16_t, uint8x16_t);
typedef uint64_t memory_stub(uint64_t, void *);

struct vector_case {
    const char *name;
    vector_stub *run;
    const void *instruction;
    unsigned first_register;
};

struct memory_case {
    const char *name;
    memory_stub *run;
    int stores;
    int result_in_base;
};

#define VECTOR(name) extern vector_stub name;
#define VECTOR_HIGH(name) extern vector_stub name; extern const char name##_at[];
#define MEMORY(name, stores, result_in_base) extern memory_stub name;
#include "cases.inc"
#undef VECTOR
#undef VECTOR_HIGH
#undef MEMORY

extern uint64_t load_stack(uint64_t);
extern uint64_t store_stack(uint64_t);
extern const char load_stack_at[], store_stack_at[];

static const struct vector_case vector_cases[] = {
#define VECTOR(name) {#name, name, (const void *)name, 0},
#define VECTOR_HIGH(name) {#name, name, name##_at, 19},
#define MEMORY(name, stores, result_in_base)
#include "cases.inc"
#undef VECTOR
#undef VECTOR_HIGH
#undef MEMORY
};

static const struct memory_case memory_cases[] = {
#define VECTOR(name)
#define VECTOR_HIGH(name)
#define MEMORY(name, stores, result_in_base) {#name, name, stores, result_in_base},
#include "cases.inc"
#undef VECTOR
#undef VECTOR_HIGH
#undef MEMORY
};

static inline uint64_t next_random(uint64_t *state) {
    uint64_t value = *state;
    value ^= value << 13;
    value ^= value >> 7;
    value ^= value << 17;
    return *state = value;
}

static inline void fill_random(uint64_t *state, void *bytes, unsigned count) {
    uint8_t *cursor = bytes;
    for (unsigned index = 0; index < count; index++)
        cursor[index] = (uint8_t)(next_random(state) >> 24);
}

#endif
