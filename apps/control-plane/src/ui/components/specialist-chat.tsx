import { Badge, Banner, Button, Collapsible, Empty, InputArea, Loader, Tabs, Text, Tooltip } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  BrainIcon,
  PaperPlaneRightIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatResponse } from "./chat-conversation";
import {ChatMarkdown} from "./chat-markdown";
import { ThemeControl } from "./theme-control";

import type { SpecialistChatState } from "../presentation";
import { useNativeSession } from "../native-stream";
import { acceptedOutcome,sessionMessagesForJob } from "../session-projection";
import { APIError, interruptJob, steerJob, reviseJob, cancelRun, type UIJob } from "../api";
import { NativeSessionControls } from "./session-controls";
import { RuntimeRecoveryNotice } from "./runtime-recovery";
import { BrowserLiveViewControl } from "./browser-live-view";
import { MaterialAttachments, RunFilesPanel, dropMaterials, pasteMaterials, useMaterialDraft } from "./materials";
import { canCorrectMaterialSubmission } from "../materials-api";
import {chatActivity} from "../chat-activity";
import {conversations} from "../attempts";
import {chatTurns} from "../chat-transcript";

export function SpecialistChat({ job, attempts, onSelect, onRevision, onState, readOnly = false, displayName, task, peers=[], onSelectConversation, draft="", onDraftChange, onAttentionChange, canStopRun=false }: { canStopRun?:boolean; job: UIJob; attempts: UIJob[];draft?:string;onDraftChange?:(value:string,expected?:string)=>void;onAttentionChange?:(id:string,needed:boolean)=>void; readOnly?: boolean; displayName?:string|undefined; task?:string|undefined; peers?:UIJob[]; onSelectConversation?:(id:string)=>void; onSelect: (id: string) => void; onRevision: (job?: UIJob) => void; onState: (state: SpecialistChatState) => void }) {
  const input=draft;
  const setInput=(value:string)=>onDraftChange?.(value);
  const [awayFromBottom,setAwayFromBottom]=useState(false);
  const [needsAnswer,setNeedsAnswer]=useState(false);
  const handleAttention=useCallback((needed:boolean)=>{setNeedsAnswer(needed);onAttentionChange?.(job.id,needed);},[job.id,onAttentionChange]);
  const [pending, setPending] = useState(false);
  const materials = useMaterialDraft(job.runId);
  const submission = useRef<{instructions: string; requestId: string; uploadIds: string[]} | undefined>(undefined);
  const [canEditRejectedSubmission, setCanEditRejectedSubmission] = useState(false);
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingBottom = useRef(true);
  const { projection, connected, error: streamError, controlsRevision } = useNativeSession(job.id, ["waiting", "completed", "failed", "invalid_result", "integration_failed", "interrupted"].includes(job.status), job.inputError === undefined || job.nativeSession===true);
  const effectiveJob = projection.job && projection.job.revision > job.revision ? projection.job : job;
  const selectedMessages = useMemo(() => sessionMessagesForJob(projection, effectiveJob), [projection, effectiveJob]);
  const messages = useDeferredValue(selectedMessages);
  const turns=useMemo(()=>chatTurns(messages,job),[messages,job.id,job.task]);
  const name=displayName ?? (job.role ? job.role.charAt(0).toUpperCase()+job.role.slice(1) : "Specialist");
  const sessionActivity=chatActivity(effectiveJob,messages,projection.busy,connected);
  const activity=needsAnswer&&!readOnly?{...sessionActivity,label:"Needs your answer",working:false}:sessionActivity;
  const activePeer=conversations(peers.filter(p=>p.runId===job.runId)).find(c=>c.job.id!==job.id&&c.job.status==="running");
  const effectiveStatus = effectiveJob.status;
  const outcome=acceptedOutcome(projection,effectiveJob);
  useEffect(() => { onState({ ...(projection.job ? { job: projection.job } : {}), streaming: projection.busy }); }, [projection.job, projection.busy, onState]);
  const running = effectiveStatus === "running";
  const preparing = effectiveJob.preparingConversation===true && effectiveStatus==="created";
  const conversing = running || preparing;
  const stopped = ["completed", "failed", "waiting", "invalid_result", "integration_failed", "interrupted"].includes(effectiveStatus) && job.cleanupStatus !== "pending";
  const nativeFiles = effectiveJob.nativeSession === true;
  const canAttachFiles = !preparing && (nativeFiles || effectiveJob.inputError !== undefined);
  const composerAvailable = !readOnly && (conversing || stopped) && !effectiveJob.recovery?.sealed;
  const filesSelected = materials.files.length > 0;
  const canSend = composerAvailable && !pending && !!input.trim() && materials.ready;

  useLayoutEffect(() => { followingBottom.current = true; }, [job.id]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    // Projection refreshes must preserve file/history inspection. Follow only
    // while the operator is near the bottom, including the initial selection.
    if (scroll && followingBottom.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages, job.id]);

  // Streamdown can finish laying out a code block after the message render.
  // Follow those native size changes only while the reader remains at the bottom.
  useLayoutEffect(()=>{
    const scroll=scrollRef.current,column=scroll?.firstElementChild;
    if(!scroll||!column)return;
    const observer=new ResizeObserver(()=>{if(followingBottom.current)scroll.scrollTop=scroll.scrollHeight;});
    observer.observe(column);observer.observe(scroll);
    return()=>observer.disconnect();
  },[job.id]);

  const steer = async () => {
    const message = input.trim();
    if (!message || !canSend) return;
    setPending(true);
    setError(undefined);
    setCanEditRejectedSubmission(false);
    try {
      if (conversing && !filesSelected && !submission.current) await steerJob(job.id, message);
      else {
        submission.current ??= {instructions: message, requestId: crypto.randomUUID(), uploadIds: materials.uploadIds};
        const queued = await reviseJob(job.id, submission.current.instructions, globalThis.fetch, submission.current);
        materials.draft.clear();
        submission.current = undefined;
        onRevision(queued);
      }
      onDraftChange?.("",input);
    } catch (caught) {
      const wasRevision = !!submission.current;
      if (canCorrectMaterialSubmission(caught)) submission.current = undefined;
      else if (wasRevision && caught instanceof APIError && caught.status === 429) setCanEditRejectedSubmission(true);
      setError(caught instanceof APIError && caught.status === 409 && !wasRevision ? "This agent finished before the message arrived." : caught instanceof Error ? caught.message : "Message could not be sent");
    } finally {
      setPending(false);
    }
  };

  const interrupt = async () => {
    if (!conversing || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await interruptJob(job.id);
    } catch (caught) {
      setError(caught instanceof APIError && caught.status === 409 ? "This specialist has already stopped." : caught instanceof Error ? caught.message : "Interrupt failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="chat-shell grid h-full min-h-0 min-w-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-kumo-base text-base text-kumo-default" aria-label={`${job.role ?? "Specialist"} chat`} aria-busy={!connected&&!projection.job&&job.inputError===undefined}>
      <header className="chat-header flex items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
        <div className="chat-title-block min-w-0 flex-1">
          <Text as="h1" variant="heading3">{name}</Text><div className="current-activity flex items-center gap-2" role="status">{activity.working&&<Loader size="sm"/>}<Text variant="secondary">{effectiveJob.inputError!==undefined&&!nativeFiles?"Input rejected":!connected?"Reconnecting":projection.pendingSpans?.length&&activity.working?"Restoring response":activity.label}</Text></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeControl/>
          {job.cleanupStatus === "pending" && <Badge variant="error" className="text-base">Cleanup retrying</Badge>}
          {!readOnly && effectiveJob.nativeSession === true && running && !effectiveJob.recovery?.sealed && <BrowserLiveViewControl key={job.id} jobId={job.id} />}
          {!readOnly && conversing && <Tooltip content="Stop attempt" render={<Button variant="secondary" shape="square" aria-label="Stop attempt" icon={<StopIcon size={16}/>} disabled={!conversing || pending} onClick={interrupt}/>}/>}
        </div>
      </header>
      <div className="border-b border-kumo-line px-4 py-1">
        <Collapsible className="conversation-details"><Collapsible.DefaultTrigger>Conversation details</Collapsible.DefaultTrigger><Collapsible.DefaultPanel className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary" className="text-base">{job.model ?? "OpenCode Go"}</Badge><Text variant="secondary">{connected ? "Live projection" : "Reconnecting"}</Text><Text variant="secondary">{job.id}</Text></div>
          <Text>{task || job.task}</Text>
          {job.archiveStatus === "compacted" && <Badge variant="secondary">Archive compacted</Badge>}
          {job.archiveStatus === "failed" && <Badge variant="destructive">Archive retrying</Badge>}
          <div className="overflow-x-auto"><Tabs variant="underline" value={job.id} onValueChange={onSelect} tabs={attempts.map(a=>({value:a.id,label:`Attempt ${a.attempt ?? 1} · ${a.status}`}))}/></div>
          {!readOnly && canStopRun && <Button variant="secondary" disabled={pending} onClick={() => void cancelRun(job.runId).catch(e => setError(String(e)))}>Stop run</Button>}
        </Collapsible.DefaultPanel></Collapsible>
        {!readOnly && effectiveJob.recovery && <RuntimeRecoveryNotice key={effectiveJob.recovery.observedAt} recovery={effectiveJob.recovery} scope="attempt" attemptId={job.id} onResumed={() => onRevision()} />}
      </div>
      <div className="relative min-h-0"><div className="message-scroll h-full min-h-0 overflow-y-auto" ref={scrollRef} onScroll={event => {
        const scroll = event.currentTarget;
        followingBottom.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48;
        setAwayFromBottom(!followingBottom.current);
      }}>
        <div className="message-column mx-auto grid w-full max-w-3xl gap-4 px-4 py-5">
          {!connected&&(effectiveJob.inputError===undefined||nativeFiles)&&<Banner variant="secondary" role="status" title="Reconnecting to this conversation" description="Cloud execution may continue while updates reconnect. Your draft stays here."/>}
          {effectiveStatus==="waiting"&&<Banner variant="secondary" description={activity.detail} action={activePeer&&onSelectConversation?<Button variant="ghost" onClick={()=>onSelectConversation(activePeer.job.id)}>Open {activePeer.label}</Button>:undefined}/>}
          {nativeFiles && <RunFilesPanel key={`${effectiveJob.id}:${effectiveJob.outputCommit ?? effectiveJob.inputCommit ?? ""}`} runId={job.runId} jobId={job.id} />}
          {effectiveJob.inputError !== undefined && <Banner className="composer-error" variant="error" role="alert" title={nativeFiles?"Assessment input rejected":"Input rejected before session start"} description={<><p>{effectiveJob.inputError}</p><p>Correct the instructions or attachments below to queue a fresh revision.</p></>}/>}
          {messages.length === 0 ? effectiveJob.inputError === undefined && <WaitingState status={effectiveStatus} /> : turns.map((turn,index) => <ChatResponse key={turn.id} turn={turn} name={name} active={conversing&&projection.busy&&index===turns.length-1} activity={activity}/>)}
          {outcome&&<section aria-label="Accepted outcome" className="grid gap-2"><Text bold>Accepted outcome</Text><ChatMarkdown>{outcome}</ChatMarkdown></section>}
          {effectiveStatus==="completed"&&!outcome&&<Banner variant="secondary" title="Completed" description={messages.some(m=>m.role==="assistant"&&m.parts.some(p=>p.type==="text"&&p.text.trim()))?"This attempt has finished. Its accepted files are available above.":"This attempt completed through tool results without a separate chat summary. Expand Activity for its recorded work, or open Files for accepted deliverables."}/>}

        </div>
      </div>
      {awayFromBottom&&<div className="absolute inset-x-0 bottom-3 flex justify-center"><Button variant="secondary" icon={<ArrowDownIcon size={16}/>} onClick={()=>{followingBottom.current=true;scrollRef.current?.scrollTo({top:scrollRef.current.scrollHeight});setAwayFromBottom(false);}}>Jump to latest</Button></div>}
      </div>

      {readOnly ? <footer className="border-t border-kumo-line px-4 py-3"><Text variant="secondary">Restore this run to send instructions or attach files. Restoring does not resume previous execution.</Text></footer> : <footer className="composer-wrap border-t border-kumo-line px-4 py-3">
        <div className="mx-auto grid max-w-3xl gap-3">
        {effectiveJob.nativeSession === true && !effectiveJob.recovery?.sealed && (preparing || !["created", "provisioning"].includes(effectiveStatus)) && <NativeSessionControls jobId={job.id} running={conversing} controlsRevision={controlsRevision} onAttention={handleAttention} />}
        {(error ?? streamError) && <Banner className="composer-error" variant="error" role="alert" description={error ?? streamError}/>}
        <form className="composer-card grid gap-3" onSubmit={event=>{event.preventDefault();void steer();}}
          onPaste={event => { if (canAttachFiles) pasteMaterials(event, materials.draft, !composerAvailable || pending || !!submission.current); }}
          onDragOver={event => { if (canAttachFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={event => { if (canAttachFiles) dropMaterials(event, materials.draft, !composerAvailable || pending || !!submission.current); }}>
          {canAttachFiles && <MaterialAttachments draft={materials.draft} files={materials.files} {...(materials.error ? {error: materials.error} : {})} disabled={!composerAvailable || pending || !!submission.current} />}
          {filesSelected && <Text variant="secondary">{running ? "Files will queue a fresh revision. The current attempt continues." : "Files will be pinned to a fresh revision."} Selection does not mean the specialist has read them.</Text>}
          {submission.current && error && <Text variant="secondary">Retry sends the same instructions and files.</Text>}
          {canEditRejectedSubmission && submission.current && <Button variant="secondary" onClick={() => { submission.current = undefined; setCanEditRejectedSubmission(false); setError(undefined); }}>Edit rejected draft</Button>}
          <InputArea
            value={input}
            onValueChange={setInput}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void steer(); }
            }}
            disabled={!composerAvailable || pending || !!submission.current}
            placeholder={preparing ? "Discuss your project while discovery runs…" : running ? `Message ${name.toLowerCase()} while it works…` : stopped ? "Send instructions for a fresh revision attempt…" : "Waiting for this attempt to start…"}
            aria-label={`Message ${name}`}
            autoResize
            minRows={2}
            maxRows={6}
          />
          <div className="composer-bottom flex items-center justify-end gap-3 min-[760px]:justify-between">
            <Text DANGEROUS_className="hidden min-[760px]:inline" variant="secondary">{filesSelected ? "Enter to queue revision" : conversing ? "Enter to send" : "Enter to create a fresh attempt"} · Shift+Enter for a new line</Text>
            <Button variant="primary" shape="square" icon={<PaperPlaneRightIcon size={17} />} disabled={!canSend} type="submit" aria-label="Send message" />
          </div>
        </form>
        </div>
      </footer>}
    </section>
  );
}

function WaitingState({ status }: { status: string }) {
  if(status==="completed")return null;
  return (
    <Empty icon={status==="running"?<Loader/>:<BrainIcon size={24}/>} title={status === "running" ? "Specialist is working" : "Conversation ready"} description="Session events will appear here as the specialist works."/>
  );
}
