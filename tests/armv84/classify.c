#include "../../shim/armv84.h"

#include <fcntl.h>
#include <mach-o/loader.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>

int main(int argc, char **argv) {
    if (argc != 2)
        return 64;
    int file = open(argv[1], O_RDONLY);
    struct stat status;
    if (file < 0 || fstat(file, &status))
        return 66;
    const uint8_t *image = mmap(NULL, (size_t)status.st_size, PROT_READ, MAP_PRIVATE, file, 0);
    if (image == MAP_FAILED)
        return 66;
    const struct mach_header_64 *header = (const void *)image;
    if (header->magic != MH_MAGIC_64)
        return 65;
    static const char *names[ARMV84_EXTENSION_COUNT] = {"", "rcpc2", "dotprod", "sha3", "sha512"};
    const struct load_command *command = (const void *)(header + 1);
    for (uint32_t index = 0; index < header->ncmds; index++) {
        if (command->cmd == LC_SEGMENT_64) {
            const struct segment_command_64 *segment = (const void *)command;
            const struct section_64 *section = (const void *)(segment + 1);
            for (uint32_t number = 0; number < segment->nsects; number++, section++) {
                if (!(section->flags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)))
                    continue;
                for (uint64_t offset = 0; offset + 4 <= section->size; offset += 4) {
                    uint32_t instruction;
                    memcpy(&instruction, image + section->offset + offset, 4);
                    enum armv84_extension extension = armv84_classify(instruction);
                    if (extension != ARMV84_NONE)
                        printf("%llx %08x %s\n", (unsigned long long)(section->addr + offset), instruction, names[extension]);
                }
            }
        }
        command = (const void *)((const uint8_t *)command + command->cmdsize);
    }
    return 0;
}
