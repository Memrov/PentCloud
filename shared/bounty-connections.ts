export const BOUNTY_PLATFORMS=[
 {id:'hackerone',name:'HackerOne',token:'PENTCLOUD_HACKERONE_API_TOKEN',username:'PENTCLOUD_HACKERONE_USERNAME'},
 {id:'intigriti',name:'Intigriti',token:'PENTCLOUD_INTIGRITI_API_TOKEN'},
 {id:'bugcrowd',name:'Bugcrowd',token:'PENTCLOUD_BUGCROWD_API_TOKEN',tokenLabel:'API token (ID:secret)',setup:'Use a Hacker API token with read:engagement_list. Store ID:secret or the generated Token authorization value. Your account needs Hacker API access and verified identity.',docs:'https://docs.bugcrowd.com/hacker-api/authentication/'},
 {id:'yeswehack',name:'YesWeHack',token:'PENTCLOUD_YESWEHACK_API_TOKEN',tokenLabel:'Researcher access token (JWT)',setup:'Use your researcher JWT as documented by YesWeHack’s YesWeCaido integration. Store it in Cloudflare, then check this connection. Renew expired tokens there. IP-restricted sessions may be rejected from Cloudflare.',docs:'https://github.com/yeswehack/yeswecaido#setup'},
] as const;
export type BountyPlatform=typeof BOUNTY_PLATFORMS[number]['id'];
export interface BountyConnection {platform:BountyPlatform;status:'missing'|'unchecked'|'ready';checkedAt?:number;expiresAt?:number}
export interface EmailReceiver {configured:boolean;address?:string}
export interface BountyStatus {connections:BountyConnection[];email:{cloudflare:EmailReceiver;agentmail:EmailReceiver}}
export type MailSetup={configured:boolean;provider:'cloudflare'|'agentmail';address?:string;status?:'idle'|'waiting'|'received'|'expired';expiresAt?:number;code?:string;excerpt?:string;links?:string[]};
