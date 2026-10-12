import assert from "node:assert/strict";
import test from "node:test";
import { patchSource } from "./patch-source.mjs";
import { credentialContext, patchCredentials } from "./patch-credentials.mjs";
import vm from "node:vm";

function credentialFixture() {
  const room = '/*' + ' '.repeat(200) + '*/';
  return [
    { name: '/dir.js', contents: Buffer.from('function dir(){let x=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(x!==void 0)return x.normalize("NFC");return home()}') },
    { name: '/store.js', contents: Buffer.from(
      'import{io}from"/io.js";var failed=Symbol(),kc={name:"keychain",read(){return run("security",["find-generic-password"])}};' +
      'function path(){let x=dir(),y=".credentials.json";return{storageDir:x,storagePath:join(x,".credentials.json")}}' +
      `var disk={async read(){let{storagePath:p}=path();try{let x=await io().readFile(p,{encoding:"utf8"});return JSONparse(x)}catch{return null}${room}},` +
      `async readStrict(){try{return JSONparse(await io().readFile(path().storagePath))}catch{ return failed }${room}},` +
      'async write(x){return{success:true,warning:"plaintext"}},async remove(){return true}};' +
      'function route(e){return enabled()&&e!==void 0?adapter(e):blocked()?empty:disk}' +
      `var plain={name:"plaintext",read(){let{storagePath:p}=path();try{let x=io().readFileSync(p,{encoding:"utf8"});return JSONparse(x)}catch{return null}${room}},readAsync(e){return route(e).read()}};` +
      'function kind(){return"keychain"}function choose(){if(override)return override;return combine(kc,plain)}') },
  ];
}

test('credential selector uses files, strict reads refuse symlinks and corruption', async () => {
  const modules = credentialFixture(), context = credentialContext(modules);
  const buffer = modules[1].contents, length = buffer.length;
  assert.ok(patchCredentials(buffer, '/store.js', context));
  assert.equal(buffer.length, length);
  let value = '{"primaryApiKey":"fixture-only"}', error;
  const read = (_path, options) => {
    assert.equal(options.flag, 256);
    if (error) throw Object.assign(Error('fixture'), { code: error });
    return value;
  };
  const sandbox = { dir: () => '/fixture', join: (...x) => x.join('/'), JSONparse: JSON.parse,
    io: () => ({ readFile: async (...x) => read(...x), readFileSync: read }),
    run: () => assert.fail('security was invoked') };
  vm.createContext(sandbox);
    vm.runInContext(buffer.toString().replace('import{io}from"/io.js";', '') + ';globalThis.store=choose();globalThis.disk=disk;globalThis.failed=failed;', sandbox);
  assert.equal(sandbox.store.name, 'plaintext');
  assert.equal(sandbox.store.read().primaryApiKey, 'fixture-only');
  assert.equal((await sandbox.store.readAsync()).primaryApiKey, 'fixture-only');
  error = 'ENOENT'; assert.equal(await sandbox.disk.readStrict(), null);
  error = 'ELOOP'; assert.equal(await sandbox.disk.readStrict(), sandbox.failed);
  error = undefined; value = 'broken'; assert.equal(await sandbox.disk.readStrict(), sandbox.failed);
});

test('credential discovery rejects an unknown selector and guards residual commands', () => {
  const modules = credentialFixture(), context = credentialContext(modules);
  const command = Buffer.from('function probe(){return spawn("security",["show-keychain-info"])}');
  patchCredentials(command, '/probe.js', context);
  assert.equal(vm.runInNewContext(command.toString() + ';probe()'), false);
  const unexpected = Buffer.from('function probe(){return spawn("security",["find-generic-password"],{timeout:2000})}');
  patchCredentials(unexpected, '/probe.js', context);
  assert.throws(() => vm.runInNewContext(unexpected.toString() + ';probe()'), /No keychain/);
  assert.throws(() => patchCredentials(Buffer.from('spawn("security",["new-operation"])'), '/new.js', context), /unsupported security operation/);
  assert.throws(() => patchCredentials(Buffer.from('spawn("/usr/bin/security",[])'), '/new.js', context), /unsupported absolute/);
  assert.throws(() => patchCredentials(Buffer.from('load("Security.framework")'), '/new.js', context), /native keychain/);
  modules[1].contents = Buffer.from(modules[1].contents.toString().replace('combine(kc,plain)', 'changed(kc)'));
  assert.throws(() => credentialContext(modules), /unrecognised credential layout/);
});

test('credential discovery tolerates minifier renames including dollar identifiers', () => {
  const modules = credentialFixture();
  for (const module of modules)
    module.contents = Buffer.from(module.contents.toString().replace(/\b(?:dir|kc|plain|choose|disk)\b/g, (name) => '$' + name));
  const context = credentialContext(modules);
  assert.equal(context.selector, '$choose');
  assert.equal(context.directory, '$dir');
  assert.ok(patchCredentials(modules[1].contents, '/store.js', context));
});

test('filesystem facade forwards credential no-follow flags', async () => {
  const context = credentialContext(credentialFixture());
  const source = Buffer.from('var io={async readFile(p,o){return read(p,{encoding:o.encoding})},readFileSync(p,o){return fs.readFileSync(p,{encoding:o.encoding})},openDirNoFollow(){}};');
  assert.equal(patchCredentials(source, '/io.js', context), 2);
  const options = { encoding: 'utf8', flag: 256 };
  const sandbox = { read: (_p, o) => o, fs: { readFileSync: (_p, o) => o } };
  const io = vm.runInNewContext(source.toString() + ';io', sandbox);
  assert.equal(io.readFileSync('/fixture', options), options);
  assert.equal(await io.readFile('/fixture', options), options);
});

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
