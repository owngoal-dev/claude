#ifndef CLAUDE_SHIM_ARMV84_H
#define CLAUDE_SHIM_ARMV84_H

#include <stdint.h>

typedef __uint128_t armv84_vector;

struct armv84_cpu {
    uint64_t *x;
    uint64_t *sp;
    armv84_vector *v;
};

enum armv84_extension {
    ARMV84_NONE,
    ARMV84_RCPC2,
    ARMV84_DOT_PRODUCT,
    ARMV84_SHA3,
    ARMV84_SHA512,
    ARMV84_EXTENSION_COUNT,
};

#pragma GCC visibility push(hidden)
enum armv84_extension armv84_classify(uint32_t instruction);
enum armv84_extension armv84_emulate(uint32_t instruction, struct armv84_cpu *cpu);
#pragma GCC visibility pop

#endif
