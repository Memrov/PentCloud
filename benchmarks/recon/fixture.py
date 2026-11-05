"""Ephemeral, synthetic-only fixture for the isolated recon benchmark."""
import collections, hashlib, http.server, json, os, pathlib, re, signal, subprocess, sys, threading, time, urllib.request

OUT=pathlib.Path('benchmark-data'); OUT.mkdir(exist_ok=True)
NONCE=os.environ['BENCH_NONCE']
VERSION='2026.10.7'
DIGEST='1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872'
COUNTS=collections.defaultdict(collections.Counter)
LOCK=threading.Lock()
LINKS=['about','docs','login','openapi.json','api/catalog','assets/app.js']
def html(base,title,extra=''):
    return f'<!doctype html><html lang="en"><head><title>{title}</title><meta name="generator" content="PentCloud Recon Fixture 1.0"></head><body><h1>{title}</h1>{extra}<a href="{base}">Home</a></body></html>'
class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):self.do_GET()
    def do_GET(self):
        path=self.path.split('?',1)[0];status=200;kind='application/json'
        if path=='/.well-known/pentcloud-recon-fixture':body=json.dumps({'fixture':'pentcloud-recon-v1','nonce':NONCE})
        elif re.fullmatch('/__stats/[a-z0-9-]{1,40}',path):
            with LOCK:
                counts=dict(COUNTS[path.rsplit('/',1)[1]])
            body=json.dumps({'requests':sum(counts.values()),'paths':counts})
        else:
            match=re.fullmatch(r'/cases/([a-z0-9-]{1,40})/(.*)',path)
            if not match:status=404;body=json.dumps({'error':'Synthetic fixture route not found'})
            else:
                case,part=match.groups();base='/cases/'+case+'/';kind='text/html; charset=utf-8'
                with LOCK:COUNTS[case][part or '/']+=1
                if not part:body=html(base,'PentCloud Recon Fixture',''.join(f'<a href="{base+x}">{x}</a>' for x in LINKS)+'<a href="https://blocked.pentcloud.invalid/forbidden">Out of scope fixture link</a>')
                elif part=='about':body=html(base,'About the fixture')
                elif part=='docs':body=html(base,'Fixture API documentation',f'<a href="{base}openapi.json">OpenAPI</a>')
                elif part=='login':body=html(base,'Fixture login','<form><input name="username"><input type="password" name="password"><button>Demo only</button></form>')
                elif part=='openapi.json':kind='application/json';body=json.dumps({'openapi':'3.0.3','info':{'title':'PentCloud fixture API','version':'1.0'},'paths':{base+'api/catalog':{'get':{'responses':{'200':{'description':'Synthetic catalog'}}}}}})
                elif part=='api/catalog':kind='application/json';body=json.dumps({'items':[{'id':'fixture-1','name':'Synthetic item'}]})
                elif part=='assets/app.js':kind='application/javascript';body='console.log("Synthetic recon fixture; no background requests");'
                else:status=404;body=html(base,'Fixture page not found')
        raw=body.encode();self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(raw)));self.send_header('X-Powered-By','Express');self.send_header('X-Pentcloud-Fixture','recon-v1');self.send_header('Cache-Control','no-store');self.end_headers()
        if self.command!='HEAD':self.wfile.write(raw)
    def log_message(self,*args):pass
def start():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Fixture runs only in isolated GitHub runner')
    with urllib.request.urlopen(f'https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/cloudflared-linux-amd64',timeout=60) as r:binary=r.read(100_000_001)
    if hashlib.sha256(binary).hexdigest()!=DIGEST:raise RuntimeError('cloudflared release digest mismatch')
    executable=pathlib.Path('.bench-cloudflared').resolve();executable.write_bytes(binary);executable.chmod(0o755)
    serverlog=open(OUT/'fixture-server.log','w');tunnellog=open(OUT/'fixture-tunnel.log','w')
    server=subprocess.Popen([sys.executable,__file__,'serve'],stdout=serverlog,stderr=serverlog,start_new_session=True)
    tunnel=subprocess.Popen([str(executable),'tunnel','--no-autoupdate','--url','http://127.0.0.1:8765'],stdout=tunnellog,stderr=tunnellog,start_new_session=True)
    (OUT/'fixture-pids.json').write_text(json.dumps([server.pid,tunnel.pid]))
    for _ in range(90):
        text=(OUT/'fixture-tunnel.log').read_text();urls=re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com',text)
        if urls:
            origin=urls[-1]
            try:
                with urllib.request.urlopen(origin+'/.well-known/pentcloud-recon-fixture',timeout=5) as r:marker=json.load(r)
                if marker.get('nonce')==NONCE:
                    endpoint=pathlib.Path('fixture-endpoint');endpoint.mkdir(exist_ok=True);(endpoint/'fixture.json').write_text(json.dumps({'origin':origin,'nonce':NONCE,'cloudflaredVersion':VERSION,'cloudflaredSha256':DIGEST}))
                    with open(os.environ['GITHUB_ENV'],'a') as env:env.write('BENCH_TARGET='+origin+'\n')
                    print('Synthetic fixture and temporary tunnel ready');return
            except Exception:pass
        if server.poll() is not None or tunnel.poll() is not None:raise RuntimeError('Fixture process exited')
        time.sleep(1)
    raise RuntimeError('Fixture tunnel readiness timeout')
def stop():
    path=OUT/'fixture-pids.json'
    if path.exists():
        for pid in json.loads(path.read_text()):
            try:os.killpg(pid,signal.SIGTERM)
            except ProcessLookupError:pass
def wait():
    api='https://api.github.com/repos/'+os.environ['GITHUB_REPOSITORY']+'/commits/'+os.environ['GITHUB_SHA']+'/statuses?per_page=100'
    for _ in range(40):
        req=urllib.request.Request(api,headers={'Accept':'application/vnd.github+json','Authorization':'Bearer '+os.environ['GH_TOKEN']})
        with urllib.request.urlopen(req,timeout=30) as r:statuses=json.load(r)
        status=next((s for s in statuses if s['context']=='recon-benchmark/cloudflare'),None)
        if status and status['state']!='pending':
            (OUT/'cloudflare-observation-status.json').write_text(json.dumps({k:status[k] for k in ['state','description','updated_at']},indent=2));print('External Cloudflare measurement observation finished');return
        time.sleep(20)
    raise RuntimeError('External Cloudflare benchmark observation deadline exceeded')
if __name__=='__main__':
    action=sys.argv[1]
    if action=='serve':http.server.ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()
    elif action=='start':start()
    elif action=='stop':stop()
    elif action=='wait':wait()
    else:raise RuntimeError('Unknown fixture operation')
