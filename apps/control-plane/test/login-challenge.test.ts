import {expect,it} from 'vitest';
import {LoginChallenges} from '../src/native/login-challenge';
function fixture(){let time=100000;const data=new Map<string,unknown>();return {data,advance:(n:number)=>{time+=n;},store:new LoginChallenges({get:k=>data.get(k),put:(k,v)=>data.set(k,v),remove:k=>data.delete(k),list:p=>[...data].filter(([k])=>k.startsWith(p)).map(([key,value])=>({key,value})),now:()=>time})};}
const owner='run-one:target-one',recipient='codes+abc@auth.example',scope={key:'run-one',owner,recipient,sender:'login@owned.example',targetURL:'https://owned.example/',purpose:'login' as const};
const message={id:'message-one',to:recipient,from:'login@owned.example',sentAt:100000,code:'384217',links:[]};
it('delivers one fresh verification email only to its pending owner and consumes it once',()=>{
 const {store}=fixture();store.begin(scope,'fill-one');expect(store.receive(message)).toBe(true);
 expect(store.peek('run-two',owner)).toBeUndefined();expect(store.peek(scope.key,'another-target')).toBeUndefined();
 expect(store.peek(scope.key,owner)?.code).toBe('384217');store.consume(scope.key,owner,'message-one');expect(store.peek(scope.key,owner)).toBeUndefined();expect(store.receive(message)).toBe(false);
});
it('rejects stale, wrong-sender, wrong-recipient and expired mail and clears a stopped run',()=>{
 const {store,advance}=fixture();store.begin(scope,'fill-one');
 for(const other of [{...message,to:'other@auth.example'},{...message,from:'attacker@elsewhere.example'},{...message,sentAt:98000}])expect(store.receive(other)).toBe(false);
 advance(10*60*1000);expect(store.receive({...message,sentAt:700000})).toBe(false);expect(store.peek(scope.key,owner)).toBeUndefined();
 store.begin(scope,'fill-two');store.clear(scope.key);expect(store.receive({...message,id:'new',sentAt:700000})).toBe(false);
});
it('does not reset an outstanding login on immutable replay or reuse delivery in a new run',()=>{
 const {store,advance}=fixture();store.begin(scope,'fill-one');store.receive(message);store.begin(scope,'fill-one');expect(store.peek(scope.key,owner)?.code).toBe('384217');
 store.clear(scope.key);advance(10);store.begin({...scope,key:'run-two',owner:'run-two:target-one'},'fill-two');expect(store.receive(message)).toBe(false);
});
it('replaces forwarding setup with login and refuses simultaneous runs for one mailbox',()=>{
 const {store}=fixture();store.begin({...scope,key:'setup:target-one',purpose:'setup',sender:''},'setup');
 store.begin(scope,'login');expect(store.receive(message)).toBe(true);
 expect(store.peek('setup:target-one',owner)).toBeUndefined();expect(store.peek(scope.key,owner)?.code).toBe(message.code);
 expect(()=>store.begin({...scope,key:'run-two',owner:'other'},'login-two')).toThrow(/pending/i);
});
it('isolates providers and accounts in a shared inbox and exposes only a live pending owner',()=>{
 const {store,advance}=fixture();const shared={...scope,provider:'agentmail' as const,account:'one@owned.example'};
 store.begin(shared,'fill');store.begin({...shared,key:'two',owner:'two',account:'two@owned.example'},'fill');
 expect(store.receive({...message,provider:'agentmail',account:'two@owned.example'})).toBe(true);
 expect(store.peek(scope.key,owner)).toBeUndefined();expect(store.peek('two','two')?.code).toBe(message.code);
 expect(store.receive({...message,id:'other'})).toBe(false);
 expect(store.pending(scope.key,'wrong')).toBeUndefined();expect(store.pending(scope.key,owner)?.createdAt).toBe(100000);
 expect(()=>store.begin({...shared,key:'three',owner:'three'},'fill')).toThrow(/pending/);
 advance(600000);expect(store.pending(scope.key,owner)).toBeUndefined();
});
it('refuses a fetched batch after its setup owner or operation is replaced in the same second',()=>{
 const {store}=fixture(),setup={...scope,purpose:'setup' as const,sender:'',provider:'agentmail' as const};
 store.begin(setup,'operation-one');const delivery={...message,provider:'agentmail' as const};
 expect(store.receive(delivery,{key:scope.key,owner,operationId:'operation-one'})).toBe(true);
 store.clear(scope.key);store.begin({...setup,key:'target-two',owner:'target-two'},'operation-two');
 expect(store.receive({...delivery,id:'message-two'},{key:scope.key,owner,operationId:'operation-one'})).toBe(false);expect(store.peek('target-two','target-two')).toBeUndefined();
 store.clear('target-two');store.begin(setup,'operation-new');expect(store.receive({...delivery,id:'message-three'},{key:scope.key,owner,operationId:'operation-one'})).toBe(false);
});
