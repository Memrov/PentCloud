#!/usr/bin/env node
import {appendFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {environment,client,validateAccount,importSource} from './artifacts.mjs';
async function main(){
const e=environment(),api=client(e);
await validateAccount(api,e);
const source=join(resolve(process.env.RUNNER_TEMP),'pentcloud-artifacts-source');
const proof=await importSource(api,e,source);
await appendFile(process.env.GITHUB_OUTPUT,'source='+source+'\n');
console.log(JSON.stringify({stage:'native-artifacts-source',...proof}));


}
main().catch(()=>{console.error('Native Artifacts source preparation failed; no account/provider logs emitted.');process.exitCode=1;});
