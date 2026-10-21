// Fixed-size source rewrites for the iOS runtime, which has no
// SharedArrayBuffer. The standalone graph is patched in place, so every
// replacement is padded to the length of the text it replaces. Sources are
// decoded as latin1 so string offsets equal byte offsets, including in UTF-8.
//
// The rules match code shapes rather than per-release counts. A shape that
// cannot be rewritten safely stops the build and names the module.

import { parse } from "acorn";

function nodes(node, predicate) {
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...Object.values(node).flatMap((value) => Array.isArray(value)
      ? value.flatMap((child) => nodes(child, predicate)) : nodes(value, predicate)),
  ];
}

// The runner's log writer added in 2.1.305 shares completion state with a
// Worker. An ArrayBuffer cannot carry that state between threads. Use its
// existing NO_THREAD fallback, which writes on the calling thread and keeps
// the upstream retry/error handling, instead of pretending the wait is sleep.
function disableThreadedWriter(contents, name) {
  const source = contents.toString("latin1");
  if (!source.includes("writeOnAThread")) return 0;
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const writers = nodes(tree, (n) => n.type === "Property" && n.key?.name === "writeOnAThread");
  for (const property of writers) {
    const fn = property.value;
    if (!property.method || fn.async || fn.params.length !== 2 ||
        !fn.params.every((p) => p.type === "Identifier"))
      throw Error(`${name}: unsupported threaded log writer`);
    const code = source.slice(fn.body.start, fn.body.end);
    const returns = nodes(fn.body, (n) => n.type === "ReturnStatement");
    const result = returns.find((n) => n.argument?.type === "ObjectExpression" &&
      n.argument.properties.some((p) => p.key?.name === "wait"))?.argument;
    const wait = result?.properties.find((p) => p.key?.name === "wait")?.value;
    const write = result?.properties.find((p) => p.key?.name === "write")?.value;
    const call = wait?.body?.body?.[0]?.expression;
    const buffer = call?.arguments?.[0]?.name;
    const shared = nodes(fn.body, (n) => n.type === "VariableDeclarator" && n.id.name === buffer &&
      n.init?.callee?.name === "Int32Array" && n.init.arguments[0]?.callee?.name === "SharedArrayBuffer" &&
      n.init.arguments[0].arguments[0]?.value === 16);
    const unavailable = write && nodes(write, (n) => n.type === "ThrowStatement" &&
      n.argument?.callee?.object?.name === "Object" && n.argument.callee.property?.name === "assign" &&
      n.argument.arguments.length === 2 && n.argument.arguments[0].callee?.name === "Error" &&
      n.argument.arguments[0].arguments.length === 1 &&
      typeof n.argument.arguments[0].arguments[0].value === "string" &&
      n.argument.arguments[1]?.properties?.length === 1 &&
      n.argument.arguments[1].properties[0].key?.name === "code" &&
      n.argument.arguments[1].properties[0].value.value === "NO_THREAD");
    if (result?.properties.length !== 2 ||
        wait?.params?.length !== 1 || wait.params[0].type !== "Identifier" || wait.body.body.length !== 1 ||
        call?.callee?.object?.name !== "Atomics" || call.callee.property?.name !== "wait" ||
        call.arguments.length !== 4 || call.arguments[1].value !== 0 ||
        call.arguments[2].type !== "Identifier" || call.arguments[3].name !== wait.params[0].name ||
        shared.length !== 1 || unavailable?.length !== 1 ||
        !nodes(fn.body, (n) => n.type === "NewExpression" && n.callee.name === "Worker").length ||
        [...code.matchAll(waitCall)].length !== 1)
      throw Error(`${name}: unsupported threaded log writer`);
    const failure = source.slice(unavailable[0].start, unavailable[0].end);
    const replacement = `{return{write(){${failure}}}}`;
    if (replacement.length > code.length) throw Error(`${name}: threaded writer rewrite does not fit`);
    Buffer.from(replacement.padEnd(code.length), "latin1").copy(contents, fn.body.start);
  }
  return writers.length;
}

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
// both identifiers between releases. The buffer is either a named one or a
// fresh `new Int32Array(new SharedArrayBuffer(n))` that nothing else can see.
const freshBuffer = String.raw`new\s+Int32Array\(\s*new\s+SharedArrayBuffer\(\s*\d+\s*\)\s*\)`;
const zeroWait = new RegExp(String.raw`^Atomics\.wait\(\s*(?:[A-Za-z_$][\w$]*|${freshBuffer})\s*,\s*0\s*,\s*0\s*,\s*([A-Za-z_$][\w$]*|\d+)\s*\)`);

function context(source, index, length) {
  return JSON.stringify(source.slice(Math.max(0, index - 60), index + length + 60));
}

export function patchSource(contents, name) {
  const threadedWriter = disableThreadedWriter(contents, name);
  const source = contents.toString("latin1");
  const counts = { sharedArrayBuffer: 0, wait: 0, threadedWriter };

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
