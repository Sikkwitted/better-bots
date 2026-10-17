import test from 'node:test';import assert from 'node:assert/strict';
import {classifiedAction,toolFingerprint,TOOL_ACTIONS} from '../src/services/integration-service.js';
for(const name of ['get_and_delete','preview_payment','login','GMAIL_FETCH_EMAILS'])test(`${name} never infers read permission`,()=>{
 assert.equal(classifiedAction({trust:'read_only'},{name}),'external.unclassified');
});
for(const action of TOOL_ACTIONS)test(`reviewed ${action} binds exact version`,()=>{
 const tool={name:'op',inputSchema:{type:'object'},description:'version1'};const spec={transport:'http',url:'https://example.com'};
 spec.tool_policies={op:{action,fingerprint:toolFingerprint(spec,tool)}};
 assert.equal(classifiedAction(spec,tool),action);
 assert.equal(classifiedAction(spec,{...tool,description:'version2'}),'external.unclassified');
 assert.equal(classifiedAction({...spec,url:'https://other.example'},tool),'external.unclassified');
});
test('contradictory mutation declaration cannot gain read permission',()=>{
 const tool={name:'get',annotations:{readOnlyHint:true,destructiveHint:true}};const spec={};spec.tool_policies={get:{action:'integration.read',fingerprint:toolFingerprint(spec,tool)}};
 assert.equal(classifiedAction(spec,tool),'external.unclassified');
});
test('connection environment and headers invalidate a review',()=>{
 const tool={name:'read'};const spec={transport:'http',url:'https://example.com',headers:{Authorization:'old'}};
 spec.tool_policies={read:{action:'integration.read',fingerprint:toolFingerprint(spec,tool)}};
 assert.equal(classifiedAction({...spec,headers:{Authorization:'new'}},tool),'external.unclassified');
 assert.equal(classifiedAction({...spec,env:{MODE:'write'}},tool),'external.unclassified');
});
