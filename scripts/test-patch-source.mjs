import assert from "node:assert/strict";
import test from "node:test";
import { patchSource } from "./patch-source.mjs";

function patch(text) {
  const contents = Buffer.from(text);
  const counts = patchSource(contents, "test.js");
  assert.equal(contents.length, Buffer.byteLength(text), "patch changed the source size");
  return { text: contents.toString(), counts };
}

test("renames whole SharedArrayBuffer tokens in place", () => {
  const { text, counts } = patch(
    'var a=new SharedArrayBuffer(4),b=typeof SharedArrayBuffer>"u",c=x instanceof SharedArrayBuffer,' +
    'd=globalThis.SharedArrayBuffer,e=["SharedArrayBuffer"],f={SharedArrayBuffer:1},g=SharedArrayBuffer==h;',
  );
  assert.equal(counts.sharedArrayBuffer, 7);
  assert.equal(text,
    'var a=new ArrayBuffer      (4),b=typeof ArrayBuffer      >"u",c=x instanceof ArrayBuffer      ,' +
    'd=globalThis.ArrayBuffer      ,e=["ArrayBuffer      "],f={ArrayBuffer      :1},g=ArrayBuffer      ==h;');
});

test("leaves longer names containing SharedArrayBuffer alone", () => {
  const source = 'isSharedArrayBuffer(x);$SharedArrayBuffer;"%SharedArrayBufferPrototype%";SharedArrayBuffer_;';
  const { text, counts } = patch(source);
  assert.equal(counts.sharedArrayBuffer, 0);
  assert.equal(text, source);
});

test("rejects declaring or assigning SharedArrayBuffer", () => {
  for (const source of [
    "var SharedArrayBuffer=1;",
    "let  SharedArrayBuffer;",
    "function SharedArrayBuffer(){}",
    "globalThis.SharedArrayBuffer = x;",
  ])
    assert.throws(() => patch(source), /declared or assigned/, source);
});

test("rewrites zero-valued Atomics.wait to a sleep of the same length", () => {
  const first = "Atomics.wait(Re,0,0,e)";
  const second = "Atomics.wait( $a , 0 , 0 , 50 )";
  const { text, counts } = patch(`function Pe(e){${first}}function q(){${second}}`);
  assert.equal(counts.wait, 2);
  assert.equal(text, `function Pe(e){${"Bun.sleepSync(e)".padEnd(first.length)}}` +
    `function q(){${"Bun.sleepSync(50)".padEnd(second.length)}}`);
});

test("rejects every other Atomics.wait call", () => {
  for (const source of [
    "Atomics.wait(a,0,1,e)",
    "Atomics.wait(a,1,0,e)",
    "Atomics.wait(a,0,0)",
    "Atomics.wait(a,0,0,e.timeout)",
    'Atomics["wait"](a,0,0,e)',
    "Atomics . wait(a,0,0,e)",
  ])
    assert.throws(() => patch(source), /unsupported Atomics\.wait/, source);
  const other = 'Atomics.waitAsync(a,0,0,e);Atomics.store(a,0,1);MyAtomics.wait(a);"Atomics.wait";';
  assert.equal(patch(other).text, other);
});

test("keeps UTF-8 bytes around patched text", () => {
  const wait = "Atomics.wait(r,0,0,t)";
  const { text } = patch(`"→";new SharedArrayBuffer(4);"é";${wait};"✓"`);
  assert.equal(text, `"→";new ArrayBuffer      (4);"é";${"Bun.sleepSync(t)".padEnd(wait.length)};"✓"`);
});
