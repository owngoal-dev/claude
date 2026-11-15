#include "signals.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libkern/OSCacheControl.h>
#include <mach/vm_page_size.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef MAP_JIT
#define MAP_JIT 0x0800
#endif

enum { REGIONS = 4, WRITTEN_PAGES = 1024, EXECUTE_RETRIES = 64 };

struct region {
    uintptr_t start;
    uintptr_t end;
    _Atomic uint8_t *writable;
};

struct writer {
    int writing;
    int overflowed;
    unsigned count;
    uintptr_t pages[WRITTEN_PAGES];
};

struct jit_counts {
    _Atomic uint64_t regions;
    _Atomic uint64_t reserved_bytes;
    _Atomic uint64_t write_windows;
    _Atomic uint64_t pages_opened;
    _Atomic uint64_t execute_waits;
};

static struct region regions[REGIONS];
static _Atomic int region_count;
static pthread_mutex_t region_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t writer_key;
static pthread_once_t resolved = PTHREAD_ONCE_INIT;
static void *(*system_mmap)(void *, size_t, int, int, int, off_t);
static int (*system_mprotect)(void *, size_t, int);
static int available;
static struct jit_counts fallback_counts;
static struct jit_counts *counts = &fallback_counts;

static void resolve(void) {
    system_mmap = dlsym(RTLD_NEXT, "mmap");
    system_mprotect = dlsym(RTLD_NEXT, "mprotect");
}

static struct region *region_containing(uintptr_t address) {
    int count = atomic_load(&region_count);
    for (int index = 0; index < count; index++)
        if (address >= regions[index].start && address < regions[index].end)
            return &regions[index];
    return NULL;
}

static _Atomic uint8_t *writable_flag(struct region *region, uintptr_t page) {
    return &region->writable[(page - region->start) >> vm_page_shift];
}

static void close_pages(struct writer *writer) {
    if (writer->overflowed) {
        int count = atomic_load(&region_count);
        for (int index = 0; index < count; index++) {
            struct region *region = &regions[index];
            system_mprotect((void *)region->start, region->end - region->start, PROT_READ | PROT_EXEC);
            memset(region->writable, 0, (region->end - region->start) >> vm_page_shift);
        }
    } else {
        for (unsigned index = 0; index < writer->count; index++) {
            uintptr_t page = writer->pages[index];
            system_mprotect((void *)page, vm_page_size, PROT_READ | PROT_EXEC);
            atomic_store(writable_flag(region_containing(page), page), 0);
        }
    }
    writer->count = 0;
    writer->overflowed = 0;
}

void pthread_jit_write_protect_np(int enabled) {
    if (!available)
        return;
    struct writer *writer = pthread_getspecific(writer_key);
    if (!writer) {
        if (enabled || !(writer = calloc(1, sizeof *writer)))
            return;
        pthread_setspecific(writer_key, writer);
    }
    if (!enabled) {
        writer->writing = 1;
        atomic_fetch_add_explicit(&counts->write_windows, 1, memory_order_relaxed);
        return;
    }
    writer->writing = 0;
    close_pages(writer);
}

static int on_bus_error(siginfo_t *information, ucontext_t *context) {
    (void)information;
    uintptr_t address = (uintptr_t)context->uc_mcontext->__es.__far;
    struct region *region = region_containing(address);
    if (!region)
        return 0;
    uint32_t syndrome = context->uc_mcontext->__es.__esr;
    unsigned class = syndrome >> 26;
    uintptr_t page = address & ~(uintptr_t)vm_page_mask;
    _Atomic uint8_t *writable = writable_flag(region, page);
    if ((class == 0x24 || class == 0x25) && (syndrome & 0x40)) {
        struct writer *writer = pthread_getspecific(writer_key);
        if (!writer || !writer->writing)
            return 0;
        atomic_store(writable, 1);
        if (system_mprotect((void *)page, vm_page_size, PROT_READ | PROT_WRITE))
            return 0;
        if (writer->count < WRITTEN_PAGES)
            writer->pages[writer->count++] = page;
        else
            writer->overflowed = 1;
        atomic_fetch_add_explicit(&counts->pages_opened, 1, memory_order_relaxed);
        return 1;
    }
    if (class == 0x20 || class == 0x21) {
        static _Atomic uintptr_t last;
        static _Atomic unsigned repeats;
        atomic_fetch_add_explicit(&counts->execute_waits, 1, memory_order_relaxed);
        if (atomic_load(writable)) {
            sched_yield();
            return 1;
        }
        if (atomic_exchange(&last, address) != address)
            atomic_store(&repeats, 0);
        return atomic_fetch_add(&repeats, 1) < EXECUTE_RETRIES;
    }
    return 0;
}

void *mmap(void *address, size_t length, int protection, int flags, int file, off_t offset) {
    pthread_once(&resolved, resolve);
    if (!system_mmap) {
        errno = ENOSYS;
        return MAP_FAILED;
    }
    if (!available || !(flags & MAP_JIT))
        return system_mmap(address, length, protection, flags, file, offset);
    pthread_mutex_lock(&region_lock);
    void *memory = MAP_FAILED;
    int index = atomic_load(&region_count);
    size_t pages = (length + vm_page_mask) >> vm_page_shift;
    void *writable = index < REGIONS
        ? system_mmap(NULL, pages, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0)
        : MAP_FAILED;
    if (writable == MAP_FAILED) {
        errno = ENOMEM;
    } else {
        int access = protection & PROT_EXEC ? PROT_READ | PROT_EXEC : protection & ~PROT_WRITE;
        memory = system_mmap(address, length, access, flags & ~MAP_JIT, file, offset);
        if (memory == MAP_FAILED) {
            int reason = errno;
            munmap(writable, pages);
            errno = reason;
        } else {
            regions[index] = (struct region){(uintptr_t)memory, (uintptr_t)memory + (pages << vm_page_shift), writable};
            atomic_store(&region_count, index + 1);
            atomic_fetch_add(&counts->regions, 1);
            atomic_fetch_add(&counts->reserved_bytes, length);
        }
    }
    pthread_mutex_unlock(&region_lock);
    return memory;
}

int mprotect(void *address, size_t length, int protection) {
    pthread_once(&resolved, resolve);
    if (!system_mprotect) {
        errno = ENOSYS;
        return -1;
    }
    if (available && (protection & PROT_EXEC) && region_containing((uintptr_t)address))
        protection &= ~PROT_WRITE;
    return system_mprotect(address, length, protection);
}

static void give_up(int number) {
    (void)number;
    _exit(1);
}

static int written_code_runs(void) {
    static const uint32_t code[] = {0x52800540, 0xd65f03c0};
    pid_t child = fork();
    if (child < 0)
        return 0;
    if (child == 0) {
        signal(SIGBUS, give_up);
        signal(SIGSEGV, give_up);
        signal(SIGILL, give_up);
        void *memory = system_mmap(NULL, vm_page_size, PROT_READ | PROT_EXEC, MAP_PRIVATE | MAP_ANON, -1, 0);
        if (memory == MAP_FAILED || system_mprotect(memory, vm_page_size, PROT_READ | PROT_WRITE))
            _exit(1);
        memcpy(memory, code, sizeof code);
        if (system_mprotect(memory, vm_page_size, PROT_READ | PROT_EXEC))
            _exit(1);
        sys_icache_invalidate(memory, sizeof code);
        _exit(((int (*)(void))memory)() == 42 ? 0 : 1);
    }
    int status;
    while (waitpid(child, &status, 0) < 0)
        if (errno != EINTR)
            return 0;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static void open_counts(void) {
    const char *path = getenv("CLAUDE_JIT_COUNTS");
    if (!path || !*path)
        return;
    int file = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0)
        return;
    if (ftruncate(file, sizeof *counts) == 0) {
        void *mapping = system_mmap(NULL, sizeof *counts, PROT_READ | PROT_WRITE, MAP_SHARED, file, 0);
        if (mapping != MAP_FAILED)
            counts = mapping;
    }
    close(file);
}

__attribute__((constructor)) static void provide_jit_memory(void) {
    pthread_once(&resolved, resolve);
    if (!system_mmap || !system_mprotect || !written_code_runs())
        return;
    if (pthread_key_create(&writer_key, free) || shim_claim_signal(SIGBUS, on_bus_error))
        return;
    open_counts();
    available = 1;
}
