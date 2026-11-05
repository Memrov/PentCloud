import importlib.util,io,json,unittest,zipfile
from pathlib import Path

spec=importlib.util.spec_from_file_location('qa_trace',Path(__file__).parent/'lib/sanitize-qa-trace.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class TraceTests(unittest.TestCase):
    def archive(self,files):
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w') as target:
            for name,value in files.items():target.writestr(name,value)
        return output.getvalue()
    def test_credentials_and_body_removed(self):
        event={'type':'before','params':{'headers':{'Authorization':'unlisted-secret'},'extraHTTPHeaders':{'CF-Access-Client-Secret':'unlisted-secret'},'cookies':['cookie-secret'],'value':'fixture-secret','url':'https://live.browser.run/page?jwt=private'}}
        raw=self.archive({'0.trace':json.dumps(event),'0.network':'','resources/body.json':'private-response','resources/frame.png':b'fixture-image'})
        with zipfile.ZipFile(io.BytesIO(module.sanitize(raw,['fixture-secret']))) as result:
            self.assertEqual(set(result.namelist()),{'0.trace','0.network','resources/frame.png'})
            value=json.loads(result.read('0.trace'));self.assertNotIn('headers',value['params']);self.assertNotIn('cookies',value['params'])
            self.assertNotIn('extraHTTPHeaders',value['params'])
            self.assertEqual(value['params']['value'],'[redacted]');self.assertNotIn('private',value['params']['url'])
    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):module.sanitize(self.archive({'../escape.trace':'{}'}),[])

if __name__=='__main__':unittest.main()
