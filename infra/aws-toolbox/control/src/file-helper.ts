/** Fixed native exec helper. All path traversal uses directory FDs with NOFOLLOW.
 * argv is data, never shell source. Output bodies are bounded and never logged. */
export const FILE_HELPER = String.raw`
import os,sys,json,stat,hashlib,secrets
q=json.loads(sys.argv[1]); limit=2097152

def directory(path,create=False):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.split('/'):
            if not part: continue
            if part in ('.','..'): raise ValueError('path')
            if create:
                try: os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError: pass
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=nxt
        return fd
    except: os.close(fd); raise

def parent(path,create=False):
    bits=path.split('/')
    if any(not p or p in ('.','..') or p.lower()=='.git' for p in bits): raise ValueError('path')
    fd=directory(q['root'],create)
    try:
        for part in bits[:-1]:
            if create:
                try: os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError: pass
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        return fd,bits[-1]
    except: os.close(fd); raise

def data_at(fd,name):
    f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    try:
        info=os.fstat(f)
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit: raise ValueError('type_or_size')
        with os.fdopen(f,'rb',closefd=False) as stream: data=stream.read(limit+1)
        if len(data)>limit: raise ValueError('size')
        return data
    finally: os.close(f)

def meta(path,data):return dict(path=path,size=len(data),sha256=hashlib.sha256(data).hexdigest())
def allowed(path):
    if q.get('allowedPath') and path!=q['allowedPath']: raise ValueError('operation')
    if q.get('scanId') and q['scanId'] not in path: raise ValueError('operation')

def run():
    mode=q['mode']
    if mode=='put':
        fd,name=parent(q['path'],True);tmp='.upload-'+secrets.token_hex(16)
        try:
            f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=fd)
            try:
                with os.fdopen(f,'wb',closefd=False) as stream:
                    remaining=q['size']; sha=hashlib.sha256()
                    while remaining:
                        chunk=sys.stdin.buffer.read(min(65536,remaining))
                        if not chunk: raise ValueError('truncated')
                        stream.write(chunk);sha.update(chunk);remaining-=len(chunk)
                    if sys.stdin.buffer.read(1) or sha.hexdigest()!=q['sha256']: raise ValueError('hash_or_size')
                    stream.flush();os.fsync(f)
            finally:os.close(f)
            try:os.link(tmp,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False)
            except FileExistsError:
                old=meta(q['path'],data_at(fd,name))
                if old['sha256']!=q['sha256'] or old['size']!=q['size']:raise ValueError('conflict')
            return dict(path=q['path'],size=q['size'],sha256=q['sha256'])
        finally:
            try:os.unlink(tmp,dir_fd=fd)
            except FileNotFoundError:pass
            os.close(fd)
    if mode in ('stat','get'):
        allowed(q['path']);fd,name=parent(q['path'])
        try:data=data_at(fd,name)
        finally:os.close(fd)
        value=meta(q['path'],data)
        if mode=='stat':return value
        if value['size']!=q['size'] or value['sha256']!=q['sha256']:raise ValueError('changed')
        sys.stdout.buffer.write(data);return None
    if mode=='list':
        files=[];unavailable=[];pending=[''];truncated=False;visited=0
        while pending and len(files)<64 and visited<128:
            prefix=pending.pop(0);visited+=1
            try:fd=directory(q['root']+('/'+prefix if prefix else ''))
            except FileNotFoundError:continue
            try:
                names=sorted(os.listdir(fd))
                if len(names)>1024:truncated=True
                for name in names[:1024]:
                    if name.startswith('.upload-'):continue
                    path=prefix+'/'+name if prefix else name
                    info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):continue
                    if stat.S_ISDIR(info.st_mode):
                        if path.count('/')<6 and len(pending)<128:pending.append(path)
                        else:truncated=True
                        continue
                    if q.get('allowedPath') and path!=q['allowedPath']:continue
                    if q.get('scanId') and q['scanId'] not in path:continue
                    try:files.append(meta(path,data_at(fd,name)))
                    except (OSError,ValueError):unavailable.append(dict(path=path,reason='unavailable_or_over_2_MiB'))
                    if len(files)>=64:truncated=True;break
            finally:os.close(fd)
        return dict(files=files,truncated=truncated or bool(pending),unavailable=unavailable[:64])
    raise ValueError('mode')
try:
    result=run()
    if result is not None:print(json.dumps(result,separators=(',',':')))
except Exception:
    sys.stderr.write('File transfer rejected\n');sys.exit(65)
`;
