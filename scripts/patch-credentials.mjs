import { parse } from "acorn";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

const text = (source, node) => source.slice(node.start, node.end);
const ast = (source) => parse(source, { ecmaVersion: "latest", sourceType: "module" });
function nodes(tree, predicate) {
  const result = [];
  walk(tree, (node) => { if (predicate(node)) result.push(node); });
  return result;
}
function one(values, label) {
  if (values.length !== 1) throw Error(`unrecognised credential layout: ${label} (${values.length})`);
  return values[0];
}

// Discover the storage selector from its objects, not release-specific symbols.
export function credentialContext(modules) {
  const module = one(modules.filter(({ contents }) => contents.includes('name:"plaintext"') &&
    contents.includes('name:"keychain"')), "credential module");
  const source = module.contents.toString("latin1"), tree = ast(source);
  const binding = (name) => one(nodes(tree, (n) => n.type === "VariableDeclarator" &&
    n.init?.type === "ObjectExpression" && n.init.properties.some((p) =>
      p.key?.name === "name" && p.value?.value === name)), name).id.name;
  const plain = binding("plaintext"), keychain = binding("keychain");
  const selector = one(nodes(tree, (n) => n.type === "FunctionDeclaration" &&
    n.body.body.at(-1)?.type === 'ReturnStatement' &&
    n.body.body.at(-1).argument?.type === 'CallExpression' &&
    n.body.body.at(-1).argument.arguments.length === 2 &&
    n.body.body.at(-1).argument.arguments[0].name === keychain &&
    n.body.body.at(-1).argument.arguments[1].name === plain), "selector");
  const directories = modules.filter(({ name, contents }) => name.endsWith('.js') &&
    contents.includes('process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR')).flatMap((module) => {
    const source = module.contents.toString('latin1');
    return nodes(ast(source), (n) => n.type === 'FunctionDeclaration' && n.params.length === 0 &&
      n.body.body[0]?.type === 'VariableDeclaration' && n.body.body[0].declarations.length === 1 &&
      n.body.body[0].declarations[0].init?.type === 'MemberExpression' &&
      text(source, n.body.body[0].declarations[0].init) === 'process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR' &&
      text(source, n.body).includes('.normalize("NFC")')).map((directory) => ({ module, directory }));
  });
  const { module: directoryModule, directory } = one(directories, 'credential directory');
  // Callers may import the directory itself or a guard around it that
  // returns null (2.1.300: `diskless()?null:directory()`).
  const directorySource = directoryModule.contents.toString('latin1');
  const guards = nodes(ast(directorySource), (n) => n.type === 'FunctionDeclaration' && n.params.length === 0 &&
    n.body.body.length === 1 && n.body.body[0].type === 'ReturnStatement' &&
    n.body.body[0].argument?.type === 'ConditionalExpression' &&
    n.body.body[0].argument.consequent.type === 'Literal' && n.body.body[0].argument.consequent.value === null &&
    n.body.body[0].argument.alternate.type === 'CallExpression' &&
    n.body.body[0].argument.alternate.arguments.length === 0 &&
    n.body.body[0].argument.alternate.callee.name === directory.id.name).map((n) => n.id.name);
  const syncCall = one(nodes(tree, (n) => n.type === 'CallExpression' && n.callee.property?.name === 'readFileSync'), 'credential sync I/O');
  const io = syncCall.callee.object.callee.name;
  const ioImport = one(tree.body.filter((n) => n.type === 'ImportDeclaration' &&
    n.specifiers.some((s) => s.local.name === io)), 'credential I/O import');
  return { module: module.name, selector: selector.id.name, plain,
    directoryModule: directoryModule.name, directory: directory.id.name,
    directories: [directory.id.name, ...guards], ioModule: ioImport.source.value };
}

export function patchCredentials(contents, name, context) {
  const source = contents.toString("latin1");
  if (!name.endsWith('.js') && !name.endsWith('/cli')) return 0;
  if (!/security|Security\.framework|SecItem|SecKeychain|\.device-keys\.json/.test(source) &&
      name !== context.module && name !== context.ioModule) return 0;
  const tree = ast(source), edits = [];
  if (/Security\.framework|SecItem(?:Add|CopyMatching|Delete|Update)|SecKeychain/.test(source))
    throw Error(`${name}: unrecognised native keychain access`);
  const add = (node, replacement) => {
    if (replacement.length > node.end - node.start) throw Error(`${name}: credential rewrite does not fit`);
    edits.push({ start: node.start, end: node.end, replacement });
  };
  const functions = nodes(tree, (n) => n.type === "FunctionDeclaration");
  const body = (fn, replacement) => add(fn.body, `{${replacement}}`);
  let storage;
  for (const item of tree.body.filter((n) => n.type === "ImportDeclaration" && n.source.value === context.module))
    storage = item.specifiers.find((s) => s.imported?.name === context.selector)?.local.name;

  if (name === context.ioModule) {
    // Upstream's facade drops all read options except encoding. Pass the
    // options through so O_NOFOLLOW actually reaches fs on Darwin/iOS.
    const object = one(nodes(tree, (n) => n.type === 'ObjectExpression' &&
      ['readFile', 'readFileSync', 'openDirNoFollow'].every((key) => n.properties.some((p) => p.key?.name === key))), 'filesystem facade');
    for (const method of ['readFile', 'readFileSync']) {
      const fn = one(object.properties.filter((p) => p.key.name === method), method).value;
      const call = one(nodes(fn.body, (n) => n.type === 'ReturnStatement' && n.argument?.type === 'CallExpression'), 'read forwarding').argument;
      const options = call.arguments[1];
      if (options?.type !== 'ObjectExpression' || options.properties.length !== 1 ||
          options.properties[0].key.name !== 'encoding' || fn.params.length !== 2 ||
          text(source, options.properties[0].value) !== `${fn.params[1].name}.encoding`)
        throw Error(`${name}: unsupported filesystem read facade`);
      add(options, fn.params[1].name);
    }
  }

  if (name === context.module) {
    const fn = one(functions.filter((n) => n.id.name === context.selector), "selector");
    if (!/^\{if\([\w$]+\)return [\w$]+;return [\w$]+\([\w$]+,[\w$]+\)\}$/.test(text(source, fn.body)))
      throw Error(`${name}: unsupported credential selector`);
    body(fn, `return ${context.plain};`);
    const label = one(functions.filter((n) => text(source, n.body) === '{return"keychain"}'), "storage label");
    body(label, 'return"file";');
    const plainObject = one(nodes(tree, (n) => n.type === "VariableDeclarator" && n.id.name === context.plain), "file storage").init;
    const read = one(plainObject.properties.filter((p) => p.key.name === "read"), "sync file read");
    const readCall = one(nodes(read, (n) => n.type === "CallExpression" && n.callee.property?.name === "readFileSync"), "sync reader");
    const io = text(source, readCall.callee.object);
    const path = one(functions.filter((fn) => text(source, fn.body).includes('storagePath:') &&
      text(source, fn.body).includes('".credentials.json"')), "file path").id.name;
    const parser = one(nodes(read, (n) => n.type === "ReturnStatement" && n.argument?.type === "CallExpression" &&
      n.argument.arguments.length === 1 && n.argument.arguments[0].type === "Identifier"), "credential parser").argument.callee.name;
    // O_NOFOLLOW is 0x100 on Darwin/iOS. The host smoke also uses Darwin.
    add(read.value.body, `{try{return ${parser}(${io}.readFileSync(${path}().storagePath,{encoding:"utf8",flag:256}))}catch{return null}}`);
    const asyncBackend = one(nodes(tree, (n) => n.type === "VariableDeclarator" && n.init?.type === "ObjectExpression" &&
      text(source, n.init).includes('warning:') && text(source, n.init).includes('readStrict(') &&
      text(source, n.init).includes('.readFile(')), "async file backend");
    const method = (name) => one(asyncBackend.init.properties.filter((p) => p.key.name === name), name).value.body;
    const strict = method('readStrict');
    const failure = one(nodes(strict, (n) => n.type === "ReturnStatement" && n.argument?.type === "Identifier"), "read failure sentinel").argument.name;
    add(method('read'), `{try{return ${parser}(await ${io}.readFile(${path}().storagePath,{encoding:"utf8",flag:256}))}catch{return null}}`);
    add(strict, `{try{return ${parser}(await ${io}.readFile(${path}().storagePath,{encoding:"utf8",flag:256}))}catch(e){return e.code==="ENOENT"?null:${failure}}}`);
    const router = one(functions.filter((fn) => fn.body.body.at(-1)?.argument?.alternate?.alternate?.name === asyncBackend.id.name &&
      text(source, fn.body).includes('!==void 0?')), "async storage router");
    body(router, `return ${asyncBackend.id.name};`);
  }

  if (source.includes('[deviceKeyStore]')) {
    const init = one(nodes(tree, (n) => n.type === "VariableDeclarator" &&
      n.init?.type === "CallExpression" && functions.some((fn) => fn.id.name === n.init.callee.name &&
        text(source, fn.body).includes('name:"file"'))), "device file backend");
    const keychain = one(nodes(tree, (n) => n.type === "VariableDeclarator" &&
      n.init?.type === "CallExpression" && functions.some((fn) => fn.id.name === n.init.callee.name &&
        text(source, fn.body).includes('name:"keychain"'))), "device keychain backend");
    // The guards before the keychain default vary by release (2.1.300 adds a
    // diskless backend); the selector only guards and then returns it.
    const selector = one(functions.filter((fn) => fn.params.length === 0 && fn.body.body.length >= 2 &&
      fn.body.body.at(-1).type === 'ReturnStatement' && fn.body.body.at(-1).argument?.name === keychain.id.name &&
      fn.body.body.slice(0, -1).every((n) => n.type === 'IfStatement' && !n.alternate &&
        n.consequent.type === 'ReturnStatement' && n.consequent.argument?.type === 'Identifier')), "device selector");
    body(selector, `return ${init.id.name};`);
    const factory = one(functions.filter((fn) => fn.id.name === init.init.callee.name), 'device file factory');
    const read = one(nodes(factory, (n) => n.type === 'Property' && n.key.name === 'read'), 'device file reader').value.body;
    const call = one(nodes(read, (n) => n.type === 'CallExpression' && n.callee.property?.name === 'readFile'), 'device file read');
    if (text(source, call.arguments[1]) !== '{encoding:"utf8"}') throw Error(`${name}: unknown device read options`);
    const code = text(source, read);
    if (!code.includes('[deviceKeyStore] file read failed:')) throw Error(`${name}: unknown device read error`);
    add(read, code.replace('{encoding:"utf8"}', '{encoding:"utf8",flag:256}')
      .replace('[deviceKeyStore] file read failed:', 'Device key read failed:'));
  }
  if (source.includes('".device-keys.json"') && source.includes('".credentials.json"')) {
    const path = one(functions.filter((fn) => /return [\w$]+\([\w$]+\(\),"\.claude",[\w$]+\)\.normalize\("NFC"\)/.test(text(source, fn.body))), "device path");
    const [, join, home, file] = /return ([\w$]+)\(([\w$]+)\(\),"\.claude",([\w$]+)\)/.exec(text(source, path.body));
    const imports = tree.body.filter((n) => n.type === "ImportDeclaration" && n.source.value === context.directoryModule);
    const directory = one(imports.flatMap((n) => n.specifiers).filter((s) => context.directories.includes(s.imported?.name)), "device credential directory import").local.name;
    // A guard's null keeps upstream's own ~/.claude location.
    body(path, `return ${join}(${directory}()??${home}()+"/.claude",${file});`);
  }

  const apiReads = functions.filter((fn) => text(source, fn.body).includes('Failed to read API key from macOS keychain:'));
  if (apiReads.length) {
    if (!storage || apiReads.length !== 2) throw Error(`${name}: unsupported API key readers`);
    for (const fn of apiReads) {
      const guard = fn.body.body[0];
      if (guard.type !== 'IfStatement' || guard.consequent.type !== 'ReturnStatement' || guard.consequent.argument?.value !== null)
        throw Error(`${name}: unsupported API key authentication guard`);
      body(fn, `${text(source, guard)}let c=${fn.async ? 'await ' : ''}${storage}().${fn.async ? 'readAsync' : 'read'}();return c?.primaryApiKey?{key:c.primaryApiKey,source:"/login managed key"}:null;`);
    }
    const save = one(functions.filter((fn) => text(source, fn.body).includes('tengu_api_key_saved_to_keychain')), "API key writer");
    const flag = one(nodes(save.body, (n) => n.type === "VariableDeclarator" && n.init?.type === "UnaryExpression" &&
      text(source, n.init) === '!0'), "API key keychain flag");
    add(flag.init, '!1');
    const property = one(nodes(save.body, (n) => n.type === "Property" && n.key.name === "primaryApiKey"), "API key config property");
    if (property.value.type !== "ConditionalExpression" || property.value.test.name !== flag.id.name)
      throw Error(`${name}: unsupported API key config write`);
    const key = property.value.alternate.name;
    add(property.value, 'void 0');
    // Use the space occupied by the disabled keychain branch for the file write.
    const branch = one(nodes(save.body, (n) => n.type === "IfStatement" && n.test.name === flag.id.name), "API key write branch");
    add(branch, `if(!(await ${storage}().mutate(c=>({...c,primaryApiKey:${key}}))).success)throw Error("Cannot save API key");`);
    const remove = one(functions.filter((fn) => text(source, fn.body).includes('security delete-generic-password')), "API key removal");
    body(remove, `if(!(await ${storage}().mutate(c=>{let{primaryApiKey:k,...r}=c;return r})).success)throw Error("Cannot remove API key");`);
  }

  for (const fn of functions) {
    const code = text(source, fn.body);
    if (code.includes('Claude Code-doctor-probe')) body(fn, 'return null;');
    if (code.includes('"show-keychain-info"')) body(fn, 'return false;');
  }
  // Known calls in dormant backends cannot reach macOS security. An unexpected
  // reachable call fails explicitly rather than claiming a successful write;
  // an unknown command shape stops the build. Parent rewrites supersede guards.
  for (const call of nodes(tree, (n) => n.type === "CallExpression")) {
    const arg = call.arguments[0];
    if (typeof arg?.value === 'string' && arg.value.startsWith('/') && /\/security(?: |$)/.test(arg.value))
      throw Error(`${name}: unsupported absolute security command`);
    if (typeof arg?.value === 'string' && arg.value.startsWith('security '))
      throw Error(`${name}: unsupported literal security shell command`);
    if (arg?.value === "security" || (arg?.type === "TemplateLiteral" &&
        arg.quasis[0].value.raw.startsWith('security '))) {
      const operation = arg.value === 'security' ? call.arguments[1]?.elements?.[0]?.value :
        arg.quasis[0].value.raw.split(' ')[1];
      if (!['find-generic-password', 'add-generic-password', 'delete-generic-password', 'show-keychain-info', '-i'].includes(operation))
        throw Error(`${name}: unsupported security operation ${operation}`);
      if (!edits.some((edit) => edit.start <= call.start && edit.end >= call.end))
        add(call, '(()=>{throw Error("No keychain")})()');
    }
  }
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  let end = -1, count = 0;
  for (const edit of edits) {
    if (edit.start < end) {
      if (edit.end > end) throw Error(`${name}: overlapping credential rewrites`);
      continue;
    }
    Buffer.from(edit.replacement.padEnd(edit.end - edit.start), "latin1").copy(contents, edit.start);
    end = edit.end;
    count++;
  }
  return count;
}
