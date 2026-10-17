import test from 'node:test';
import assert from 'node:assert/strict';
import {screenTools} from '../src/tools/computer-tools.js';
import {makeHost} from './helpers.js';

test('browser navigation and input follow the external standing mode: Always runs, Ask asks, Never blocks',()=>{
 const {host}=makeHost(); host.registry.create({id:'screen-user',profile:{name:'Screen'}});
 const tool=screenTools({computer:host.computer}).find(t=>t.name==='UseScreen');
 for(const mode of ['always','ask','never']) {
  host.permissions.setStandingMode('external',mode,{actor:'user'});
  for(const action of ['open_url','click','type','key','move']) {
   const input={action,window_index:1,detail:{url:'https://example.com/profile'}};
   const decision=host.permissions.authorize({agent_id:'screen-user',action:tool.permission.action(input),target:tool.permission.target(input),scope_id:`${mode}-${action}`});
   assert.equal(decision.decision,{always:'allowed',ask:'ask',never:'blocked'}[mode],`${mode}: ${action}`);
  }
 }
 assert.equal(tool.permission.action({action:'unknown'}),'external.unclassified');
 assert.equal(tool.permission.action({action:'screenshot'}),'sandbox.read_file');
});
