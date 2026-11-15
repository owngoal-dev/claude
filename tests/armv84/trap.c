#include "cases.h"

#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/ucontext.h>

enum { ROUNDS = 2000, REGION = 1024, THREADS = 4 };

static uint64_t fold(uint64_t digest, const void *bytes, unsigned count) {
    const uint8_t *cursor = bytes;
    for (unsigned index = 0; index < count; index++)
        digest = (digest ^ cursor[index]) * 0x100000001B3ull;
    return digest;
}

static uint64_t run_vector(const struct vector_case *test) {
    uint64_t seed = 0x243F6A8885A308D3ull, digest = 0xCBF29CE484222325ull;
    for (int round = 0; round < ROUNDS; round++) {
        uint8x16_t input[4];
        fill_random(&seed, input, sizeof input);
        uint8x16_t result = test->run(input[0], input[1], input[2], input[3]);
        digest = fold(digest, &result, sizeof result);
    }
    return digest;
}

static uint64_t run_memory(const struct memory_case *test) {
    uint64_t seed = 0x13198A2E03707344ull, digest = 0xCBF29CE484222325ull;
    for (int round = 0; round < ROUNDS; round++) {
        _Alignas(16) uint8_t region[REGION];
        fill_random(&seed, region, sizeof region);
        uint64_t result = test->run(next_random(&seed), region + REGION / 2);
        digest = fold(digest, &result, sizeof result);
        digest = fold(digest, region, sizeof region);
    }
    return digest;
}

static uint64_t run_stack(void) {
    uint64_t seed = 0xA4093822299F31D0ull, digest = 0xCBF29CE484222325ull;
    for (int round = 0; round < ROUNDS; round++) {
        uint64_t result[2] = {load_stack(next_random(&seed)), store_stack(next_random(&seed))};
        digest = fold(digest, result, sizeof result);
    }
    return digest;
}

static uint64_t run_everything(void) {
    uint64_t digest = run_stack();
    for (unsigned index = 0; index < sizeof vector_cases / sizeof vector_cases[0]; index++)
        digest ^= run_vector(&vector_cases[index]) + index;
    for (unsigned index = 0; index < sizeof memory_cases / sizeof memory_cases[0]; index++)
        digest ^= run_memory(&memory_cases[index]) * (index + 3);
    return digest;
}

static void *thread_main(void *result) {
    *(uint64_t *)result = run_everything();
    return NULL;
}

static volatile sig_atomic_t program_handler_calls;

static void program_handler(int number, siginfo_t *information, void *opaque) {
    (void)number;
    (void)information;
    ucontext_t *context = opaque;
    program_handler_calls++;
    context->uc_mcontext->__ss.__pc += 4;
}

int main(void) {
    for (unsigned index = 0; index < sizeof vector_cases / sizeof vector_cases[0]; index++)
        printf("%-22s %016llx\n", vector_cases[index].name, (unsigned long long)run_vector(&vector_cases[index]));
    for (unsigned index = 0; index < sizeof memory_cases / sizeof memory_cases[0]; index++)
        printf("%-22s %016llx\n", memory_cases[index].name, (unsigned long long)run_memory(&memory_cases[index]));
    printf("%-22s %016llx\n", "stack", (unsigned long long)run_stack());

    struct sigaction action = {.sa_sigaction = program_handler, .sa_flags = SA_SIGINFO}, previous, reported;
    sigemptyset(&action.sa_mask);
    sigaction(SIGILL, &action, &previous);
    sigaction(SIGILL, NULL, &reported);
    printf("%-22s previous %s, reported %s\n", "program handler",
           previous.sa_handler == SIG_DFL ? "default" : "other",
           reported.sa_sigaction == program_handler ? "itself" : "other");
    uint64_t combined = run_everything();
    printf("%-22s %016llx\n", "with program handler", (unsigned long long)combined);
    __asm__ volatile(".inst 0x00000000");
    printf("%-22s %d\n", "undefined passed on", (int)program_handler_calls);

    pthread_t threads[THREADS];
    uint64_t results[THREADS];
    for (int index = 0; index < THREADS; index++)
        pthread_create(&threads[index], NULL, thread_main, &results[index]);
    int agree = 1;
    for (int index = 0; index < THREADS; index++) {
        pthread_join(threads[index], NULL);
        agree &= results[index] == combined;
    }
    printf("%-22s %s\n", "threads agree", agree ? "yes" : "no");
    return 0;
}
