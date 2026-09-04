import fs from "node:fs";

const [path, minimumIOS, expectedModules, expectedBytecode, expectedSAB, expectedWait] = process.argv.slice(2);
if (!path || !minimumIOS || !expectedWait) {
  console.error("usage: patch-binary.mjs <binary> <min-ios> <modules> <bytecode> <sab> <wait>");
  process.exit(64);
}

const expected = {
  modules: Number(expectedModules),
  bytecode: Number(expectedBytecode),
  sab: Number(expectedSAB),
  wait: Number(expectedWait),
};
if (Object.values(expected).some(value => !Number.isSafeInteger(value) || value < 0))
  throw new Error("expected counts must be non-negative integers");
const versionParts = minimumIOS.split(".").map(Number);
if (versionParts.length !== 2 || versionParts.some(Number.isNaN)) throw new Error("invalid iOS version");
const encodedMinimum = (versionParts[0] << 16) | (versionParts[1] << 8);
const fd = fs.openSync(path, "r+");
const fileSize = fs.fstatSync(fd).size;

function read(length, position) {
  const buffer = Buffer.alloc(length);
  if (fs.readSync(fd, buffer, 0, length, position) !== length) throw new Error("short read");
  return buffer;
}

function writeChecked(position, before, after) {
  if (before.length !== after.length) throw new Error("in-place replacement changed size");
  if (!read(before.length, position).equals(before)) throw new Error(`unexpected bytes at ${position}`);
  if (fs.writeSync(fd, after, 0, after.length, position) !== after.length)
    throw new Error(`short write at ${position}`);
  if (!read(after.length, position).equals(after)) throw new Error(`write verification failed at ${position}`);
}

const header = read(32, 0);
if (header.readUInt32LE(0) !== 0xfeedfacf) throw new Error("input is not a 64-bit little-endian Mach-O");
let commandOffset = 32;
let buildVersions = 0;
let systemLibraries = 0;
let graphSection = null;
for (let i = 0; i < header.readUInt32LE(16); i++) {
  const commandHead = read(8, commandOffset);
  const commandID = commandHead.readUInt32LE(0);
  const commandSize = commandHead.readUInt32LE(4);
  if (commandSize < 8 || commandOffset + commandSize > fileSize) throw new Error("invalid load command");
  const command = read(commandSize, commandOffset);
  if (commandID === 0x32) {
    if (command.readUInt32LE(8) !== 1) throw new Error("input is not a macOS executable");
    const changed = Buffer.from(command);
    changed.writeUInt32LE(2, 8);
    changed.writeUInt32LE(encodedMinimum, 12);
    writeChecked(commandOffset, command, changed);
    buildVersions++;
  }
  if (commandID === 0xc) {
    const nameOffset = command.readUInt32LE(8);
    const end = command.indexOf(0, nameOffset);
    if (end < 0) throw new Error("unterminated dylib name");
    if (command.subarray(nameOffset, end).toString() === "/usr/lib/libSystem.B.dylib") {
      const changed = Buffer.from(command);
      const replacement = Buffer.from("@executable_path/s.dylib\0");
      if (replacement.length > commandSize - nameOffset) throw new Error("shim path does not fit load command");
      changed.fill(0, nameOffset);
      replacement.copy(changed, nameOffset);
      writeChecked(commandOffset, command, changed);
      systemLibraries++;
    }
  }
  if (commandID === 0x19) {
    const segment = command.subarray(8, 24).toString().replace(/\0.*$/, "");
    for (let section = 0; section < command.readUInt32LE(64); section++) {
      const at = 72 + section * 80;
      if (at + 80 > command.length) throw new Error("invalid section table");
      const name = command.subarray(at, at + 16).toString().replace(/\0.*$/, "");
      if (segment === "__BUN" && name === "__bun") graphSection = command.readUInt32LE(at + 48);
    }
  }
  commandOffset += commandSize;
}
if (buildVersions !== 1 || systemLibraries !== 1 || graphSection === null)
  throw new Error(`unexpected Mach-O layout: build=${buildVersions} system=${systemLibraries} graph=${graphSection}`);

const graphLength = Number(read(8, graphSection).readBigUInt64LE());
const graphStart = graphSection + 8;
const trailer = Buffer.from("\n---- Bun! ----\n");
if (graphStart + graphLength > fileSize) throw new Error("standalone graph exceeds file");
if (!read(trailer.length, graphStart + graphLength - trailer.length).equals(trailer)) throw new Error("bad standalone graph trailer");
const offsets = read(32, graphStart + graphLength - trailer.length - 32);
const byteCount = Number(offsets.readBigUInt64LE(0));
const modulesOffset = offsets.readUInt32LE(8);
const modulesLength = offsets.readUInt32LE(12);
const flags = offsets.readUInt32LE(28);
const recordSize = 52;
if (byteCount + 48 !== graphLength || modulesLength % recordSize) throw new Error("unknown standalone graph layout");
if (!(flags & (1 << 5))) throw new Error("standalone graph has no source hashes");
const moduleCount = modulesLength / recordSize;
if (moduleCount !== expected.modules) throw new Error(`expected ${expected.modules} modules, found ${moduleCount}`);
if (modulesOffset + modulesLength + moduleCount * 4 > byteCount) throw new Error("module metadata exceeds graph");

const replacements = [
  { before: Buffer.from("SharedArrayBuffer"), after: Buffer.from("ArrayBuffer      "), count: 0, expected: expected.sab },
  { before: Buffer.from("Atomics.wait(ct,0,0,t)"), after: Buffer.from("Bun.sleepSync(t)      "), count: 0, expected: expected.wait },
];
let bytecodeCount = 0;
for (let i = 0; i < moduleCount; i++) {
  const recordAt = graphStart + modulesOffset + i * recordSize;
  const record = read(recordSize, recordAt);
  const contentsOffset = record.readUInt32LE(8);
  const contentsLength = record.readUInt32LE(12);
  const bytecodeOffset = record.readUInt32LE(24);
  const bytecodeLength = record.readUInt32LE(28);
  if (contentsOffset + contentsLength > byteCount) throw new Error(`module ${i} source exceeds graph`);
  if (bytecodeLength) {
    if (bytecodeOffset + bytecodeLength > byteCount) throw new Error(`module ${i} bytecode exceeds graph`);
    writeChecked(recordAt + 28, record.subarray(28, 32), Buffer.alloc(4));
    bytecodeCount++;
  }
  if (!contentsLength) continue;
  const contents = read(contentsLength, graphStart + contentsOffset);
  for (const replacement of replacements) {
    let at = 0;
    while ((at = contents.indexOf(replacement.before, at)) !== -1) {
      replacement.after.copy(contents, at);
      replacement.count++;
      at += replacement.before.length;
    }
  }
  if (fs.writeSync(fd, contents, 0, contents.length, graphStart + contentsOffset) !== contents.length)
    throw new Error(`module ${i} source write was short`);
  if (!read(contents.length, graphStart + contentsOffset).equals(contents))
    throw new Error(`module ${i} source readback failed`);
}
if (bytecodeCount !== expected.bytecode) throw new Error(`expected ${expected.bytecode} bytecode modules, found ${bytecodeCount}`);
for (const replacement of replacements) {
  if (replacement.count !== replacement.expected)
    throw new Error(`${replacement.before}: expected ${replacement.expected} matches, found ${replacement.count}`);
}

const hashesAt = graphStart + modulesOffset + modulesLength;
if (fs.writeSync(fd, Buffer.alloc(moduleCount * 4), 0, moduleCount * 4, hashesAt) !== moduleCount * 4)
  throw new Error("source hash clear was short");
for (let i = 0; i < moduleCount; i++) {
  if (read(4, graphStart + modulesOffset + i * recordSize + 28).readUInt32LE() !== 0)
    throw new Error(`module ${i} bytecode length survived`);
}
if (!read(moduleCount * 4, hashesAt).equals(Buffer.alloc(moduleCount * 4))) throw new Error("source hash clear failed");
fs.closeSync(fd);
console.log(`patched ${moduleCount} modules; disabled ${bytecodeCount} bytecode entries; SAB=${expected.sab}, wait=${expected.wait}`);
