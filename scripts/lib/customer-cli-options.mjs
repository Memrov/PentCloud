import assert from 'node:assert/strict';
export function parseCustomerArguments(args){
  if(args.includes('--help'))return null;
  const [command='setup',...rest]=args;
  assert(['setup','plan','install','upgrade','doctor','cleanup','export','import-targets','uninstall'].includes(command),'PC_COMMAND');
  const options={},boolean=['--apply','--headless','--full'];
  for(let n=0;n<rest.length;n++){
    const key=rest[n];assert([...boolean,'--config','--state','--images-cache','--output','--input','--data','--confirm'].includes(key)&&!Object.hasOwn(options,key),'PC_OPTIONS');
    if(boolean.includes(key))options[key]=true;
    else{assert(rest[n+1]&&!rest[n+1].startsWith('--'),'PC_OPTION_VALUE');options[key]=rest[++n];}
  }
  if(command!=='setup'||options['--headless'])assert(options['--config'],'PC_CONFIG_REQUIRED');
  if(!['setup','plan'].includes(command)||options['--headless'])assert(options['--state'],'PC_STATE_REQUIRED');
  if(['install','upgrade','cleanup','import-targets','uninstall'].includes(command)||command==='setup'&&options['--headless']||command==='doctor'&&options['--full'])assert(options['--apply'],'PC_APPLY_REQUIRED');
  if(command==='export')assert(options['--output'],'PC_OUTPUT_REQUIRED');
  if(command==='import-targets')assert(options['--input'],'PC_INPUT_REQUIRED');
  if(command==='uninstall')assert(['retain','delete'].includes(options['--data'])&&options['--confirm'],'PC_UNINSTALL_CONFIRM');
  return {command,options};
}
