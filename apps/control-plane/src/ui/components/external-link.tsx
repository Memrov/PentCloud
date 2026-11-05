import { Button, Dialog, Link, LinkButton } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

/** Untrusted links never become automatic browser requests or silent navigation. */
export function ExternalLink({href, children}: {href?: string | undefined; children: ReactNode}) {
  const [open, setOpen] = useState(false);
  let url: URL;
  const base = globalThis.location?.href ?? "https://pentcloud.invalid/";
  try {
    url = new URL(href ?? "", base);
    if (!href || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return <span>{children}</span>;
  } catch { return <span>{children}</span>; }
  if (url.origin === new URL(base).origin) return <Link href={url.href}>{children}</Link>;
  return <>
    <Link className="external-link" render={<button type="button"/>} onClick={() => setOpen(true)}>{children}</Link>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="grid gap-4">
        <Dialog.Title>Open an external website?</Dialog.Title>
        <Dialog.Description>This opens on your device. The website can see your IP address. Use the cloud browser to inspect targets without visiting them from your device.</Dialog.Description>
        <p className="break-all text-base">{url.href}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>Stay in PentCloud</Button>
          <LinkButton variant="primary" href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setOpen(false)}>Open website</LinkButton>
        </div>
      </Dialog>
    </Dialog.Root>
  </>;
}
