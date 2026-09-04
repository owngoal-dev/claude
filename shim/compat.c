#include <dlfcn.h>
#include <libkern/OSCacheControl.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

void __clear_cache(void *start, void *end) {
    uintptr_t first = (uintptr_t)start;
    uintptr_t last = (uintptr_t)end;
    if (last > first)
        sys_icache_invalidate(start, last - first);
}

void pthread_jit_write_protect_np(int enabled) {
    (void)enabled;
}

static void *(*real_dlopen)(const char *, int);
static pthread_once_t dlopen_once = PTHREAD_ONCE_INIT;

static void resolve_dlopen(void) {
    real_dlopen = dlsym(RTLD_NEXT, "dlopen");
}

void *dlopen(const char *path, int mode) {
    pthread_once(&dlopen_once, resolve_dlopen);
    if (!real_dlopen)
        return NULL;
    if (path && (!strcmp(path, "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation") ||
                 !strcmp(path, "/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices")))
        return real_dlopen(NULL, mode);
    return real_dlopen(path, mode);
}

static char fsevent_stream;

void *FSEventStreamCreate(void *allocator, void *callback, void *context, void *paths,
                          uint64_t since, double latency, uint32_t flags) {
    (void)allocator;
    (void)callback;
    (void)context;
    (void)paths;
    (void)since;
    (void)latency;
    (void)flags;
    return &fsevent_stream;
}

void FSEventStreamInvalidate(void *stream) { (void)stream; }
void FSEventStreamRelease(void *stream) { (void)stream; }
void FSEventStreamScheduleWithRunLoop(void *stream, void *loop, void *mode) {
    (void)stream;
    (void)loop;
    (void)mode;
}
int FSEventStreamStart(void *stream) { (void)stream; return 1; }
void FSEventStreamStop(void *stream) { (void)stream; }
