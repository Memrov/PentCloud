"""Bounded benchmark for a self-identifying owned fixture. Standard library only."""
import datetime, hashlib, io, json, os, pathlib, re, shlex, subprocess, sys, time, urllib.parse, urllib.request, zipfile

OUT=pathlib.Path('benchmark-data')
VERSIONS={'httpx':'v1.12.0','dnsx':'v1.3.1','katana':'v1.8.0','subfinder':'v2.17.0'}
def write(name,value):
    (OUT/name).write_text(json.dumps(value,indent=2)+'\n')
def read(name):
    return json.loads((OUT/name).read_text())
def request(url,headers=None,limit=100_000_000):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=45) as response:
        body=response.read(limit+1)
        if len(body)>limit:raise RuntimeError('Benchmark response exceeds bound')
        return body
def fixture():
    value=urllib.parse.urlsplit(os.environ['BENCH_TARGET'])
    if value.scheme!='https' or value.username or value.password or value.path not in ('','/') or value.query or value.fragment:raise RuntimeError('Use an HTTPS fixture origin')
    origin=urllib.parse.urlunsplit((value.scheme,value.netloc,'','',''))
    marker=json.loads(request(origin+'/.well-known/pentcloud-recon-fixture',limit=4096))
    if marker.get('fixture')!='pentcloud-recon-v1' or marker.get('nonce')!=os.environ['BENCH_NONCE']:raise RuntimeError('Owned fixture proof did not match')
    return origin
def install():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Install only in the isolated Actions runner')
    OUT.mkdir(exist_ok=True);(OUT/'resources').mkdir(exist_ok=True)
    started=time.time();origin=fixture();tools=pathlib.Path('.bench-tools').resolve();tools.mkdir(exist_ok=True)
    bin_dir=pathlib.Path('/home/runner/go/bin');bin_dir.mkdir(parents=True,exist_ok=True)
    assets=[]
    for tool,version in VERSIONS.items():
        headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+os.environ['GH_TOKEN']}
        release=json.loads(request('https://api.github.com/repos/projectdiscovery/'+tool+'/releases/tags/'+version,headers,1_000_000))
        asset=next(a for a in release['assets'] if a['name'].endswith('_linux_amd64.zip'))
        body=request(asset['browser_download_url']);digest=hashlib.sha256(body).hexdigest()
        if asset.get('digest')!='sha256:'+digest:raise RuntimeError('Pinned release asset digest mismatch for '+tool)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            info=next(i for i in archive.infolist() if i.filename==tool)
            if info.file_size>150_000_000:raise RuntimeError('Binary exceeds benchmark limit')
            binary=tools/tool;binary.write_bytes(archive.read(info));binary.chmod(0o755)
        wrapper='#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/time -v -o "benchmark-data/resources/${BENCH_TRIAL:-setup}-'+tool+'.txt" '+shlex.quote(str(binary))+' "$@"\n'
        (bin_dir/tool).write_text(wrapper);(bin_dir/tool).chmod(0o755)
        assets.append({'tool':tool,'version':version,'assetSha256':digest,'downloadBytes':len(body),'binaryBytes':info.file_size})
    write('setup.json',{'origin':origin,'startedAt':datetime.datetime.fromtimestamp(started,datetime.timezone.utc).isoformat(),'startedEpoch':started,'setupMs':round((time.time()-started)*1000),'assets':assets,'cpuCount':os.cpu_count()})
    print('Pinned recon tools installed and owned fixture verified')
def prepare(trial):
    meta=read('setup.json');target=meta['origin']+'/cases/gha-'+str(trial)+'/'
    (OUT/'hosts.txt').write_text(urllib.parse.urlsplit(target).hostname+'\n');(OUT/'targets.txt').write_text(target+'\n')
    write('trial-'+str(trial)+'-start.json',{'trial':trial,'target':target,'startedEpoch':time.time()})
def katana(trial):
    meta=read('trial-'+str(trial)+'-start.json');target=meta['target']
    subprocess.run(['/home/runner/go/bin/katana','-u',target,'-cs','^'+re.escape(target),'-d','2','-c','1','-p','1','-rl','2','-ct','20s','-timeout','10','-j','-silent','-duc','-o',str(OUT/('katana-'+str(trial)+'.jsonl'))],check=True,timeout=35)
def jsonl(name):
    p=OUT/name
    if not p.exists():return []
    result=[]
    for line in p.read_text().splitlines():
        try:result.append(json.loads(line))
        except json.JSONDecodeError:pass
    return result
def resources(name):
    p=OUT/'resources'/name
    if not p.exists():return {'unavailable':True}
    text=p.read_text();result={}
    for label,key in [('User time (seconds)','userSeconds'),('System time (seconds)','systemSeconds'),('Maximum resident set size (kbytes)','maxRssKiB'),('Exit status','exitStatus')]:
        m=re.search(re.escape(label)+r':\s*([\d.]+)',text)
        if m:result[key]=float(m[1])
    return result
def finish_trial(trial):
    start=read('trial-'+str(trial)+'-start.json');http=jsonl('httpx-'+str(trial)+'.jsonl');dns=jsonl('dnsx-'+str(trial)+'.jsonl');crawl=jsonl('katana-'+str(trial)+'.jsonl')
    paths=sorted(set(r.get('request',{}).get('endpoint','') for r in crawl if r.get('request',{}).get('endpoint','').startswith(start['target'])))
    hp=OUT/('httpx-'+str(trial)+'.jsonl');http_observed=hp.stat().st_mtime if hp.exists() else None
    write('trial-'+str(trial)+'-result.json',{'mode':'github-official-actions','trial':trial,'target':start['target'],'firstHttpFactsMs':round((http_observed-start['startedEpoch'])*1000) if http_observed else None,'executionMs':round((time.time()-start['startedEpoch'])*1000),'httpRecords':len(http),'dnsRecords':len(dns),'crawlRecords':len(crawl),'discoveredURLs':paths,'http':http,'resources':{tool:resources(str(trial)+'-'+tool+'.txt') for tool in ['httpx','dnsx','katana']}})
    if not http or 'PentCloud Recon Fixture' not in json.dumps(http):raise RuntimeError('HTTP baseline evidence missing')
    if len(paths)<4:raise RuntimeError('Crawl coverage below owned fixture expectation')
def finish():
    trials=[read('trial-'+str(i)+'-result.json') for i in range(1,4)]
    result={'setup':read('setup.json'),'trials':trials,'passiveDiscovery':resources('passive-subfinder.txt'),'modelRequests':0,'githubTokenUsedOnlyForReleaseMetadata':True}
    write('summary.json',result)
    with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as out:
        out.write('## Owned recon benchmark\n\nPinned official tool binaries; synthetic fixture; no application or model credentials.\n\n')
        out.write('| Trial | First HTTP facts (ms) | Execution (ms) | Crawl URLs |\n|---|---:|---:|---:|\n')
        for t in trials:out.write(f"| {t['trial']} | {t['firstHttpFactsMs']} | {t['executionMs']} | {len(t['discoveredURLs'])} |\n")
    print('BENCH_RESULT '+json.dumps({'setupMs':result['setup']['setupMs'],'trials':[{k:t[k] for k in ['trial','firstHttpFactsMs','executionMs','httpRecords','dnsRecords','crawlRecords']} for t in trials]}))
if __name__=='__main__':
    action=sys.argv[1]
    if action=='install':install()
    elif action=='prepare':prepare(int(sys.argv[2]))
    elif action=='katana':katana(int(sys.argv[2]))
    elif action=='finish-trial':finish_trial(int(sys.argv[2]))
    elif action=='finish':finish()
    elif action=='domain':
        domain=os.environ.get('BENCH_PASSIVE_DOMAIN','')
        if domain and not re.fullmatch(r'(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,63}',domain):raise RuntimeError('Invalid passive domain')
    else:raise RuntimeError('Unknown benchmark operation')
