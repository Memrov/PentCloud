import { useRef, useState } from "react";
import {
  APIError,
  interruptJob,
  steerJob,
  reviseJob,
  type UIJob
} from "../api";
import { canCorrectMaterialSubmission } from "../materials-api";
import type { useMaterialDraft } from "./materials";
interface RevisionSubmission {
  instructions: string;
  requestId: string;
  uploadIds: string[];
}

/** Keep request identity synchronous while exposing a render-safe submission snapshot. */
export function useConversationActions({
  job,
  input,
  composerAvailable,
  conversing,
  filesSelected,
  materials,
  onRevision,
  onDraftChange
}: {
  job: UIJob;
  input: string;
  composerAvailable: boolean;
  conversing: boolean;
  filesSelected: boolean;
  materials: ReturnType<typeof useMaterialDraft>;
  onRevision: (job?: UIJob) => void;
  onDraftChange: ((value: string, expected?: string) => void) | undefined;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submissionRef = useRef<RevisionSubmission | undefined>(undefined);
  const [submission, setSubmission] = useState<RevisionSubmission>();
  const [canEditRejectedSubmission, setCanEditRejectedSubmission] =
    useState(false);
  const canSend =
    composerAvailable && !pending && !!input.trim() && materials.ready;
  const clearSubmission = () => {
    submissionRef.current = undefined;
    setSubmission(undefined);
  };
  const editRejectedDraft = () => {
    clearSubmission();
    setCanEditRejectedSubmission(false);
    setError(undefined);
  };
  const steer = async () => {
    const message = input.trim();
    if (!message || !canSend) return;
    setPending(true);
    setError(undefined);
    setCanEditRejectedSubmission(false);
    try {
      if (conversing && !filesSelected && !submissionRef.current)
        await steerJob(job.id, message);
      else {
        submissionRef.current ??= {
          instructions: message,
          requestId: crypto.randomUUID(),
          uploadIds: materials.uploadIds
        };
        setSubmission(submissionRef.current);
        const queued = await reviseJob(
          job.id,
          submissionRef.current.instructions,
          globalThis.fetch,
          submissionRef.current
        );
        materials.draft.clear();
        clearSubmission();
        onRevision(queued);
      }
      onDraftChange?.("", input);
    } catch (caught) {
      const wasRevision = !!submissionRef.current;
      if (canCorrectMaterialSubmission(caught)) clearSubmission();
      else if (
        wasRevision &&
        caught instanceof APIError &&
        caught.status === 429
      )
        setCanEditRejectedSubmission(true);
      setError(
        caught instanceof APIError && caught.status === 409 && !wasRevision
          ? "This agent finished before the message arrived."
          : caught instanceof Error
            ? caught.message
            : "Message could not be sent"
      );
    } finally {
      setPending(false);
    }
  };

  const interrupt = async () => {
    if (!conversing || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await interruptJob(job.id);
    } catch (caught) {
      setError(
        caught instanceof APIError && caught.status === 409
          ? "This specialist has already stopped."
          : caught instanceof Error
            ? caught.message
            : "Interrupt failed"
      );
    } finally {
      setPending(false);
    }
  };

  return {
    pending,
    error,
    setError,
    submission,
    canEditRejectedSubmission,
    canSend,
    steer,
    interrupt,
    editRejectedDraft
  };
}
