#!/usr/bin/env node
// Schema 1 CI journals and schema 2 customer journals share exact-resource cleanup.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {main} from '../lib/owned-probe.mjs';
export * from '../lib/owned-probe.mjs';
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(()=>{console.error(JSON.stringify({stage:'cleanup',error:'CI_CLEANUP_FAILED'}));process.exitCode=1;});
