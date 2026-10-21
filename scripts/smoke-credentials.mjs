// Execute only the patched credential methods extracted from the repository
// download. No upstream entrypoint, imports, network, login or keychain runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { parse } from "acorn";
import { credentialContext, patchCredentials } from "./patch-credentials.mjs";

const root = path.resolve(import.meta.dirname, '..');
const input = path.resolve(process.argv[2] || '');
if (input !== path.join(root, 'build/upstream/package/claude') || fs.lstatSync(input).isSymbolicLink())
  throw Error('Only the repository download is accepted');
const binary = fs.readFileSync(input);
assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
let offset = 32, section;
for (let i = 0; i < binary.readUInt32LE(16); i++) {
  const command = binary.readUInt32LE(offset), size = binary.readUInt32LE(offset + 4);
  assert.ok(size >= 8 && offset + size <= binary.length);
  if (command === 0x19) {
    for (let j = 0; j < binary.readUInt32LE(offset + 64); j++) {
      const at = offset + 72 + j * 80;
      if (binary.subarray(at, at + 16).toString().replace(/\0.*$/, '') === '__bun')
        section = binary.readUInt32LE(at + 48);
    }
  }
  offset += size;
}
assert.ok(section);
const length = Number(binary.readBigUInt64LE(section)), start = section + 8;
assert.ok(start + length <= binary.length);
assert.equal(binary.subarray(start + length - 16, start + length).toString(), '\n---- Bun! ----\n');
const metadata = start + length - 48;
const byteCount = Number(binary.readBigUInt64LE(metadata));
const records = binary.readUInt32LE(metadata + 8), recordLength = binary.readUInt32LE(metadata + 12);
assert.equal(recordLength % 52, 0);
const modules = [];
for (let i = 0; i < recordLength / 52; i++) {
  const at = start + records + i * 52;
  const [no, nl, so, sl] = [0, 4, 8, 12].map((n) => binary.readUInt32LE(at + n));
  assert.ok(no + nl <= byteCount && so + sl <= byteCount);
  modules.push({ name: binary.subarray(start + no, start + no + nl).toString(),
    contents: Buffer.from(binary.subarray(start + so, start + so + sl)) });
}
const context = credentialContext(modules);
const apiModule = modules.find((m) => m.contents.includes('tengu_api_key_saved_to_keychain'));
assert.ok(apiModule);
const apiOriginal = apiModule.contents.toString('latin1');
const apiFunctions = parse(apiOriginal, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter((n) => n.type === 'FunctionDeclaration');
const apiRole = (anchor) => apiFunctions.filter((fn) => apiOriginal.slice(fn.body.start, fn.body.end).includes(anchor));
const apiReaders = apiRole('Failed to read API key from macOS keychain:');
const apiSave = apiRole('tengu_api_key_saved_to_keychain')[0];
const apiRemove = apiRole('security delete-generic-password')[0];
assert.equal(apiReaders.length, 2);
assert.ok(apiSave && apiRemove);
// Compare runtime Linux spoofing with the actual compiled Darwin selector.
// Run only extracted functions in a VM; do not change the host's process.
const original = modules.find((m) => m.name === context.module).contents.toString('latin1');
const originalTree = parse(original, { ecmaVersion: 'latest', sourceType: 'module' });
const selector = originalTree.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === context.selector);
const returnCall = selector.body.body.at(-1).argument;
const override = selector.body.body[0].test.name;
const linuxContext = {
  process: { platform: 'linux', env: {} }, [override]: undefined,
  [returnCall.callee.name]: (primary) => primary,
  [returnCall.arguments[0].name]: { name: 'keychain' },
  [returnCall.arguments[1].name]: { name: 'plaintext' },
};
vm.createContext(linuxContext);
const selected = vm.runInContext(original.slice(selector.start, selector.end) + `;${context.selector}().name`, linuxContext);
assert.equal(selected, 'keychain');
const platformModule = modules.find((m) => m.contents.includes('getLinuxDistroInfo()') && m.contents.includes('getPlatform()'));
assert.ok(platformModule);
const platformSource = platformModule.contents.toString('latin1');
const platformTree = parse(platformSource, { ecmaVersion: 'latest', sourceType: 'module' });
const detector = platformTree.body.find((n) => n.type === 'ClassDeclaration' &&
  n.body.body.some((m) => m.key.name === 'getPlatform'));
assert.ok(detector);
const detectorCode = platformSource.slice(detector.start, detector.end);
const detected = vm.runInNewContext(detectorCode +
  `;new ${detector.id.name}({platform:"linux",env:{},readProcVersionSync:()=>undefined}).getPlatform()`);
assert.equal(detected, 'linux');
console.log('Linux spoof experiment: platform detector reports linux; compiled credential selector still chooses keychain');
let rewrites = 0;
for (const module of modules) {
  const count = patchCredentials(module.contents, module.name, context);
  rewrites += count;
  if (count) parse(module.contents.toString('latin1'), { ecmaVersion: 'latest', sourceType: 'module' });
}
const source = modules.find((m) => m.name === context.module).contents.toString('latin1');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const code = (node) => source.slice(node.start, node.end);
function nodes(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...Object.values(node).flatMap((value) => Array.isArray(value)
      ? value.flatMap((child) => nodes(child, predicate)) : nodes(value, predicate)),
  ];
}
const declarations = tree.body.filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations);
const disk = declarations.find((n) => n.init?.type === 'ObjectExpression' && code(n.init).includes('warning:') &&
  code(n.init).includes('readStrict(') && code(n.init).includes('.readFile('));
assert.ok(disk);
const write = disk.init.properties.find((p) => p.key.name === 'write');
const writeCode = code(write.value.body);
const atomic = /await ([\w$]+)\([\w$]+,([\w$]+)\([\w$]+\),384\)/.exec(writeCode);
assert.ok(atomic);
const chmod = /await ([\w$]+)\([\w$]+,384\)/.exec(writeCode);
assert.ok(chmod);
// Bind the extracted methods by their roles; minifier names change on every
// upstream release. These are the actual patched read expressions.
const method = (name) => disk.init.properties.find((p) => p.key.name === name).value;
const read = method('read').body.body[0].block.body[0].argument;
const reader = read.arguments[0].argument;
const parseJSON = read.callee.name;
const ioName = reader.callee.object.callee.name;
const storagePath = reader.arguments[0].object.callee.name;
const failure = method('readStrict').body.body[0].handler.body.body[0].argument.alternate.name;
const warning = nodes(write, (n) => n.type === 'Property' && n.key?.name === 'warning')[0].value.name;
const finalizer = write.value.body.body[0].finalizer.body[0];
assert.equal(finalizer.type, 'IfStatement');
const diskless = finalizer.test.callee.name;
const invalidate = finalizer.consequent.expression.callee.name;
const errorCode = nodes(method('remove'), (n) => n.type === 'BinaryExpression' && n.right.value === 'ENOENT')[0].left.callee.name;
const ioSource = modules.find((m) => m.name === context.ioModule).contents.toString('latin1');
const ioTree = parse(ioSource, { ecmaVersion: 'latest', sourceType: 'module' });
const ioObject = ioTree.body.filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations)
  .find((n) => n.init?.type === 'ObjectExpression' && n.init.properties.some((p) => p.key?.name === 'openDirNoFollow')).init;
const ioPrimitives = {}, forwarding = [];
for (const name of ['readFile', 'readFileSync']) {
  const fn = ioObject.properties.find((p) => p.key?.name === name).value;
  const expression = fn.body.body.find((n) => n.type === 'ReturnStatement').argument;
  if (name === 'readFile') ioPrimitives[expression.callee.name] = fs.promises.readFile;
  else ioPrimitives[expression.callee.object.name] = fs;
  // Profiling instrumentation is omitted; the patched options-forwarding
  // expression is executed unchanged against the actual filesystem.
  forwarding.push(`${fn.async ? 'async ' : ''}${name}(${fn.params.map((p) => p.name).join(',')}){return ${ioSource.slice(expression.start, expression.end)}}`);
}
const room = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-file-smoke-'));
try {
  const file = path.join(room, '.credentials.json');
  const sandbox = {
    // Only primitives used by the extracted file object are supplied. No
    // process, require, imports or upstream session state enters this context.
    [parseJSON]: JSON.parse, [atomic[2]]: JSON.stringify, [failure]: Symbol('failed'), [warning]: 'plaintext',
    [errorCode]: (e) => e.code, [diskless]: () => false, [invalidate]: () => {},
    [storagePath]: () => ({ storageDir: room, storagePath: file }),
    [chmod[1]]: fs.promises.chmod,
    [atomic[1]]: async (p, data, mode) => {
      assert.equal(p, file);
      await fs.promises.writeFile(file + '.tmp', data, { mode });
      await fs.promises.rename(file + '.tmp', file);
    },
    ...ioPrimitives,
  };
  vm.createContext(sandbox);
  const facade = vm.runInContext(`({${forwarding.join(',')}})`, sandbox);
  sandbox[ioName] = () => ({ ...fs, ...fs.promises, ...facade,
    mkdir: async (p) => fs.promises.mkdir(p, { recursive: true }) });
  vm.runInContext(`globalThis.store=${code(disk.init)};`, sandbox);
  const store = sandbox.store;
  assert.equal(await store.read(), null);
  assert.equal((await store.write({ claudeAiOauth: { accessToken: 'fixture-only' }, primaryApiKey: 'fake-key' })).success, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await store.readStrict()).claudeAiOauth.accessToken, 'fixture-only');
  const apiSource = apiModule.contents.toString('latin1');
  const patchedApiFunctions = parse(apiSource, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter((n) => n.type === 'FunctionDeclaration');
  const roles = [...apiReaders, apiSave, apiRemove];
  let config = { primaryApiKey: 'legacy-fixture' };
  const backend = { ...store, read: () => JSON.parse(facade.readFileSync(file, { encoding: 'utf8', flag: 256 })),
    readAsync: () => store.read(), mutate: async (fn) => {
      const current = await store.readStrict();
      if (current === sandbox[failure]) return { success: false };
      return store.write(fn(current ?? {}));
    } };
  const save = patchedApiFunctions.find((fn) => fn.id.name === apiSave.id.name);
  const readerFunction = patchedApiFunctions.find((fn) => fn.id.name === apiReaders[0].id.name);
  const key = save.params[0].name;
  const cache = save.body.body.find((n) => n.type === 'VariableDeclaration' && n.declarations[0].init?.type === 'CallExpression');
  const hash = nodes(save, (n) => n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression' && n.init.arguments[0]?.name === key)[0];
  const awaits = nodes(save, (n) => n.type === 'AwaitExpression' && n.argument.callee?.type === 'Identifier').map((n) => n.argument);
  const refresh = awaits.find((n) => n.arguments.length === 0);
  const update = awaits.find((n) => n.arguments[0]?.type === 'ArrowFunctionExpression');
  const responses = nodes(update.arguments[0], (n) => n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern')[0].init;
  const last = save.body.body.at(-1).expression;
  assert.equal(last.type, 'SequenceExpression');
  Object.assign(sandbox, {
    [context.selector]: () => backend,
    [readerFunction.body.body[0].test.callee.name]: () => false,
    [cache.declarations[0].init.callee.name]: () => ({ clear() {} }),
    [refresh.callee.name]: async () => {},
    [save.body.body[0].test.argument.callee.name]: (key) => /^[a-zA-Z0-9_-]+$/.test(key),
    [hash.init.callee.name]: (key) => key.slice(-20),
    [update.callee.name]: async (fn) => { config = fn(config); },
    [responses.callee.name]: () => ({ approved: [], rejected: [] }),
    [last.expressions.at(-1).callee.name]: () => {},
  });
  for (const role of roles) {
    const fn = patchedApiFunctions.find((fn) => fn.id.name === role.id.name);
    vm.runInContext(apiSource.slice(fn.start, fn.end), sandbox);
  }
  await sandbox[apiSave.id.name]('sk-fixture-only');
  assert.equal(config.primaryApiKey, undefined, 'API key leaked to ordinary config');
  for (const reader of apiReaders)
    assert.equal((await sandbox[reader.id.name]()).key, 'sk-fixture-only');
  assert.equal((await store.read()).claudeAiOauth.accessToken, 'fixture-only');
  await sandbox[apiRemove.id.name]();
  assert.equal((await store.read()).primaryApiKey, undefined);
  assert.equal((await store.read()).claudeAiOauth.accessToken, 'fixture-only');
  assert.equal((await store.write({ claudeAiOauth: { accessToken: 'refreshed-fixture' } })).success, true);
  assert.equal((await store.read()).claudeAiOauth.accessToken, 'refreshed-fixture');
  await fs.promises.writeFile(file, 'invalid');
  assert.equal(await store.readStrict(), sandbox[failure]);
  await fs.promises.unlink(file);
  await fs.promises.writeFile(path.join(room, 'target'), '{}');
  await fs.promises.symlink(path.join(room, 'target'), file);
  assert.equal(await store.readStrict(), sandbox[failure]);
  assert.equal(await store.remove(), true);
  assert.equal(await store.read(), null);
  console.log(`Patched upstream methods: temporary OAuth/API file read/write, API removal preserving OAuth, refresh save, 0600, corruption, symlink and delete passed (${rewrites} source edits)`);
} finally {
  fs.rmSync(room, { recursive: true, force: true });
}
