#include <libkern/OSCacheControl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

#ifndef MAP_JIT
#define MAP_JIT 0x0800
#endif

extern void write_protect(int) __asm__("_pthread_jit_write_protect_np");

enum { SLOTS = 200000, SLOT_BYTES = 16, READERS = 3, WRITERS = 2 };

static uint8_t *region;
static _Atomic int published[WRITERS];
static _Atomic int failures;
static _Atomic int finished;

static int expected(int slot) { return (slot * 31 + 7) & 0xFFFF; }

static void emit(int slot) {
    uint32_t code[2] = {0x52800000u | ((uint32_t)expected(slot) << 5), 0xd65f03c0};
    write_protect(0);
    memcpy(region + (size_t)slot * SLOT_BYTES, code, sizeof code);
    write_protect(1);
    sys_icache_invalidate(region + (size_t)slot * SLOT_BYTES, sizeof code);
}

static int call(int slot) {
    return ((int (*)(void))(region + (size_t)slot * SLOT_BYTES))();
}

static void *write_slots(void *argument) {
    int writer = (int)(intptr_t)argument;
    for (int slot = writer; slot < SLOTS; slot += WRITERS) {
        emit(slot);
        atomic_store(&published[writer], slot + WRITERS);
    }
    return NULL;
}

static void *read_slots(void *argument) {
    uint64_t state = 0x9E3779B97F4A7C15ull + (uint64_t)(intptr_t)argument;
    uint64_t calls = 0;
    while (!atomic_load(&finished)) {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        int writer = (int)(state % WRITERS);
        int limit = atomic_load(&published[writer]);
        if (limit <= writer)
            continue;
        int slot = writer + (int)((state >> 8) % (uint64_t)((limit - writer + WRITERS - 1) / WRITERS)) * WRITERS;
        if (call(slot) != expected(slot))
            atomic_fetch_add(&failures, 1);
        calls++;
    }
    return (void *)(uintptr_t)calls;
}

int main(void) {
    region = mmap(NULL, 64u << 20, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANON | MAP_JIT, -1, 0);
    if (region == MAP_FAILED) {
        perror("mmap");
        return 1;
    }
    pthread_t writers[WRITERS], readers[READERS];
    for (intptr_t index = 0; index < READERS; index++)
        pthread_create(&readers[index], NULL, read_slots, (void *)index);
    for (intptr_t index = 0; index < WRITERS; index++)
        pthread_create(&writers[index], NULL, write_slots, (void *)index);
    for (int index = 0; index < WRITERS; index++)
        pthread_join(writers[index], NULL);
    atomic_store(&finished, 1);
    uint64_t calls = 0;
    for (int index = 0; index < READERS; index++) {
        void *result;
        pthread_join(readers[index], &result);
        calls += (uintptr_t)result;
    }
    int wrong = atomic_load(&failures);
    for (int slot = 0; slot < SLOTS; slot++)
        wrong += call(slot) != expected(slot);
    printf("%d functions written by %d threads while %d threads made calls: %d wrong results (%s)\n",
           SLOTS, WRITERS, READERS, wrong, calls > 1000 ? "calls overlapped the writes" : "too few concurrent calls");
    return wrong != 0;
}
