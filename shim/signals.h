#ifndef CLAUDE_SHIM_SIGNALS_H
#define CLAUDE_SHIM_SIGNALS_H

#include <signal.h>
#include <sys/ucontext.h>

#pragma GCC visibility push(hidden)
typedef int shim_fault_handler(siginfo_t *information, ucontext_t *context);
int shim_claim_signal(int number, shim_fault_handler *handler);
#pragma GCC visibility pop

#endif
