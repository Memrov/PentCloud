import {expect,it} from 'vitest';
import {assertPreparationPromotion,preparationTool} from '../src/native/preparation';
import type {AttemptInput} from '../src/native/types';
const input:AttemptInput={id:'primary-one',runId:'run-one',role:'primary',tool:'primary',args:{task:'Owned project'},task:'Owned project',inputCommit:'a'.repeat(40),repo:'owned-run',remote:'https://example.invalid/owned.git',settingsRevision:'settings-one',settings:{promptTemplate:'Pinned primary',upstreamPromptDigest:'b'.repeat(64),model:'opencode-go:deepseek-v4-pro',reasoningEffort:'default'},depth:0,attempt:1,logicalThreadId:'primary-one',createdAt:1,context:{target:{kind:'website',url:'https://owned.invalid/'}}};
it('promotes a readonly snapshot to current input without changing the frozen agent identity',()=>{
  expect(()=>assertPreparationPromotion(input,{...input,inputCommit:'c'.repeat(40),context:{...input.context,head_commit:'c'.repeat(40),attempts:[{status:'completed'}]}})).not.toThrow();
  for(const changed of [{...input,runId:'other'},{...input,settings:{...input.settings,model:'opencode:other'}},{...input,context:{target:{kind:'website',url:'https://other.invalid/'}}}])expect(()=>assertPreparationPromotion(input,changed)).toThrow(/preparation/i);
});
it('permits supplied-file and progress reads while rejecting all execution tools',()=>{
  for(const name of ['computer_read','computer_ls','computer_find','computer_grep','pentcloud_progress'])expect(preparationTool(name)).toBe(true);
  for(const name of ['computer_write','computer_edit','computer_exec','workspace_javascript','cloudflare_browser','pentcloud_api_request','whatweb_whatweb_scan','delegate','done'])expect(preparationTool(name)).toBe(false);
});
