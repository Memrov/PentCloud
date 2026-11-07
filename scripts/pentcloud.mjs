#!/usr/bin/env node
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCustomerCli,customerFailure} from './lib/customer-cli.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let stage='arguments';
try{await runCustomerCli({root,stage:value=>{stage=value;}});}
catch(error){console.error(JSON.stringify(customerFailure(error,stage)));process.exitCode=1;}
