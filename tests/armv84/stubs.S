.arch armv8.4-a+sha3+dotprod
.text

.macro entry name
    .globl _\name
    .p2align 2
_\name:
.endm

.macro vector name, instruction:vararg
    entry \name
    \instruction
    ret
.endm

.macro vector_high name, instruction:vararg
    entry \name
    mov v19.16b, v0.16b
    mov v20.16b, v1.16b
    mov v21.16b, v2.16b
    mov v22.16b, v3.16b
    .globl _\name\()_at
_\name\()_at:
    \instruction
    mov v0.16b, v19.16b
    ret
.endm

vector udot_4s, udot v0.4s, v1.16b, v2.16b
vector sdot_4s, sdot v0.4s, v1.16b, v2.16b
vector udot_2s, udot v0.2s, v1.8b, v2.8b
vector sdot_2s, sdot v0.2s, v1.8b, v2.8b
vector udot_4s_element0, udot v0.4s, v1.16b, v2.4b[0]
vector udot_4s_element1, udot v0.4s, v1.16b, v2.4b[1]
vector udot_4s_element2, udot v0.4s, v1.16b, v2.4b[2]
vector udot_4s_element3, udot v0.4s, v1.16b, v2.4b[3]
vector sdot_4s_element2, sdot v0.4s, v1.16b, v2.4b[2]
vector udot_2s_element3, udot v0.2s, v1.8b, v2.4b[3]
vector eor3, eor3 v0.16b, v1.16b, v2.16b, v3.16b
vector bcax, bcax v0.16b, v1.16b, v2.16b, v3.16b
vector rax1, rax1 v0.2d, v1.2d, v2.2d
vector xar_0, xar v0.2d, v1.2d, v2.2d, #0
vector xar_1, xar v0.2d, v1.2d, v2.2d, #1
vector xar_17, xar v0.2d, v1.2d, v2.2d, #17
vector xar_63, xar v0.2d, v1.2d, v2.2d, #63
vector sha512h, sha512h q0, q1, v2.2d
vector sha512h2, sha512h2 q0, q1, v2.2d
vector sha512su0, sha512su0 v0.2d, v1.2d
vector sha512su1, sha512su1 v0.2d, v1.2d, v2.2d

vector_high udot_high, udot v19.4s, v20.16b, v21.16b
vector_high udot_element_high, udot v19.4s, v20.16b, v21.4b[1]
vector_high eor3_high, eor3 v19.16b, v20.16b, v21.16b, v22.16b
vector_high bcax_high, bcax v19.16b, v20.16b, v21.16b, v22.16b
vector_high rax1_high, rax1 v19.2d, v20.2d, v21.2d
vector_high xar_high, xar v19.2d, v20.2d, v21.2d, #44
vector_high sha512h_high, sha512h q19, q20, v21.2d
vector_high sha512h2_high, sha512h2 q19, q20, v21.2d
vector_high sha512su0_high, sha512su0 v19.2d, v20.2d
vector_high sha512su1_high, sha512su1 v19.2d, v20.2d, v21.2d

vector load_x, ldapur x0, [x1, #8]
vector load_x_negative, ldapur x0, [x1, #-256]
vector load_x_unaligned, ldapur x0, [x1, #3]
vector load_w, ldapur w0, [x1, #-4]
vector load_h, ldapurh w0, [x1, #254]
vector load_b, ldapurb w0, [x1, #255]
vector load_signed_b_x, ldapursb x0, [x1, #3]
vector load_signed_b_w, ldapursb w0, [x1, #3]
vector load_signed_h_x, ldapursh x0, [x1, #-2]
vector load_signed_h_w, ldapursh w0, [x1, #-2]
vector load_signed_w, ldapursw x0, [x1, #20]
vector store_x, stlur x0, [x1, #16]
vector store_x_negative, stlur x0, [x1, #-8]
vector store_x_unaligned, stlur x0, [x1, #5]
vector store_w, stlur w0, [x1, #36]
vector store_h, stlurh w0, [x1, #-10]
vector store_b, stlurb w0, [x1, #-1]
vector store_zero, stlur xzr, [x1, #24]

entry load_stack
    sub sp, sp, #48
    str x0, [sp, #40]
    .globl _load_stack_at
_load_stack_at:
    ldapur x0, [sp, #40]
    add sp, sp, #48
    ret

entry store_stack
    sub sp, sp, #48
    .globl _store_stack_at
_store_stack_at:
    stlur x0, [sp, #24]
    ldr x0, [sp, #24]
    add sp, sp, #48
    ret

entry load_same_register
    ldapur x1, [x1, #16]
    mov x0, x1
    ret
