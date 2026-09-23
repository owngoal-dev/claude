// Fixed-size source rewrites for the iOS runtime, which has no
// SharedArrayBuffer. The standalone graph is patched in place, so every
// replacement is padded to the length of the text it replaces. Sources are
// decoded as latin1 so string offsets equal byte offsets, including in UTF-8.
//
// The rules match code shapes rather than per-release counts. A shape that
// cannot be rewritten safely stops the build and names the module.

const identifierChar = String.raw`[\w$\x80-\xff]`;
const sharedArrayBuffer = new RegExp(
  String.raw`(?<!${identifierChar})SharedArrayBuffer(?!${identifierChar})`,
  "g",
);
const bindingBefore = /(?<![\w$\x80-\xff])(?:var|let|const|function|class)\s+$/;
const assignmentAfter = /^\s*=(?![=>])/;
const waitCall = /(?<![\w$\x80-\xff])Atomics\s*(?:\.\s*wait|\[\s*(["'`])wait\1\s*\])\s*\(/g;
// Only the zero-valued sleep helper is rewritten: without shared memory
// nothing can notify it, so it blocks until the timeout. Minifiers rename
// both identifiers between releases.
const zeroWait = /^Atomics\.wait\(\s*[A-Za-z_$][\w$]*\s*,\s*0\s*,\s*0\s*,\s*([A-Za-z_$][\w$]*|\d+)\s*\)/;

function context(source, index, length) {
  return JSON.stringify(source.slice(Math.max(0, index - 60), index + length + 60));
}

export function patchSource(contents, name) {
  const source = contents.toString("latin1");
  const counts = { sharedArrayBuffer: 0, wait: 0 };

  // A whole-token rename keeps `typeof`, `new`, `instanceof` and property
  // reads valid. Declaring or assigning the name would shadow or overwrite
  // ArrayBuffer instead, and names like `isSharedArrayBuffer` are left alone.
  const replacement = Buffer.from("ArrayBuffer      ", "latin1");
  for (const match of source.matchAll(sharedArrayBuffer)) {
    const end = match.index + match[0].length;
    if (bindingBefore.test(source.slice(Math.max(0, match.index - 16), match.index)) ||
        assignmentAfter.test(source.slice(end, end + 8)))
      throw new Error(`${name}: SharedArrayBuffer is declared or assigned: ${context(source, match.index, match[0].length)}`);
    replacement.copy(contents, match.index);
    counts.sharedArrayBuffer++;
  }

  // Atomics.wait throws on a non-shared buffer, so every call must be rewritten.
  for (const match of source.matchAll(waitCall)) {
    const call = zeroWait.exec(source.slice(match.index));
    if (!call)
      throw new Error(`${name}: unsupported Atomics.wait call: ${context(source, match.index, match[0].length)}`);
    const sleep = `Bun.sleepSync(${call[1]})`;
    Buffer.from(sleep.padEnd(call[0].length), "latin1").copy(contents, match.index);
    counts.wait++;
  }
  return counts;
}
