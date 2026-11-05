import {expect, it} from 'vitest';
import {conversations, preferredConversation} from '../src/ui/attempts';
import {parseJob, type UIJob} from '../src/ui/api';

const job=(id:string,role:string,order:number,patch:Partial<UIJob>={}):UIJob=>({id,runId:'r',role,status:'created',revision:1,conversationOrder:order,...patch});
it('numbers agent conversations by durable creation order, not projection order or retries',()=>{
 const one=job('z','searcher',1,{task:'Public exposure'}),two=job('a','searcher',2),three=job('b','searcher',3);
 const retry=job('retry','searcher',1,{logicalThreadId:'z',revisionOf:'z',attempt:2,status:'running'});
 const values=conversations([two,retry,three,one]);
 expect(values.map(c=>[c.id,c.label,c.job.id])).toEqual([['z','Searcher 1','retry'],['a','Searcher 2','a'],['b','Searcher 3','b']]);
 expect(values[0]?.task).toBe('Public exposure');
 expect(values[0]?.attempts.map(j=>j.id)).toEqual(['z','retry']);
 expect(conversations([three,one,two,retry]).map(c=>c.label)).toEqual(values.map(c=>c.label));
});
it('keeps run roles isolated, includes orphaned threads and does not count discovery',()=>{
 const values=conversations([job('p','primary',1),job('s','searcher',2,{parentJobId:'missing'}),job('x','searcher',1,{runId:'other'}),job('d','discovery',0,{tool:'native_discovery'})]);
 expect(values.map(c=>[c.job.runId,c.label])).toEqual([['r','Primary'],['other','Searcher'],['r','Searcher']]);
});
it('opens the current working conversation but keeps an explicitly selected historical attempt',()=>{
 const all=[job('p','primary',1,{status:'waiting'}),job('s','searcher',2,{status:'running'})];
 expect(preferredConversation(all)?.id).toBe('s');
 expect(preferredConversation(all,'p')?.id).toBe('p');
 expect(preferredConversation(all,'not-present')?.id).toBe('s');
});
it('retains additive durable ordering metadata from native projections',()=>{
 expect(parseJob(job('s','searcher',7)).conversationOrder).toBe(7);
});
it('opens the latest primary after work settles while retaining explicitly selected history',()=>{
 const all=[job('p1','primary',1,{status:'waiting'}),job('s','searcher',2,{status:'completed'}),job('p2','primary',3,{status:'completed'})];
 expect(preferredConversation(all)?.id).toBe('p2');
 expect(preferredConversation(all,'p1')?.id).toBe('p1');
});
