import {useEffect,useState} from 'react';
import {Badge,Banner,Button,Collapsible,InlineCopyText,LinkButton,Select,Surface,Text} from '@cloudflare/kumo';
import {BOUNTY_PLATFORMS,type BountyConnection,type BountyStatus,type EmailReceiver,type MailSetup} from '../../../../../shared/bounty-connections';
import {verificationGuidance} from '../../../../../shared/verification-guidance';
import type {SavedTarget} from '../../native/onboarding';
import {ExternalLink} from '../components/external-link';
import {action,snapshot} from './api';

export function BountySettings(){
 const [data,setData]=useState<BountyStatus>(),[targets,setTargets]=useState<SavedTarget[]>([]),[error,setError]=useState<string>(),[loading,setLoading]=useState(false);
 const load=async()=>{setLoading(true);setError(undefined);try{const [status,saved]=await Promise.all([action<BountyStatus>('bounty.status',{}),snapshot()]);setData(status);setTargets(saved.targets);}catch(e){setError(e instanceof Error?e.message:'Could not load connections');}finally{setLoading(false);}};
 useEffect(()=>{void load();},[]);
 const checked=(connection:BountyConnection)=>setData(prior=>prior&&({...prior,connections:prior.connections.map(c=>c.platform===connection.platform?connection:c)}));
 return <section className="grid max-w-4xl gap-6 py-4" aria-label="Bug bounty settings">
  <div className="grid gap-1.5"><Text as="h2" variant="heading">Bug bounty</Text><Text>Connect a platform to choose its programs in Targets. Credentials stay in Cloudflare.</Text></div>
  {error&&<Banner variant="error" description={<Text>{error}</Text>}/>}
  {!data?<Button variant="secondary" loading={loading} onClick={()=>void load()}>Load connections</Button>:<>
   <div className="grid gap-4 md:grid-cols-2">{BOUNTY_PLATFORMS.map(platform=><PlatformConnection key={platform.id} platform={platform} connection={data.connections.find(c=>c.platform===platform.id)!} onChecked={checked}/>)}</div>
   <div><LinkButton variant="primary" href="/dashboard?view=targets">Choose a bounty program</LinkButton></div>
   <div className="grid gap-1.5"><Text as="h2" variant="heading">Email verification <Text as="span" variant="secondary">· Optional</Text></Text><Text>Use a receiver when a target needs email codes or login links.</Text></div>
   <div className="grid gap-4 md:grid-cols-2"><Receiver provider="cloudflare" value={data.email.cloudflare}/><Receiver provider="agentmail" value={data.email.agentmail}/></div>
   <ForwardingSetup targets={targets}/>
  </>}
 </section>;
}

function PlatformConnection({platform,connection,onChecked}:{platform:typeof BOUNTY_PLATFORMS[number];connection:BountyConnection;onChecked:(value:BountyConnection)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const check=async()=>{setBusy(true);setError(undefined);try{onChecked(await action<BountyConnection>('bounty.check',{platform:platform.id}));}catch(e){onChecked({...connection,status:'unchecked'});setError(e instanceof Error?e.message:'Connection check failed');}finally{setBusy(false);}};
 return <Surface className="grid content-start gap-4 rounded-lg px-5 py-4 ring ring-kumo-line">
  <div className="flex flex-wrap items-center justify-between gap-2"><Text as="h3" variant="heading">{platform.name}</Text><Badge className="text-base" variant="secondary">{connection.status==='ready'?'Connected':connection.status==='missing'?'Not configured':'Check needed'}</Badge></div>
  <div className="grid gap-1.5"><Text>API token secret</Text><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">{platform.token}</InlineCopyText></div>
  {'username' in platform&&<div className="grid gap-1.5"><Text>Username variable</Text><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">{platform.username}</InlineCopyText></div>}
  <Collapsible><Collapsible.DefaultTrigger>Setup instructions</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><Text>Ask your setup assistant to add these bindings to the app Worker. Use a researcher API token. Enter its value through Cloudflare’s private secret prompt.</Text></Collapsible.DefaultPanel></Collapsible>
  {error&&<Banner variant="error" description={<Text>{error}</Text>}/>}
  {connection.checkedAt&&<Text variant="secondary">Last successful check: {new Date(connection.checkedAt).toLocaleString()}</Text>}
  <div><Button variant="secondary" loading={busy} onClick={()=>void check()}>Check {platform.name} connection</Button></div>
 </Surface>;
}

function Receiver({provider,value}:{provider:'cloudflare'|'agentmail';value:EmailReceiver}){
 const [busy,setBusy]=useState(false),[result,setResult]=useState<string>(),[error,setError]=useState(false);
 const check=async()=>{setBusy(true);setResult(undefined);setError(false);try{await action('bounty.email.check',{provider});setResult('Message access verified. Check forwarding below to confirm delivery.');}catch(e){setError(true);setResult(e instanceof Error?e.message:'Receiver check failed');}finally{setBusy(false);}};
 return <Surface className="grid content-start gap-4 rounded-lg px-5 py-4 ring ring-kumo-line">
  <div className="flex flex-wrap items-center justify-between gap-2"><Text as="h3" variant="heading">{provider==='agentmail'?'AgentMail':'Cloudflare Email Routing'}</Text><Badge className="text-base" variant="secondary">{value.configured?'Configured':'Not configured'}</Badge></div>
  {value.address&&<InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">{value.address}</InlineCopyText>}
  <Collapsible><Collapsible.DefaultTrigger>Receiver setup</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-2">
   {provider==='agentmail'?<><Text>Bind your existing AgentMail API key through Cloudflare Secrets Store and set the inbox variable. No new domain is needed.</Text><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">AGENTMAIL_API_KEY</InlineCopyText><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">PENTCLOUD_AGENTMAIL_INBOX</InlineCopyText><Text>AgentMail retains its own mail copies. PentCloud reads fresh verification messages only during a connection or pending login check.</Text></>:<Text>Ask your setup assistant to enable the optional receiver on an unused Cloudflare domain or mail subdomain. The installer manages its native email route. Preserve existing mailbox MX records.</Text>}
  </div></Collapsible.DefaultPanel></Collapsible>
  {provider==='agentmail'&&<div><Button variant="secondary" disabled={!value.configured} loading={busy} onClick={()=>void check()}>Check AgentMail connection</Button></div>}
  {result&&<Banner variant={error?'error':'secondary'} description={<Text>{result}</Text>}/>}
 </Surface>;
}

function ForwardingSetup({targets}:{targets:SavedTarget[]}){
 const eligible=targets.filter(t=>!t.archived&&t.access?.login?.verification?.kind==='email');
 const initial=new URLSearchParams(location.search).get('target'),[selected,setSelected]=useState(initial??eligible[0]?.id??'');
 const target=eligible.find(t=>t.id===selected);
 return <section className="grid gap-4" aria-label="Email forwarding">
  <div className="grid gap-1.5"><Text as="h3" variant="heading">Check forwarding</Text><Text>Keep the account address required by the program. Forward only its verification emails.</Text></div>
  {!eligible.length?<><Text>Enable email verification in a saved target’s login settings first.</Text><div><LinkButton variant="secondary" href="/dashboard?view=targets">Open Targets</LinkButton></div></>:<>
   <Select label="Target for email verification" value={target?.id??null} placeholder="Choose a target" items={Object.fromEntries(eligible.map(t=>[t.id,t.name]))} onValueChange={v=>setSelected(String(v??''))}/>
   {target&&<ForwardingCheck key={target.id+':'+target.revision} target={target}/>}
  </>}
 </section>;
}

function ForwardingCheck({target}:{target:SavedTarget}){
 const verification=target.access!.login!.verification!;
 const provider=verification.kind==='email'?verification.provider??'cloudflare':'cloudflare',sender=verification.kind==='email'?verification.sender:'';
 const guidance=verificationGuidance(target.access?.program?.platform);
 const [mail,setMail]=useState<MailSetup>(),[error,setError]=useState<string>(),[busy,setBusy]=useState<'begin'|'read'>();
 useEffect(()=>{let live=true;void action<MailSetup>('access.email.address',{id:target.id,revision:target.revision,provider}).then(value=>{if(live)setMail(value);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[target.id,target.revision,provider]);
 useEffect(()=>{if(!mail?.expiresAt||!['waiting','received'].includes(mail.status??''))return;const timer=setTimeout(()=>setMail(value=>{if(!value)return value;const {code:_code,excerpt:_excerpt,links:_links,...rest}=value;return {...rest,status:'expired'};}),Math.max(0,mail.expiresAt-Date.now()));return()=>clearTimeout(timer);},[mail?.expiresAt,mail?.status]);
 const check=async(kind:'begin'|'read')=>{setBusy(kind);setError(undefined);try{setMail(await action<MailSetup>(kind==='begin'?'access.email.setup':'access.email.status',{id:target.id,revision:target.revision}));}catch(e){setError(e instanceof Error?e.message:'Forwarding check failed');}finally{setBusy(undefined);}};
 return <div className="grid max-w-2xl gap-4">
  {error&&<Banner variant="error" description={<Text>{error}</Text>}/>}
  {!mail?<Text role="status">Loading receiver…</Text>:!mail.configured?<Banner variant="secondary" description={<Text>Configure {provider==='agentmail'?'AgentMail':'Cloudflare Email Routing'} above to check this target.</Text>}/>:<>
   <div className="grid gap-1.5"><Text>Forward {sender} verification emails to:</Text><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">{mail.address!}</InlineCopyText></div>
   <Collapsible><Collapsible.DefaultTrigger>Forwarding instructions</Collapsible.DefaultTrigger><Collapsible.DefaultPanel><div className="grid gap-2">
    <Text>{guidance.alias?`${guidance.alias} delivers to your registered mailbox. `:''}Click Check forwarding, then add the receiver in that mailbox’s forwarding settings. Read confirmation to get its code or link.</Text>
    {guidance.docs&&<ExternalLink href={guidance.docs}>Platform email instructions</ExternalLink>}
    <Text>Filter by your original test account and this target’s sender. For Gmail, replace YOUR_TEST_ACCOUNT_EMAIL in:</Text><InlineCopyText variant="body" truncate={false} className="break-all text-left font-mono text-base">{`to:(YOUR_TEST_ACCOUNT_EMAIL) from:(${sender})`}</InlineCopyText>
    {provider==='agentmail'&&<Text>The target’s username secret must contain its test account email address.</Text>}
   </div></Collapsible.DefaultPanel></Collapsible>
   <div className="flex flex-wrap gap-2"><Button variant="secondary" loading={busy==='begin'} disabled={!!busy} onClick={()=>void check('begin')}>{mail.status==='expired'?'Check again':'Check forwarding'}</Button>{mail.status==='waiting'&&<Button variant="secondary" loading={busy==='read'} disabled={!!busy} onClick={()=>void check('read')}>Read confirmation</Button>}</div>
   {mail.status&&mail.status!=='idle'&&<Text role="status">{mail.status==='received'?'Confirmation received':mail.status==='expired'?'Check expired. Start a new forwarding check.':'Waiting for forwarding confirmation · 10-minute window'}</Text>}
   {mail.code&&<InlineCopyText variant="body" truncate={false}>{mail.code}</InlineCopyText>}{mail.excerpt&&<Text>{mail.excerpt}</Text>}{mail.links?.map(link=><ExternalLink key={link} href={link}>Confirm mailbox forwarding</ExternalLink>)}
  </>}
 </div>;
}
