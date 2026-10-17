import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpDir} from './helpers.js';
import {prepareDesktopHome} from '../src/services/desktop-home.js';
test('desktop has executable app launchers and preserves existing files and browser profile',()=>{
 const home=tmpDir();try{
  fs.mkdirSync(path.join(home,'Desktop'));fs.writeFileSync(path.join(home,'Desktop','notes.txt'),'keep');
  fs.writeFileSync(path.join(home,'Desktop','BetterBots-Terminal.desktop'),'[Desktop Entry]\nExec=xterm\n');
  fs.mkdirSync(path.join(home,'browser-profile'));fs.writeFileSync(path.join(home,'browser-profile','marker'),'cookies');
  prepareDesktopHome(home,'/usr/bin/firefox');prepareDesktopHome(home,'/usr/bin/firefox');
  for(const name of ['Browser','Files']) {
   const file=path.join(home,'Desktop',`BetterBots-${name}.desktop`);
   assert.ok(fs.statSync(file).mode&0o111);assert.match(fs.readFileSync(file,'utf8'),new RegExp(`Name=${name}`));
  }
  assert.ok(!fs.existsSync(path.join(home,'Desktop','BetterBots-Terminal.desktop')),'no unsandboxed terminal on the desktop');
  assert.match(fs.readFileSync(path.join(home,'Desktop','BetterBots-Browser.desktop'),'utf8'),/--profile.*browser-profile.*about:blank/);
  assert.equal(fs.readFileSync(path.join(home,'Desktop','notes.txt'),'utf8'),'keep');
  assert.equal(fs.readFileSync(path.join(home,'browser-profile','marker'),'utf8'),'cookies');
  assert.match(fs.readFileSync(path.join(home,'.config','pcmanfm','better-bots','desktop-items-0.conf'),'utf8'),/wallpaper_mode=color/);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
