import {expect,it} from 'vitest';
import {reportCandidates,referencedReport,readReportFile} from '../src/ui/report-model';
import type {RunFile} from '../src/ui/materials-api';
const commit='b'.repeat(40),file=(path:string,patch:Partial<RunFile>={}):RunFile=>({path,name:path.split('/').at(-1)!,size:20,mediaType:'text/plain',kind:'output',commit,previewable:true,...patch});
it('offers only bounded accepted Markdown outputs, never uploaded inputs or internal records',()=>{
 expect(reportCandidates([file('assessment.md'),file('README.md'),file('upload.md',{kind:'input'}),file('.pentagi/jobs/x/result.md'),file('binary.md',{previewable:false}),file('huge.md',{size:3*1024*1024})]).map(f=>f.path)).toEqual(['assessment.md','README.md']);
});
it('requires explicit choice when reviewer notes do not identify exactly one existing file',()=>{
 const a=file('assessment.md'),b=file('notes.md');
 expect(referencedReport([a,b],'See `assessment.md`.')).toBe(a);
 expect(referencedReport([a,b],'Verdict: SUCCESS')).toBeUndefined();
 expect(referencedReport([a,b],'See assessment.md and notes.md')).toBeUndefined();
 expect(referencedReport([a],'See not-assessment.md')).toBeUndefined();
});
it('reads the full immutable report through the existing authenticated file endpoint',async()=>{
 const text='# Assessment\n'+ 'evidence\n'.repeat(10000);
 const textFile=file('assessment.md',{size:new TextEncoder().encode(text).length});
 let url='';const fetcher=async(input:unknown)=>{url=String(input);return new Response(text);};
 expect(await readReportFile('r',textFile,fetcher as typeof fetch)).toBe(text);
 expect(url).toContain('commit='+commit);expect(url).toContain('path=assessment.md');expect(url).not.toContain('preview=');
});
it('rejects binary, oversized and invalid UTF-8 instead of silently truncating evidence',async()=>{
 await expect(readReportFile('r',file('bad.md'),(async()=>new Response(new Uint8Array([255]))) as typeof fetch)).rejects.toThrow(/UTF-8/);
 await expect(readReportFile('r',file('bad.md'),(async()=>new Response('a\0b')) as typeof fetch)).rejects.toThrow(/binary/);
 await expect(readReportFile('r',file('bad.md'),(async()=>new Response('x'.repeat(2*1024*1024+1))) as typeof fetch)).rejects.toThrow(/2 MiB/);
});

it('offers only explicitly validated report-kind documents within reporter evidence',()=>{expect(reportCandidates([file('.pentagi/evidence/r/assessment.md',{kind:'report'}),file('.pentagi/evidence/r/raw.md'),file('.pentagi/jobs/r/result.md',{kind:'report'})]).map(f=>f.path)).toEqual(['.pentagi/evidence/r/assessment.md']);});
