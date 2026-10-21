#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// iOS may accept a shebang script in posix_spawn, then exit the child with
// status 127. Start the interpreter explicitly from a native executable.
// Resolve our own installed path so RootHide and rootless use the same binary.
int main(int argc, char **argv) {
    char executable[PATH_MAX], prefix[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) || !realpath(executable, prefix)) {
        fputs("claude: cannot locate the installed launcher\n", stderr);
        return 127;
    }
    const char suffix[] = "/usr/bin/claude";
    size_t length = strlen(prefix), suffix_length = sizeof(suffix) - 1;
    if (length <= suffix_length || strcmp(prefix + length - suffix_length, suffix)) {
        fputs("claude: launcher is outside its package location\n", stderr);
        return 127;
    }
    prefix[length - suffix_length] = '\0';
    char shell[PATH_MAX], script[PATH_MAX];
    if (snprintf(shell, sizeof(shell), "%s/bin/sh", prefix) >= (int)sizeof(shell) ||
        snprintf(script, sizeof(script), "%s/usr/libexec/claude/launcher.sh", prefix) >= (int)sizeof(script)) {
        fputs("claude: installed launcher path is too long\n", stderr);
        return 127;
    }
    char **arguments = calloc((size_t)argc + 2, sizeof(*arguments));
    if (!arguments) {
        perror("claude: cannot allocate launcher arguments");
        return 127;
    }
    arguments[0] = shell;
    arguments[1] = script;
    for (int index = 1; index < argc; index++) arguments[index + 1] = argv[index];
    execv(shell, arguments);
    perror("claude: cannot start the bootstrap shell");
    free(arguments);
    return 127;
}
