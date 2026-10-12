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
const declarations = tree.body.filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations);
const disk = declarations.find((n) => n.init?.type === 'ObjectExpression' && code(n.init).includes('warning:') &&
  code(n.init).includes('readStrict(') && code(n.init).includes('.readFile('));
assert.ok(disk);
const write = disk.init.properties.find((p) => p.key.name === 'write');
const writeCode = code(write.value.body);
const atomic = /await ([\w$]+)\([\w$]+,_\([\w$]+\),384\)/.exec(writeCode);
assert.ok(atomic);
const chmod = /await ([\w$]+)\([\w$]+,384\)/.exec(writeCode);
assert.ok(chmod);
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
    Y: JSON.parse, _: JSON.stringify, La: Symbol('failed'), DAr: 'plaintext',
    E: (e) => e.code, j: () => false, Exe: () => {},
    u: () => ({ storageDir: room, storagePath: file }),
    ie: () => ({ ...fs, ...fs.promises, mkdir: async (p) => fs.promises.mkdir(p, { recursive: true }) }),
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
  sandbox.ie = () => ({ ...fs, ...fs.promises, ...facade,
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
      if (current === sandbox.La) return { success: false };
      return store.write(fn(current ?? {}));
    } };
  Object.assign(sandbox, {
    [context.selector]: () => backend,
    on: () => false, Ni: () => ({ clear() {} }), Nk: async () => {},
    Z$: (key) => /^[a-zA-Z0-9-_]+$/.test(key), Qde: (key) => key.slice(-20),
    Ce: async (fn) => { config = fn(config); }, uD: () => ({ approved: [], rejected: [] }), GAr: () => {},
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
  assert.equal(await store.readStrict(), sandbox.La);
  await fs.promises.unlink(file);
  await fs.promises.writeFile(path.join(room, 'target'), '{}');
  await fs.promises.symlink(path.join(room, 'target'), file);
  assert.equal(await store.readStrict(), sandbox.La);
  assert.equal(await store.remove(), true);
  assert.equal(await store.read(), null);
  console.log(`Patched upstream methods: temporary OAuth/API file read/write, API removal preserving OAuth, refresh save, 0600, corruption, symlink and delete passed (${rewrites} source edits)`);
} finally {
  fs.rmSync(room, { recursive: true, force: true });
}
