import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {privateProcess} from './private-process.mjs';

export function missingOrganizationFooter(stderr,accountId){
  if(!/^[a-f0-9]{32}$/.test(accountId??''))return false;
  const lines=stderr.replaceAll('\r','').trimEnd().split('\n');
  return lines.at(-1)?.trim()==='└'&&lines.at(-2)?.trim()===`│ 404 Not Found · HTTP /accounts/${accountId}/access/organizations`;
}
async function cfRead(args,options){
  return new Promise((resolve,reject)=>{
    const env={...options.env,NO_COLOR:'1',CF_SEND_TELEMETRY:'false'};
    const child=spawn('cf',args,{env,stdio:['ignore','pipe','pipe']});
    const out=[],err=[];let size=0;
    const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
    child.stdout.on('data',b=>{size+=b.length;if(size<16*1024*1024)out.push(b);});child.stderr.on('data',b=>{if(size<16*1024*1024)err.push(b);size+=b.length;});
    child.on('error',()=>{clearTimeout(timer);reject(Error('PC_CF_UNAVAILABLE'));});
    child.on('close',code=>{clearTimeout(timer);if(code===0)return resolve(Buffer.concat(out));const error=Error('PC_CF_DISCOVERY');if(args.join(' ')==='zero-trust organization get'&&missingOrganizationFooter(Buffer.concat(err).toString(),env.CLOUDFLARE_ACCOUNT_ID))error.statusCode=404;reject(error);});
  });
}
export function createDeploymentRunner({root,environment=process.env}){
  const publicBuildEnvironment=()=>Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','GOTOOLCHAIN','GO_BIN','PENTCLOUD_GO_BINARY','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'].filter(k=>environment[k]).map(k=>[k,environment[k]]));
  return async(kind,args,settings={})=>{
    const options={cwd:root,...settings,env:settings.env??environment};
    if(kind==='cf'&&settings.missing)return cfRead(args,options);
    if(kind==='wrangler')return privateProcess(process.execPath,[join(root,'node_modules/wrangler/bin/wrangler.js'),...args],options);
    if(kind==='node'){
      if(args[0]===join(root,'scripts/build-native-app.mjs'))options.env=publicBuildEnvironment();
      return privateProcess(process.execPath,args,options);
    }
    if(kind==='build'){
      const[major,minor,patch]=process.versions.node.split('.').map(Number);
      assert(major===26&&(minor>12||minor===12&&patch>=1),'PC_NODE_VERSION');
      await privateProcess('bash',[join(root,'scripts/build-prompt-renderer.sh')],{cwd:root,env:publicBuildEnvironment()});
      return privateProcess(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build'],{cwd:join(root,'apps/control-plane'),env:publicBuildEnvironment()});
    }
    return privateProcess(kind,args,options);
  };
}
