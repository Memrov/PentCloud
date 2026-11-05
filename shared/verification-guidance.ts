/** The catalog identifies the platform; the live program still owns its rules. */
export function verificationGuidance(platform?:string):{alias?:string;docs?:string}{
 switch(platform?.toLowerCase()){
  case 'hackerone':return {alias:'username[+tag]@wearehackerone.com',docs:'https://docs.hackerone.com/en/articles/8404308-hacker-email-alias'};
  case 'intigriti':return {alias:'username[+tag]@intigriti.me',docs:'https://kb.intigriti.com/en/articles/5412984-understanding-testing-requirements'};
  case 'bugcrowd':return {alias:'username@bugcrowdninja.com',docs:'https://docs.bugcrowd.com/researchers/participating-in-program/your-bugcrowdninja-email-address/'};
  default:return {};
 }
}
