#include "signals.h"

#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { CLAIMS = 4 };

struct claim {
    int number;
    shim_fault_handler *handler;
    _Atomic(struct sigaction *) program;
};

static struct claim claims[CLAIMS];
static _Atomic int claimed;
static int (*system_sigaction)(int, const struct sigaction *, struct sigaction *);
static sig_t (*system_signal)(int, sig_t);
static pthread_once_t resolved = PTHREAD_ONCE_INIT;

static void resolve(void) {
    system_sigaction = dlsym(RTLD_NEXT, "sigaction");
    system_signal = dlsym(RTLD_NEXT, "signal");
}

static struct claim *claim_for(int number) {
    int count = atomic_load(&claimed);
    for (int index = 0; index < count; index++)
        if (claims[index].number == number)
            return &claims[index];
    return NULL;
}

static void dispatch(int number, siginfo_t *information, void *context) {
    struct claim *claim = claim_for(number);
    if (claim && claim->handler(information, context))
        return;
    struct sigaction *action = claim ? atomic_load(&claim->program) : NULL;
    if (action && (uintptr_t)action->sa_handler > (uintptr_t)SIG_IGN) {
        if (action->sa_flags & SA_SIGINFO)
            action->sa_sigaction(number, information, context);
        else
            action->sa_handler(number);
        return;
    }
    struct sigaction standard = {.sa_handler = SIG_DFL};
    system_sigaction(number, &standard, NULL);
}

int shim_claim_signal(int number, shim_fault_handler *handler) {
    pthread_once(&resolved, resolve);
    int index = atomic_load(&claimed);
    if (!system_sigaction || index == CLAIMS || claim_for(number))
        return -1;
    claims[index].number = number;
    claims[index].handler = handler;
    atomic_store(&claimed, index + 1);
    struct sigaction action = {.sa_sigaction = dispatch, .sa_flags = SA_SIGINFO | SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (system_sigaction(number, &action, NULL) == 0)
        return 0;
    atomic_store(&claimed, index);
    return -1;
}

int sigaction(int number, const struct sigaction *restrict action, struct sigaction *restrict previous) {
    pthread_once(&resolved, resolve);
    if (!system_sigaction) {
        errno = ENOSYS;
        return -1;
    }
    struct claim *claim = claim_for(number);
    if (!claim)
        return system_sigaction(number, action, previous);
    struct sigaction *current = atomic_load(&claim->program);
    if (action) {
        struct sigaction *replacement = malloc(sizeof *replacement);
        if (!replacement) {
            errno = ENOMEM;
            return -1;
        }
        *replacement = *action;
        current = atomic_exchange(&claim->program, replacement);
    }
    if (previous) {
        if (current) {
            *previous = *current;
        } else {
            memset(previous, 0, sizeof *previous);
            previous->sa_handler = SIG_DFL;
        }
    }
    return 0;
}

sig_t signal(int number, sig_t handler) {
    pthread_once(&resolved, resolve);
    if (!claim_for(number))
        return system_signal ? system_signal(number, handler) : SIG_ERR;
    struct sigaction action = {.sa_handler = handler, .sa_flags = SA_RESTART}, previous;
    sigemptyset(&action.sa_mask);
    return sigaction(number, &action, &previous) ? SIG_ERR : previous.sa_handler;
}
