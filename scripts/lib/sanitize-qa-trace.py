"""Remove credential-bearing metadata before a private QA trace leaves memory."""
import base64,io,json,re,sys,zipfile

def sanitize(data,secrets):
    def clean(value):
        if isinstance(value,dict):
            return {k:clean(v) for k,v in value.items() if k.lower() not in {'headers','requestheaders','responseheaders','extrahttpheaders','cookies','storagestate'}}
        if isinstance(value,list):return [clean(v) for v in value]
        if isinstance(value,str):
            for secret in secrets:
                if secret:value=value.replace(secret,'[redacted]')
            value=re.sub(r'([?&]jwt=)[^\s"<>]+',r'\1[redacted]',value)
            value=re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[redacted-jwt]',value)
        return value
    result=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source,zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            name=entry.filename
            if name.startswith('/') or '..' in name.split('/'):raise ValueError('Unsafe archive path')
            payload=source.read(entry)
            if name.endswith(('.trace','.network','.stacks')):
                payload=('\n'.join(json.dumps(clean(json.loads(line)),ensure_ascii=False) for line in payload.decode().splitlines() if line)+'\n').encode()
                if any(s.encode() in payload for s in secrets if s):raise ValueError('Trace credential remains')
            elif not name.endswith(('.png','.jpeg','.jpg')):continue
            target.writestr(name,payload)
    return result.getvalue()

if __name__=='__main__':
    value=json.load(sys.stdin)
    sys.stdout.buffer.write(sanitize(base64.b64decode(value['zip']),value['secrets']))
