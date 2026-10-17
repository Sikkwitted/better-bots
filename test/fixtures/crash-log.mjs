import fs from 'node:fs';
import path from 'node:path';
import { JsonlLog } from '../../src/core/store.js';
const [dir,phase] = process.argv.slice(2);
const file = path.join(dir,'audit.jsonl');
fs.writeFileSync(file,'{"id":"before"}\n{"partial":');
const crash = () => process.kill(process.pid,'SIGKILL');
const opened = new Map();
const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync;
fs.openSync = (name,...args) => { const fd = open(name,...args); opened.set(fd,String(name)); return fd; };
fs.writeFileSync = (target,data,...args) => {
  const name = typeof target === 'number' ? opened.get(target) : String(target);
  if (name === file && ['boundary','partial_new_record'].includes(phase)) {
    write(target,phase === 'boundary' ? '\n' : '\n{"new":',...args);
    fs.fsyncSync(target); crash();
  }
  const result = write(target,data,...args);
  if (phase === 'report_temp' && /\.json(\.[^/]*)?\.tmp$/.test(name ?? '')) crash();
  return result;
};
fs.renameSync = (from,to) => {
  const result = rename(from,to);
  if (phase === 'report_committed' && String(to).includes('.corruption/')) crash();
  return result;
};
new JsonlLog(file).append({id:'new'});
throw new Error('crash not reached');
