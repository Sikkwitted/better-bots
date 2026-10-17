import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const omitted = new Set(['node_modules','.git','.data','.better-bots-release.json']);
export function releaseManifest(root) {
  const files = {};
  function visit(relative='') {
    for (const name of fs.readdirSync(path.join(root,relative)).sort()) {
      if (!relative && omitted.has(name)) continue;
      const key=path.posix.join(relative,name), file=path.join(root,key), stat=fs.lstatSync(file);
      if (stat.isDirectory()) visit(key);
      else if (stat.isFile() || stat.isSymbolicLink()) files[key]=createHash('sha256')
        .update(stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(file)}` : fs.readFileSync(file)).digest('hex');
      else throw new Error(`Unsupported release entry: ${key}`);
    }
  }
  visit();
  return { fingerprint:createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
export function verifyRelease(root, expected=null) {
  const current=releaseManifest(root);
  let saved;
  try { saved=JSON.parse(fs.readFileSync(path.join(root,'.better-bots-release.json'),'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if (current.fingerprint !== (expected || saved?.fingerprint)) {
    const changed=Object.keys({...saved?.files,...current.files}).filter(file=>saved?.files?.[file]!==current.files[file]);
    throw new Error(`Remote source needs review. Current fingerprint: ${current.fingerprint}\n${changed.slice(0,100).join('\n')}\nAfter reviewing the remote source, supply BETTER_BOTS_EXPECTED_REMOTE with that fingerprint.`);
  }
  return current.fingerprint;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,root,expected]=process.argv.slice(2);
  try {
    if(mode==='verify') console.log(verifyRelease(root,expected));
    else if(mode==='write') fs.writeFileSync(path.join(root,'.better-bots-release.json'),JSON.stringify(releaseManifest(root),null,2)+'\n');
    else if(mode==='inspect') console.log(JSON.stringify(releaseManifest(root),null,2));
    else throw Error('Use inspect, verify, or write with a release directory.');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
