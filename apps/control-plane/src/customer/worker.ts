// Single-Worker customer deployment; existing separate-Worker installations are unchanged.
import {exports} from 'cloudflare:workers';
import app from '../native/worker';
import {Coordinator as CoreCoordinator} from '../native/coordinator';
import {NativeAttempt as CoreAttempt} from '../native/attempt';
import type {NativeEnv} from '../native/types';
import type {ToolPackService} from '../../../../shared/tool-packs';
export {ResultValidation} from '../native/worker';
export {NativeDynamicWorkerTail} from '../native/dynamic-worker-tail';
export {OpenCodeConnectionTest} from '../native/model-test';
export {TargetEgress} from '../native/target-egress';
export {ProofQueue,ProofAttempt,WorkspaceServiceProxy} from '../worker';
export {ToolPackGateway,ReconRunner,HttpRunner,NucleiRunner,SqlmapRunner,ServiceRunner,WebContextRunner,PcapRunner,FileRunner,PasswordRunner,ReferenceRunner,MetasploitRunner} from '../../../../infra/tool-packs/src/worker';
const nativeEnv=(env:NativeEnv):NativeEnv=>({...env,TOOL_PACKS:(exports as unknown as {ToolPackGateway:ToolPackService}).ToolPackGateway});
export class Coordinator extends CoreCoordinator {constructor(ctx:DurableObjectState,env:NativeEnv){super(ctx,nativeEnv(env));}}
export class NativeAttempt extends CoreAttempt {constructor(ctx:DurableObjectState,env:NativeEnv){super(ctx,nativeEnv(env));}}
export default {
  fetch(request:Request,env:NativeEnv){return app.fetch(request,nativeEnv(env));},
  email(message:ForwardableEmailMessage,env:NativeEnv){return app.email(message,nativeEnv(env));},
};
