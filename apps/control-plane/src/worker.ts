import { DurableObject } from 'cloudflare:workers';
import './native/lifecycle-diagnostics';
export { NativeDynamicWorkerTail } from './native/dynamic-worker-tail';
export { default, ResultValidation } from './native/worker';
export { Coordinator } from './native/coordinator';
export { NativeAttempt } from './native/attempt';
export { TargetEgress } from './native/target-egress';
export { OpenCodeConnectionTest } from './native/model-test';
export { WorkspaceServiceProxy } from '@cloudflare/computer';
// Historical proof storage remains readable; no routes reach retired model code.
export class ProofQueue extends DurableObject { override async alarm(){await this.ctx.storage.deleteAlarm();} }
export class ProofAttempt extends DurableObject { override async alarm(){await this.ctx.storage.deleteAlarm();} }
