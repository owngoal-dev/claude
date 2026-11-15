#include "armv84.h"
#include "signals.h"

#include <fcntl.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/sysctl.h>
#include <sys/ucontext.h>
#include <unistd.h>

_Static_assert(offsetof(_STRUCT_ARM_THREAD_STATE64, __fp) == 29 * sizeof(uint64_t), "x29 follows x28");
_Static_assert(offsetof(_STRUCT_ARM_THREAD_STATE64, __lr) == 30 * sizeof(uint64_t), "x30 follows x29");
_Static_assert(sizeof(((_STRUCT_ARM_NEON_STATE64 *)0)->__v[0]) == sizeof(armv84_vector), "128-bit vectors");

enum { SITE_SLOTS = 1 << 14, SITE_PROBES = 32 };

struct trap_counts {
    _Atomic uint64_t by_extension[ARMV84_EXTENSION_COUNT];
    struct {
        _Atomic uint64_t offset;
        _Atomic uint64_t count;
    } sites[SITE_SLOTS];
};

static struct trap_counts *counts;
static uintptr_t executable_base;

static void count(enum armv84_extension extension, uintptr_t address) {
    atomic_fetch_add_explicit(&counts->by_extension[extension], 1, memory_order_relaxed);
    uint64_t offset = address - executable_base + 1;
    for (unsigned probe = 0; probe < SITE_PROBES; probe++) {
        unsigned slot = (unsigned)((offset * 0x9E3779B97F4A7C15ull) >> 50) + probe;
        _Atomic uint64_t *key = &counts->sites[slot % SITE_SLOTS].offset;
        uint64_t seen = atomic_load_explicit(key, memory_order_relaxed);
        if (!seen && atomic_compare_exchange_strong(key, &seen, offset))
            seen = offset;
        if (seen == offset) {
            atomic_fetch_add_explicit(&counts->sites[slot % SITE_SLOTS].count, 1, memory_order_relaxed);
            return;
        }
    }
}

static int on_illegal_instruction(siginfo_t *information, ucontext_t *context) {
    (void)information;
    _STRUCT_MCONTEXT64 *machine = context->uc_mcontext;
    uintptr_t address = (uintptr_t)machine->__ss.__pc;
    uint32_t instruction;
    memcpy(&instruction, (const void *)address, sizeof instruction);
    struct armv84_cpu cpu = {machine->__ss.__x, &machine->__ss.__sp, machine->__ns.__v};
    enum armv84_extension extension = armv84_emulate(instruction, &cpu);
    if (extension == ARMV84_NONE)
        return 0;
    machine->__ss.__pc = address + sizeof instruction;
    if (counts)
        count(extension, address);
    return 1;
}

static int processor_has(const char *feature) {
    int present = 0;
    size_t size = sizeof present;
    return sysctlbyname(feature, &present, &size, NULL, 0) == 0 && present;
}

static void open_counts(void) {
    const char *path = getenv("CLAUDE_ILLEGAL_INSTRUCTION_COUNTS");
    if (!path || !*path)
        return;
    int file = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0)
        return;
    if (ftruncate(file, sizeof *counts) == 0) {
        void *mapping = mmap(NULL, sizeof *counts, PROT_READ | PROT_WRITE, MAP_SHARED, file, 0);
        if (mapping != MAP_FAILED)
            counts = mapping;
    }
    close(file);
}

__attribute__((constructor)) static void emulate_missing_instructions(void) {
    if (processor_has("hw.optional.arm.FEAT_LRCPC2") && processor_has("hw.optional.arm.FEAT_DotProd") &&
        processor_has("hw.optional.arm.FEAT_SHA3") && processor_has("hw.optional.arm.FEAT_SHA512"))
        return;
    executable_base = (uintptr_t)_dyld_get_image_header(0);
    open_counts();
    shim_claim_signal(SIGILL, on_illegal_instruction);
}
