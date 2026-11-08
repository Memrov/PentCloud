import { Button, LinkButton, Tooltip } from "@cloudflare/kumo";
import { BrowserIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { createBrowserLiveView } from "../api";

/** Credentials stay in this control's memory until opened or unmounted. */
export function BrowserLiveViewControl({ jobId }: { jobId: string }) {
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<{ url: string; expiresAt: number }>();
  const [message, setMessage] = useState<string>();
  const create = async () => {
    if (pending) return;
    setPending(true);
    setView(undefined);
    setMessage(undefined);
    try {
      const result = await createBrowserLiveView(jobId);
      if (result.available)
        setView({ url: result.url, expiresAt: result.expiresAt });
      else setMessage("No active browser is available.");
    } catch {
      setMessage(
        "Browser view is unavailable. Try again when the specialist is browsing."
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tooltip
        content="Create a read-only link to the active browser"
        render={
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => void create()}
            aria-label={
              pending ? "Creating browser view" : "Create browser view"
            }
            icon={<BrowserIcon size={15} />}
            className="max-[820px]:min-w-0 max-[820px]:px-2"
          >
            <span className="hidden min-[821px]:inline">
              {pending ? "Creating view…" : "Create browser view"}
            </span>
          </Button>
        }
      />
      {view && (
        <LinkButton
          variant="secondary"
          href={view.url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          onClick={(event) => {
            if (view.expiresAt <= Date.now()) {
              event.preventDefault();
              setMessage("This link expired. Create a new browser view.");
            }
            setView(undefined);
          }}
        >
          Open read-only view
        </LinkButton>
      )}
      <span role="status" className="text-base">
        {message ?? (view ? "Open within one minute." : "")}
      </span>
    </div>
  );
}
