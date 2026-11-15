#!/usr/bin/env node
import { openSync, readSync, writeSync, closeSync, fstatSync } from "node:fs";

const LC_SEGMENT_64 = 0x19;
const LC_FUNCTION_STARTS = 0x26;
const HEADER_RESERVE = 256;
const ISLAND_BYTES = 12;
const BRANCH_REACH = 1 << 27;
const PREFERRED_DISPLACEMENTS = new Set([-8]);

const [, , path] = process.argv;
if (!path) {
  console.error("usage: patch-ordered-loads.mjs <mach-o>");
  process.exit(64);
}

const file = openSync(path, "r+");
const read = (offset, length) => {
  const bytes = Buffer.alloc(length);
  if (readSync(file, bytes, 0, length, offset) !== length) throw new Error("short read");
  return bytes;
};
const text = (bytes, offset) => bytes.subarray(offset, offset + 16).toString("latin1").replace(/\0.*$/s, "");

const header = read(0, 32);
if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) {
  throw new Error("not a thin arm64 Mach-O");
}
const commandBytes = header.readUInt32LE(20);
const commands = read(32, commandBytes);

let segment, code, functionStarts;
let firstSectionOffset = Infinity;
for (let cursor = 0, index = 0; index < header.readUInt32LE(16); index++) {
  const command = commands.readUInt32LE(cursor);
  const size = commands.readUInt32LE(cursor + 4);
  if (command === LC_SEGMENT_64) {
    const name = text(commands, cursor + 8);
    const address = Number(commands.readBigUInt64LE(cursor + 24));
    const fileOffset = Number(commands.readBigUInt64LE(cursor + 40));
    if (name === "__TEXT") segment = { address, fileOffset };
    for (let number = 0; number < commands.readUInt32LE(cursor + 64); number++) {
      const section = cursor + 72 + 80 * number;
      const offset = commands.readUInt32LE(section + 48);
      if (offset) firstSectionOffset = Math.min(firstSectionOffset, offset);
      if (name === "__TEXT" && text(commands, section) === "__text") {
        code = {
          address: Number(commands.readBigUInt64LE(section + 32)),
          size: Number(commands.readBigUInt64LE(section + 40)),
          offset,
        };
      }
    }
  } else if (command === LC_FUNCTION_STARTS) {
    functionStarts = { offset: commands.readUInt32LE(cursor + 8), size: commands.readUInt32LE(cursor + 12) };
  }
  cursor += size;
}
if (!segment || !code || !functionStarts || segment.fileOffset !== 0) throw new Error("unrecognised Mach-O layout");

const spaceStart = (32 + commandBytes + HEADER_RESERVE + 3) & ~3;
const spaceEnd = firstSectionOffset & ~3;
if (spaceEnd <= spaceStart) throw new Error("no room after the load commands");
if (read(spaceStart, spaceEnd - spaceStart).some((byte) => byte !== 0)) {
  throw new Error("the space after the load commands is already in use");
}

const functions = [];
{
  const encoded = read(functionStarts.offset, functionStarts.size);
  let address = segment.address;
  for (let cursor = 0; cursor < encoded.length; ) {
    let delta = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded[cursor++];
      delta += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (!delta) break;
    address += delta;
    functions.push(address);
  }
}
const functionOf = (address) => {
  let low = 0;
  let high = functions.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (functions[middle] <= address) low = middle;
    else high = middle - 1;
  }
  return functions[low];
};

const instructions = read(code.offset, code.size);
const callers = new Map();
const loads = [];
for (let offset = 0; offset + 4 <= instructions.length; offset += 4) {
  const word = instructions.readUInt32LE(offset);
  if ((word & 0x7c000000) === 0x14000000) {
    const displacement = ((word << 6) >> 6) * 4;
    const target = code.address + offset + displacement;
    callers.set(target, (callers.get(target) ?? 0) + 1);
  } else if ((word & 0x3fe00c00) === 0x19400000 && (word & 31) !== 31) {
    loads.push({ offset, word, displacement: (word << 11) >> 23 });
  }
}

for (const load of loads) {
  load.preferred = PREFERRED_DISPLACEMENTS.has(load.displacement);
  load.callers = callers.get(functionOf(code.address + load.offset)) ?? 0;
}
loads.sort((a, b) => b.preferred - a.preferred || b.callers - a.callers || a.offset - b.offset);

const acquire = [0x38bfc000, 0x78bfc000, 0xb8bfc000, 0xf8bfc000];
const branch = (from, to) => {
  const distance = to - from;
  if (distance % 4 || Math.abs(distance) >= BRANCH_REACH) throw new Error("branch out of reach");
  return (0x14000000 | ((distance >> 2) & 0x03ffffff)) >>> 0;
};

const capacity = Math.floor((spaceEnd - spaceStart) / ISLAND_BYTES);
const chosen = loads.slice(0, capacity);
const islands = Buffer.alloc(chosen.length * ISLAND_BYTES);
chosen.forEach((load, index) => {
  const target = load.word & 31;
  const base = (load.word >>> 5) & 31;
  const magnitude = Math.abs(load.displacement);
  const site = code.address + load.offset;
  const island = segment.address + spaceStart + index * ISLAND_BYTES;
  const adjust = ((load.displacement < 0 ? 0xd1000000 : 0x91000000) | (magnitude << 10) | (base << 5) | target) >>> 0;
  islands.writeUInt32LE(adjust, index * ISLAND_BYTES);
  islands.writeUInt32LE((acquire[load.word >>> 30] | (target << 5) | target) >>> 0, index * ISLAND_BYTES + 4);
  islands.writeUInt32LE(branch(island + 8, site + 4), index * ISLAND_BYTES + 8);
  instructions.writeUInt32LE(branch(site, island), load.offset);
});

writeSync(file, islands, 0, islands.length, spaceStart);
for (const load of chosen) {
  writeSync(file, instructions, load.offset, 4, code.offset + load.offset);
}
if (fstatSync(file).size < code.offset + code.size) throw new Error("file shrank");
closeSync(file);
console.log(
  `ordered loads: ${chosen.length} of ${loads.length} rewritten for ARMv8.3 ` +
    `(${chosen.filter((load) => load.preferred).length} by displacement, the rest by callers); ` +
    `${loads.length - chosen.length} left to the illegal-instruction handler`,
);
