---
name: pentcloud-tools
description: Detailed native Computer and stock Kali tool procedures, output handling, framework lifecycle and reference inventory for PentCloud specialists.
---

# PentCloud tool procedures

This bundled OpenCode skill contains supplementary detailed procedures retained from PentAGI. Role identity, substantive methodology, language, completion and essential safety remain always loaded in each role. This reference inventory does not promise that every named Linux tool or arbitrary command execution is exposed. Use only the live advertised tools and schemas. Worker shell handles text/files/read-only Git and HTTP(S) curl through Cloudflare fetch, and has no Linux binaries, package manager, sockets or detached processes; isolated JavaScript and persistent Chromium use their own advertised tools. Linux operations use stock Kali MCP, which owns remote scan/session lifecycle. Inspect returned IDs; never retry a mutation with an unknown remote outcome before reconciliation. Preserve the shared stock Kali image and clean up only owned operations.

Linux tools use one shared on-demand Cloudflare Kali Container with the unchanged stock image and MCP schemas. The runtime waits for readiness and the complete stock catalog before a Kali-capable specialist calls its model, and keeps the running Container awake during active work. The native 30-minute inactivity timeout stops idle Kali; it is not an attempt deadline. Scratch files and live processes are not durable: persist needed findings and outputs through the existing Workspace/result and Artifacts publication paths. Retain operation/session IDs, inspect the same operation and reconcile unknown outcomes before any mutation retry; never assume a lost session or process can resume.

## Native delegation and operator inputs

Delegation returns a dispatch receipt. Primary dispatches a batch, calls yield and stops; fresh primary slices receive completed wave results. Other specialists immediately submit their own result, even after delegating follow-up work. Only primary may use an advertised native question tool when missing operator input prevents work. OpenCode owns the pending question and model recovery; an interrupted question may be reissued after host reset. Use the authenticated operator reply for the current pending question; do not poll, use legacy ask, build another input queue or request routine per-tool confirmation. Cancellation and the attempt's immutable publication fence remain authoritative.

## Native HTTP and scanner checks

Use Worker shell curl for ordinary HTTP(S), including request methods, headers, bodies and guarded workspace output. It is Cloudflare Computer's fetch-backed curl subset, not Linux libcurl: check curl --help before using extra flags. --dump-header / -D is unavailable; curl --include URL > response.txt retains headers and body, while -o stores the body only. Set cwd to the supplied task workspace, use explicit request timeouts and honor the engagement limits. Worker localhost is not Kali localhost.

For stock WhatWeb, choose aggression stealthy for baseline discovery; it produced an observed HTTP response and technology results in native acceptance. The advertised polite preset returned completed with no HTTP status or technologies on the same reachable target. A completed label alone is not proof of coverage: inspect http_status and error, retain the scan_id, and report empty output as incomplete. Do not retry unknown operations.

For FFUF, start with a small task-owned wordlist imported with pentcloud_kali_import. Set threads and rate explicitly within the engagement budget; timeout is a request timeout, not a whole-scan deadline. Compare a known path with a unique missing path and filter the SPA catch-all by response size before broader discovery. Bound total work and retain the existing scan ID for result inspection and evidence export. Use only options in the live tool schema.

## ADVISER — BACKEND TERMINAL EXECUTION MECHANICS

<terminal_execution_model>
**Command Execution:** Worker shell handles supported text/file operations and read-only Git in the guarded workspace. Linux commands and exploit frameworks run only through advertised stock Kali MCP tools.

**Remote Operation Lifecycle:**
- Worker shell does not implement detached Linux processes.
- For long-running Kali work, retain the returned operation/scan ID and inspect it with the matching stock result tool.
- A timeout or interrupted response does not prove the remote operation stopped; reconcile uncertain outcomes before retrying a mutation.
- Tool request limits are distinct from attempt lifetime; no default attempt deadline is imposed.

**Process Isolation:** Each msfconsole/python/bash process is isolated - cannot share state between separate commands.

**Common Agent Mistakes to Identify:**
1. **Interactive mode hang:** Running `msfconsole` without `-x` flag → process waits for input indefinitely
2. **Missing exit:** Commands like `msfconsole -x "exploit"` without `;exit` → never complete
3. **Orphaned processes:** Multiple hung processes consuming resources, blocking ports
4. **Port conflicts:** Not checking `netstat -tulnp | grep [PORT]` before launching listeners
5. **Unnecessary handlers:** Using `exploit/multi/handler` when `exploit` command includes handler
6. **Session isolation:** Trying to check sessions via new msfconsole instance (won't see them)

**Correct MSF Patterns (recommend when you see mistakes above):**

**Standalone (simple):** If the advertised Kali tool supports a command sequence, preserve the noninteractive, explicit-exit pattern: `msfconsole -q -x "use exploit/...; set LPORT [allocated]; exploit; sleep 20; sessions -l; exit"`. Submit through the advertised stock tool and inspect its returned operation ID. Worker shell cannot execute msfconsole.

**RPC Daemon (complex workflows):**
1. Check available ports and existing operation/session state through advertised stock Kali tools before starting any daemon.
2. Use a live framework/RPC session only when a stock MCP tool explicitly exposes it; retain its returned identity and connection details.
3. Reconnect/inspect the same returned session through its supported stock tool. Do not invent direct RPC connections, credentials, detached-process support or localhost reachability in Worker shell.

**Diagnostics (on Kali, only through advertised tools):**
- Inspect orphaned framework processes, operation/session identity and owned listener ports before launching another operation
- Check the relevant port state (a stock tool may expose the equivalent of `netstat -tulnp`)
- Clean up only processes/listeners owned by the current operation, using its supported stock lifecycle tool; do not kill unrelated shared-host work

**Output Minimization:** Always recommend `-q` flags to reduce token usage.
**Network Reachability:** Check allocated port availability and returned callback reachability before any daemon; do not assume Worker and Kali share localhost.
</terminal_execution_model>

## CODER — COMMAND EXECUTION RULES

<terminal_protocol>
<directory>Set cwd explicitly to the structured task workspace (or use relative paths beneath it); do not assume a prior command changed the next command's directory.</directory>
<paths>Use relative paths beneath the task workspace, or absolute paths confined to that root</paths>
<timeouts>Use documented request limits; redirect large output to task files. For long-running stock Kali operations inspect the operation/scan ID through its advertised result tool.</timeouts>
<repetition>Maximum 3 attempts of identical tool calls</repetition>
<safety>Auto-approve commands with flags like `-y` when possible</safety>
<detachment>Worker shell does not support detached Linux processes. Use the stock Kali MCP operation lifecycle for long-running work; retain operation IDs, inspect completion, and reconcile unknown outcomes before any retry.</detachment>
<management>Create dedicated working directories for file operations</management>
</terminal_protocol>

## MAINTENANCE — COMMAND EXECUTION RULES

<terminal_protocol>
<directory>Set cwd explicitly to the structured task workspace (or use relative paths beneath it); do not assume a prior command changed the next command's directory.</directory>
<paths>Use relative paths beneath the task workspace, or absolute paths confined to that root</paths>
<timeouts>Use documented request limits; redirect large output to task files. For long-running stock Kali operations inspect the operation/scan ID through its advertised result tool.</timeouts>
<repetition>Maximum 3 attempts of identical tool calls</repetition>
<safety>Auto-approve commands with flags like `-y` when possible</safety>
<detachment>Worker shell does not support detached Linux processes. Use the stock Kali MCP operation lifecycle for long-running work; retain operation IDs, inspect completion, and reconcile unknown outcomes before any retry.</detachment>
<management>Create dedicated working directories for file operations</management>
</terminal_protocol>

## MEMORIST — COMMAND EXECUTION RULES

<terminal_protocol>
<directory>Set cwd explicitly to the structured task workspace (or use relative paths beneath it); do not assume a prior command changed the next command's directory.</directory>
<paths>Use relative paths beneath the task workspace, or absolute paths confined to that root</paths>
<timeouts>Use documented request limits; redirect large output to task files. For long-running stock Kali operations inspect the operation/scan ID through its advertised result tool.</timeouts>
<repetition>Maximum 3 attempts of identical tool calls</repetition>
<management>Create dedicated working directories for file operations</management>
<detachment>Worker shell does not support detached Linux processes. Use the stock Kali MCP operation lifecycle for long-running work; retain operation IDs, inspect completion, and reconcile unknown outcomes before any retry.</detachment>
<output_handling>Filter large log files using available text/search tools and tail/head instead of displaying entire contents</output_handling>
</terminal_protocol>

## MEMORIST — TOOL UTILIZATION

<available_tools>
<tool name="file">
<purpose>Read files from the guarded task workspace</purpose>
<usage>Use paths confined to the task workspace for reliable file access</usage>
</tool>

<tool name="terminal">
<purpose>Execute supported text/file and read-only Git commands in Worker shell; use advertised Computer JavaScript or stock Kali MCP for their respective capabilities</purpose>
<usage>Respect documented tool limits and inspect stock Kali operation IDs for long-running work</usage>
</tool>
</available_tools>

## PENTESTER — COMMAND EXECUTION RULES

<terminal_protocol>
<directory>Set cwd explicitly to the structured task workspace (or use relative paths beneath it); do not assume a prior command changed the next command's directory.</directory>
<paths>Use relative paths beneath the task workspace, or absolute paths confined to that root</paths>
<timeouts>Use documented request limits; redirect large output to task files. For long-running stock Kali operations inspect the operation/scan ID through its advertised result tool.</timeouts>
<repetition>Maximum 3 attempts of identical tool calls</repetition>
<safety>Auto-approve commands with flags like `-y` when possible</safety>
<detachment>
LONG-RUNNING operations (daemons, servers, monitors) require an advertised stock Kali MCP lifecycle.
Purpose: Track independently running remote work using the stock tool's actual operation/session identity.
Examples: framework RPC, listeners, HTTP servers, packet capture — only when supported by the advertised stock tool.
Behavior: Worker shell cannot start detached Linux processes. Retain the returned operation/session ID and inspect or stop it through its stock lifecycle tool; do not assume a fixed return delay or survival after timeout.

BATCH commands (scanners, exploits, clients) use the advertised stock Kali tool's execution/result contract.
Purpose: Obtain command output and positive completion evidence through its matching result tool.
Examples: nmap, noninteractive msfconsole with explicit exit, gobuster, network retrieval — only when supported by advertised stock tools.
Behavior: Retain and inspect the operation/scan ID until completion. A request timeout is an unknown outcome, not proof the remote process stopped; reconcile before any mutation retry.

Output minimization: Use `-q` flags where available (msfconsole -q, nmap --open, etc.)
</detachment>
<management>Create dedicated working directories for file operations</management>
</terminal_protocol>

## PENTESTER — PENETRATION TESTING TOOLS

<availability>Verify availability in the advertised stock Kali MCP catalog before use. Use an available equivalent or report a missing capability; Worker shell cannot install or execute Linux scanner binaries</availability>


<network_recon desc="Initial target discovery, port scanning, service enumeration, subdomain hunting, DNS reconnaissance">
nmap, masscan, nping, amass, theharvester, subfinder, shuffledns, dnsx, assetfinder, chaos, dnsrecon, fierce, netdiscover, arp-scan, arping, fping, hping3, nbtscan, onesixtyone, sublist3r, ncrack, ike-scan
</network_recon>

<web_testing desc="Web application security assessment, directory brute-forcing, vulnerability scanning, content discovery">
gobuster, dirb, dirsearch, feroxbuster, ffuf, nikto, whatweb, sqlmap, wfuzz, wpscan, commix, davtest, skipfish, httpx, katana, hakrawler, waybackurls, gau, nuclei, naabu
</web_testing>

<password_attacks desc="Credential attacks, hash cracking, brute-force authentication, password list generation">
hydra, john, hashcat, crunch, medusa, patator, hashid, hash-identifier, *2john (7z, bitcoin, keepass, office, pdf, rar, ssh, zip, gpg, putty, truecrypt, luks)
</password_attacks>

<metasploit desc="Exploitation framework for developing and executing exploits, payload generation, pattern analysis">
msfconsole, msfvenom, msfdb, msfrpcd, msfupdate, msf-pattern_*, msf-find_badchars, msf-egghunter, msf-makeiplist

CRITICAL msfconsole rules:
- NEVER run `msfconsole` without `-x` flag (enters interactive mode and hangs)
- ALWAYS use: `msfconsole -q -x "commands; exit"`
- ALWAYS end command chain with `;exit` to prevent hanging processes
- `exploit` command automatically starts handler - do NOT use `exploit/multi/handler` separately
- Each msfconsole process is isolated - combine all operations in ONE command: `exploit; sleep 20; sessions -l; exit`
- Check allocated port availability before launch through an advertised Kali tool (the equivalent of `netstat -tulnp` when supported)
- Inspect and clean up only orphaned framework operations owned by this task through the stock Kali lifecycle tools
</metasploit>

<windows_ad desc="Windows and Active Directory exploitation, lateral movement, credential extraction, Kerberos attacks">
impacket-*, evil-winrm, bloodhound-python, crackmapexec, netexec, responder, certipy-ad, ldapdomaindump, enum4linux, smbclient, smbmap, mimikatz, lsassy, pypykatz, pywerview, minikerberos-*
</windows_ad>

<post_exploit desc="Persistence, pivoting, tunneling, maintaining access, command and control frameworks">
powershell-empire, starkiller, unicorn-magic, weevely, proxychains4, chisel, iodine, ptunnel, socat, netcat, nc, ncat
</post_exploit>

<traffic_analysis desc="Network traffic interception, protocol analysis, SSL/TLS testing, man-in-the-middle attacks">
tshark, tcpdump, tcpreplay, mitmdump, mitmproxy, mitmweb, sslscan, sslsplit, stunnel4
</traffic_analysis>

<reverse_eng desc="Binary analysis, malware examination, firmware extraction, exploit development, steganography">
radare2, r2, rabin2, radiff2, binwalk, bulk_extractor, ROPgadget, ropper, strings, objdump, steghide, foremost
</reverse_eng>

<osint_search desc="Intelligence gathering, exploit database searches, public data collection, wordlist resources">
searchsploit, shodan, censys, wordlists (/usr/share/wordlists), seclists (/usr/share/seclists)
</osint_search>

<usage_notes>

Check tool availability and supported arguments in the advertised stock Kali MCP schema/help before use. Use equivalent available tools if missing; do not modify the stock Kali image.

</usage_notes>

<cli_argument_protocol>
Common AI-agent mistakes with CLI security tools, and how to avoid them:
- Hallucinated flags: verify uncertain syntax with `[tool] -h` or `[tool] --help` before first use, and re-check after any failure suggesting memorized syntax is stale (renamed flag, changed default, different installed version).
- Cross-tool flag assumptions: the same letter or word means different things per tool (`-p` is port in nmap, password in hydra, proxy elsewhere). Never copy a flag from one tool to another, and never invent an output flag (`-o`, `-c`, `-o /dev/null`, etc.) that the target tool's own `--help` does not document.
- Output handling: to save, filter, or discard output, use shell redirection (`> results.txt`, `> /dev/null`, `2>&1`) or the tool's documented logging option instead of guessing an unsupported flag.
- Machine-readable output: when output must be parsed or piped into another tool, request the tool's structured format explicitly (e.g. nmap `-oX`/`-oG`, or a `-json`/`-jsonl` flag many scanners expose) instead of parsing its default free-text output.
- Argument quoting: quote or escape payload strings containing shell metacharacters (semicolons, pipes, ampersands, `$`, quotes, backticks, or glob characters like `*`/`?`) — otherwise the shell, not the target tool, interprets them; this most often corrupts XSS/SQLi payloads and URLs with query parameters.
</cli_argument_protocol>

<msf_workflow_protocol>
Standalone (recommended): Keep related operations in a single noninteractive command or supported stock Kali session. Example command shape (only if accepted by the advertised Kali tool): `msfconsole -q -x "use exploit/...; set LPORT [allocated]; exploit; sleep 20; sessions -l; sessions -i 1 -c 'sysinfo'; exit"`. Capture output through the stock tool's result contract; Worker shell cannot execute it.

RPC Daemon (complex workflows):
Check allocated ports and existing session state → use a stock Kali MCP tool that explicitly exposes live RPC/framework sessions → retain its returned session identity → reconnect/inspect the same session through supported tools → clean up only the owned operation. Do not invent detached-process flags, direct RPC transports or localhost connectivity.

Recovery from mistakes:
If a framework operation hangs or conflicts with a port, inspect its returned operation/session identity and port state through advertised stock tools. Stop only the owned operation through its supported lifecycle; reconcile unknown outcomes before retrying.
</msf_workflow_protocol>

<tool_management_protocol>
<installation_rules>
- Verify tool availability with 'which [toolname]' before attempting installation
- DO NOT install tools that are already functional in the system
- Only install when a required tool is completely missing or non-functional
</installation_rules>
<failure_handling>
- If package manager fails (apt/yum/pip errors, dependencies), immediately switch to equivalent alternatives from available tool categories
- Maximum 2 installation attempts before switching tools
- Prioritize task completion over specific tool usage
- Document any tool substitutions in final report
</failure_handling>
</tool_management_protocol>

Native capability boundary: the tool names above are a methodology/reference inventory, not an availability guarantee. Only advertised stock Kali MCP tools can perform Linux operations. Preserve installation verification and fallback reasoning without changing the stock image or trying Linux package installation in Worker shell.
