#include "armv84.h"

#include <stdatomic.h>
#include <string.h>

enum operation {
    NOT_EMULATED,
    ORDERED_UNSCALED,
    DOT_VECTORS,
    DOT_ELEMENT,
    EOR3,
    BCAX,
    RAX1,
    XAR,
    SHA512H,
    SHA512H2,
    SHA512SU0,
    SHA512SU1,
};

static enum operation decode(uint32_t instruction) {
    if ((instruction & 0x3F200C00) == 0x19000000) {
        unsigned size = instruction >> 30;
        unsigned variant = (instruction >> 22) & 3;
        if ((variant == 2 && size == 3) || (variant == 3 && size >= 2))
            return NOT_EMULATED;
        return ORDERED_UNSCALED;
    }
    if ((instruction & 0x9FE0FC00) == 0x0E809400)
        return DOT_VECTORS;
    if ((instruction & 0x9FC0F400) == 0x0F80E000)
        return DOT_ELEMENT;
    if ((instruction & 0xFFE08000) == 0xCE000000)
        return EOR3;
    if ((instruction & 0xFFE08000) == 0xCE200000)
        return BCAX;
    if ((instruction & 0xFFE0FC00) == 0xCE608C00)
        return RAX1;
    if ((instruction & 0xFFE00000) == 0xCE800000)
        return XAR;
    if ((instruction & 0xFFE0FC00) == 0xCE608000)
        return SHA512H;
    if ((instruction & 0xFFE0FC00) == 0xCE608400)
        return SHA512H2;
    if ((instruction & 0xFFE0FC00) == 0xCE608800)
        return SHA512SU1;
    if ((instruction & 0xFFFFFC00) == 0xCEC08000)
        return SHA512SU0;
    return NOT_EMULATED;
}

static enum armv84_extension extension_of(enum operation operation) {
    switch (operation) {
    case NOT_EMULATED: return ARMV84_NONE;
    case ORDERED_UNSCALED: return ARMV84_RCPC2;
    case DOT_VECTORS:
    case DOT_ELEMENT: return ARMV84_DOT_PRODUCT;
    case EOR3:
    case BCAX:
    case RAX1:
    case XAR: return ARMV84_SHA3;
    case SHA512H:
    case SHA512H2:
    case SHA512SU0:
    case SHA512SU1: return ARMV84_SHA512;
    }
    return ARMV84_NONE;
}

enum armv84_extension armv84_classify(uint32_t instruction) {
    return extension_of(decode(instruction));
}

static uint64_t rotate_right(uint64_t value, unsigned count) {
    count &= 63;
    return count ? (value >> count) | (value << (64 - count)) : value;
}

static uint64_t low(armv84_vector value) { return (uint64_t)value; }
static uint64_t high(armv84_vector value) { return (uint64_t)(value >> 64); }
static armv84_vector pair(uint64_t high_half, uint64_t low_half) {
    return ((armv84_vector)high_half << 64) | low_half;
}

static uint64_t general(const struct armv84_cpu *cpu, unsigned index) {
    return index == 31 ? 0 : cpu->x[index];
}

static uint64_t ordered_load(uintptr_t address, unsigned bytes) {
    uint64_t value = 0;
    if (address & (bytes - 1)) {
        memcpy(&value, (const void *)address, bytes);
        atomic_thread_fence(memory_order_seq_cst);
        return value;
    }
    switch (bytes) {
    case 1: return atomic_load_explicit((_Atomic uint8_t *)address, memory_order_acquire);
    case 2: return atomic_load_explicit((_Atomic uint16_t *)address, memory_order_acquire);
    case 4: return atomic_load_explicit((_Atomic uint32_t *)address, memory_order_acquire);
    default: return atomic_load_explicit((_Atomic uint64_t *)address, memory_order_acquire);
    }
}

static void ordered_store(uintptr_t address, unsigned bytes, uint64_t value) {
    if (address & (bytes - 1)) {
        atomic_thread_fence(memory_order_seq_cst);
        memcpy((void *)address, &value, bytes);
        atomic_thread_fence(memory_order_seq_cst);
        return;
    }
    switch (bytes) {
    case 1: atomic_store_explicit((_Atomic uint8_t *)address, (uint8_t)value, memory_order_release); break;
    case 2: atomic_store_explicit((_Atomic uint16_t *)address, (uint16_t)value, memory_order_release); break;
    case 4: atomic_store_explicit((_Atomic uint32_t *)address, (uint32_t)value, memory_order_release); break;
    default: atomic_store_explicit((_Atomic uint64_t *)address, value, memory_order_release); break;
    }
}

static void ordered_unscaled(uint32_t instruction, struct armv84_cpu *cpu) {
    unsigned operation = (instruction >> 22) & 3;
    unsigned base = (instruction >> 5) & 31;
    unsigned target = instruction & 31;
    unsigned bytes = 1u << (instruction >> 30);
    int64_t offset = (instruction >> 12) & 0x1FF;
    if (offset & 0x100)
        offset -= 0x200;
    uintptr_t address = (uintptr_t)((base == 31 ? *cpu->sp : cpu->x[base]) + (uint64_t)offset);
    if (operation == 0) {
        ordered_store(address, bytes, general(cpu, target));
        return;
    }
    uint64_t value = ordered_load(address, bytes);
    if (operation != 1) {
        unsigned unused = 64 - 8 * bytes;
        value = (uint64_t)((int64_t)(value << unused) >> unused);
        if (operation == 3)
            value &= 0xFFFFFFFF;
    }
    if (target != 31)
        cpu->x[target] = value;
}

static void dot_product(uint32_t instruction, struct armv84_cpu *cpu, int by_element) {
    uint8_t left[16], right[16];
    uint32_t sums[4];
    unsigned second = (instruction >> 16) & 31;
    if (!by_element) {
        memcpy(right, &cpu->v[second], 16);
    } else {
        unsigned element = (((instruction >> 11) & 1) << 1) | ((instruction >> 21) & 1);
        uint8_t source[16];
        memcpy(source, &cpu->v[second], 16);
        for (unsigned lane = 0; lane < 4; lane++)
            memcpy(right + 4 * lane, source + 4 * element, 4);
    }
    int is_unsigned = (instruction >> 29) & 1;
    unsigned lanes = (instruction >> 30) & 1 ? 4 : 2;
    memcpy(left, &cpu->v[(instruction >> 5) & 31], 16);
    memcpy(sums, &cpu->v[instruction & 31], 16);
    for (unsigned lane = 0; lane < 4; lane++) {
        if (lane >= lanes) {
            sums[lane] = 0;
            continue;
        }
        for (unsigned byte = 4 * lane; byte < 4 * lane + 4; byte++)
            sums[lane] += is_unsigned
                ? (uint32_t)left[byte] * right[byte]
                : (uint32_t)((int32_t)(int8_t)left[byte] * (int8_t)right[byte]);
    }
    memcpy(&cpu->v[instruction & 31], sums, 16);
}

static void sha3(enum operation operation, uint32_t instruction, struct armv84_cpu *cpu) {
    armv84_vector first = cpu->v[(instruction >> 5) & 31];
    armv84_vector second = cpu->v[(instruction >> 16) & 31];
    armv84_vector third = cpu->v[(instruction >> 10) & 31];
    armv84_vector *result = &cpu->v[instruction & 31];
    if (operation == EOR3) {
        *result = first ^ second ^ third;
    } else if (operation == BCAX) {
        *result = first ^ (second & ~third);
    } else if (operation == RAX1) {
        *result = first ^ pair(rotate_right(high(second), 63), rotate_right(low(second), 63));
    } else {
        unsigned count = (instruction >> 10) & 63;
        armv84_vector mixed = first ^ second;
        *result = pair(rotate_right(high(mixed), count), rotate_right(low(mixed), count));
    }
}

static uint64_t sha512_big_sigma1(uint64_t value) {
    return rotate_right(value, 14) ^ rotate_right(value, 18) ^ rotate_right(value, 41);
}

static uint64_t sha512_big_sigma0(uint64_t value) {
    return rotate_right(value, 28) ^ rotate_right(value, 34) ^ rotate_right(value, 39);
}

static uint64_t sha512_small_sigma0(uint64_t value) {
    return rotate_right(value, 1) ^ rotate_right(value, 8) ^ (value >> 7);
}

static uint64_t sha512_small_sigma1(uint64_t value) {
    return rotate_right(value, 19) ^ rotate_right(value, 61) ^ (value >> 6);
}

static void sha512(enum operation operation, uint32_t instruction, struct armv84_cpu *cpu) {
    armv84_vector x = cpu->v[(instruction >> 5) & 31];
    armv84_vector y = cpu->v[(instruction >> 16) & 31];
    armv84_vector *result = &cpu->v[instruction & 31];
    armv84_vector w = *result;
    if (operation == SHA512H) {
        uint64_t upper = ((high(y) & low(x)) ^ (~high(y) & high(x))) + sha512_big_sigma1(high(y)) + high(w);
        uint64_t sum = upper + low(y);
        uint64_t lower = ((sum & high(y)) ^ (~sum & low(x))) + sha512_big_sigma1(sum) + low(w);
        *result = pair(upper, lower);
    } else if (operation == SHA512H2) {
        uint64_t majority = (low(x) & high(y)) ^ (low(x) & low(y)) ^ (high(y) & low(y));
        uint64_t upper = majority + sha512_big_sigma0(low(y)) + high(w);
        uint64_t lower = ((upper & low(y)) ^ (upper & high(y)) ^ (high(y) & low(y)))
            + sha512_big_sigma0(upper) + low(w);
        *result = pair(upper, lower);
    } else if (operation == SHA512SU1) {
        *result = pair(high(w) + sha512_small_sigma1(high(x)) + high(y),
                       low(w) + sha512_small_sigma1(low(x)) + low(y));
    } else {
        *result = pair(high(w) + sha512_small_sigma0(low(x)), low(w) + sha512_small_sigma0(high(w)));
    }
}

enum armv84_extension armv84_emulate(uint32_t instruction, struct armv84_cpu *cpu) {
    enum operation operation = decode(instruction);
    switch (operation) {
    case NOT_EMULATED:
        break;
    case ORDERED_UNSCALED:
        ordered_unscaled(instruction, cpu);
        break;
    case DOT_VECTORS:
    case DOT_ELEMENT:
        dot_product(instruction, cpu, operation == DOT_ELEMENT);
        break;
    case EOR3:
    case BCAX:
    case RAX1:
    case XAR:
        sha3(operation, instruction, cpu);
        break;
    case SHA512H:
    case SHA512H2:
    case SHA512SU0:
    case SHA512SU1:
        sha512(operation, instruction, cpu);
        break;
    }
    return extension_of(operation);
}
