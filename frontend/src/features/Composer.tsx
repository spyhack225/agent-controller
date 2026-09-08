/**
 * The request composer, shared by the Operate workspace and the phone Quick surface.
 *
 * One free-form field is the primary control. Attachments are an ordered draft list — their order
 * is the order the agent receives them in — and shell input is a deliberate secondary mode, kept
 * behind an explicit toggle because it is screened and approved differently and must never be
 * reachable by accident.
 */

import {
  ChevronDown,
  ChevronUp,
  Camera,
  Images,
  Mic,
  Paperclip,
  Terminal,
  UploadCloud,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import type { Controller } from "../controller";
import { clearDurableMutationRequest, durableMutationRequest } from "../requestId";
import type { JsonRecord, MediaItem } from "../types";
import { Button } from "../ui";
import {
  MediaCaptureDialog,
  MediaPicker,
  isAttachableFile,
  mediaLabel,
  mediaState,
  type MediaSource,
} from "./MediaCapture";

/** Must stay at or below the server's MAX_MEDIA_ATTACHMENTS (src/media.mjs). */
export const MAX_ATTACHMENTS = 8;

export type ComposerMode = "prompt" | "shell";

export interface ComposerDraft {
  prompt: string;
  setPrompt: (value: string) => void;
  attachmentIds: string[];
  attachments: MediaItem[];
  attachableMedia: MediaItem[];
  atLimit: boolean;
  addAttachment: (mediaUploadId: string) => void;
  addAttachments: (mediaUploadIds: string[]) => void;
  removeAttachment: (mediaUploadId: string) => void;
  moveAttachment: (index: number, offset: number) => void;
  clearAttachments: () => void;
  reset: () => void;
}

export function useComposerDraft(media: MediaItem[]): ComposerDraft {
  const [prompt, setPrompt] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);

  // An id can outlive the record it points at (retention sweep, deletion elsewhere); keep the
  // placeholder so the user can still see and remove the chip.
  const attachments = useMemo(
    () => attachmentIds.map((id) =>
      media.find((item) => item.id === id) ?? { id, kind: "unknown", contentType: "" }),
    [attachmentIds, media],
  );
  const attachableMedia = useMemo(
    () => media.filter((item) => !attachmentIds.includes(item.id)),
    [attachmentIds, media],
  );

  const addAttachments = useCallback((mediaUploadIds: string[]) => {
    setAttachmentIds((current) => {
      const next = [...current];
      for (const id of mediaUploadIds) {
        if (!id || next.includes(id) || next.length >= MAX_ATTACHMENTS) continue;
        next.push(id);
      }
      return next.length === current.length ? current : next;
    });
  }, []);

  const addAttachment = useCallback((mediaUploadId: string) => {
    addAttachments([mediaUploadId]);
  }, [addAttachments]);

  const removeAttachment = useCallback((mediaUploadId: string) => {
    setAttachmentIds((current) => current.filter((id) => id !== mediaUploadId));
  }, []);

  const moveAttachment = useCallback((index: number, offset: number) => {
    setAttachmentIds((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const clearAttachments = useCallback(() => setAttachmentIds([]), []);
  const reset = useCallback(() => {
    setPrompt("");
    setAttachmentIds([]);
  }, []);

  return {
    prompt,
    setPrompt,
    attachmentIds,
    attachments,
    attachableMedia,
    atLimit: attachmentIds.length >= MAX_ATTACHMENTS,
    addAttachment,
    addAttachments,
    removeAttachment,
    moveAttachment,
    clearAttachments,
    reset,
  };
}

/**
 * One field, one intent. Without attachments the request is a plain `agent_prompt`; with them it
 * takes the media path so the `media_prompt` capability gate still applies. An all-audio list keeps
 * `audio_prompt` so the transcript reaches T3 with its audio provenance; anything else — including
 * a mixed list, which the server accepts — goes through `camera_prompt`.
 */
export function buildComposerIntent({
  mode,
  text,
  attachments,
}: {
  mode: ComposerMode;
  text: string;
  attachments: MediaItem[];
}): JsonRecord {
  const trimmed = text.trim();
  if (mode === "shell") return { type: "shell_input", command: trimmed };
  if (attachments.length === 0) return { type: "agent_prompt", text: trimmed };
  const mediaUploadIds = attachments.map((item) => item.id);
  if (attachments.every((item) => item.kind === "audio")) {
    return { type: "audio_prompt", transcript: trimmed, mediaUploadIds };
  }
  return {
    type: "camera_prompt",
    prompt: trimmed || "Use the attached context.",
    mediaUploadIds,
  };
}

/**
 * The single path a composed request takes to the gateway. Operate and Quick both go through it, so
 * a message sent from the phone surface is screened by exactly the same policy, lands in the same
 * thread, and refreshes the same state as one sent from the full workspace.
 */
export async function sendComposerIntent(
  c: Controller,
  intent: JsonRecord,
  successMessage: string,
): Promise<unknown> {
  if (!c.selectedEnvironmentId) {
    c.setNotice({ tone: "danger", message: "Pair and select a T3 environment first." });
    return undefined;
  }
  return c.run("send-intent", successMessage, async () => {
    const pending = await durableMutationRequest({
      environmentId: c.selectedEnvironmentId,
      threadId: c.selectedThreadId,
      intent,
    });
    const body: JsonRecord = {
      environmentId: c.selectedEnvironmentId,
      intent,
      clientRequestId: pending.clientRequestId,
    };
    if (intent.type !== "status") body.threadId = c.selectedThreadId;
    const result = await c.api("/v1/intents", { method: "POST", body });
    clearDurableMutationRequest(pending.storageKey);
    await c.refreshAll();
    // The message has already been accepted at this point. A snapshot outage should open the
    // existing recovery flow without making the composer imply that the user needs to resend it.
    try {
      await c.loadSnapshot(c.selectedEnvironmentId);
    } catch {
      // loadSnapshot owns the recovery dialog state.
    }
    return result;
  });
}


export function AttachmentChips({
  attachments,
  onRemove,
  onMove,
}: {
  attachments: MediaItem[];
  onRemove: (mediaUploadId: string) => void;
  onMove: (index: number, offset: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ol className="thread-attachment-chips" aria-label="Attachments">
      {attachments.map((item, index) => (
        <li key={item.id} className="thread-attachment-chip">
          <span className="thread-attachment-chip__position">{index + 1}</span>
          <span className="thread-attachment-chip__name">{mediaLabel(item)}</span>
          <small>{item.kind} · {mediaState(item)}</small>
          <button
            type="button"
            aria-label={`Move ${mediaLabel(item)} earlier`}
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${mediaLabel(item)} later`}
            disabled={index === attachments.length - 1}
            onClick={() => onMove(index, 1)}
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${mediaLabel(item)}`}
            onClick={() => onRemove(item.id)}
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * Uploads dropped or pasted files and attaches them in the order they arrived. Returned as a hook
 * so both composers share the size ceiling, the kind filter and the busy key.
 */
export function useFileAttachment({
  controller: c,
  draft,
}: {
  controller: Controller;
  draft: ComposerDraft;
}) {
  const remaining = MAX_ATTACHMENTS - draft.attachmentIds.length;
  const { addAttachments } = draft;
  return useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const attachable = files.filter((file) => isAttachableFile(file));
    if (attachable.length === 0) {
      c.setNotice({ tone: "danger", message: "Only image and audio files can be attached." });
      return;
    }
    if (remaining <= 0) {
      c.setNotice({
        tone: "danger",
        message: `A request can carry at most ${MAX_ATTACHMENTS} attachments.`,
      });
      return;
    }
    const accepted = attachable.slice(0, remaining);
    await c.run(
      "attach-files",
      accepted.length > 1 ? `${accepted.length} attachments added.` : "Attachment added.",
      async () => {
        const added: string[] = [];
        for (const file of accepted) {
          const media = await c.uploadMedia({
            kind: file.type.startsWith("audio/") ? "audio" : "image",
            contentType: file.type,
            blob: file,
            originalName: file.name,
          });
          added.push(media.id);
        }
        addAttachments(added);
        return { attached: added.length };
      },
    );
  }, [addAttachments, c, remaining]);
}

/**
 * The single attachment affordance: one button, four sources. Uploading, recording and the camera
 * all go through the shared capture dialog; the library lists what is already stored.
 */
export function AttachmentSourceMenu({
  controller: c,
  draft,
  disabled = false,
  disabledReason,
}: {
  controller: Controller;
  draft: ComposerDraft;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [captureSource, setCaptureSource] = useState<MediaSource | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const open = menuOpen || libraryOpen;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setLibraryOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setLibraryOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const atLimit = draft.atLimit;
  const blocked = disabled || atLimit;
  const title = disabled
    ? disabledReason
    : atLimit
      ? `Attachment limit reached (${MAX_ATTACHMENTS})`
      : "Attach an image or a voice clip";

  const openCapture = (source: MediaSource) => {
    setMenuOpen(false);
    setLibraryOpen(false);
    setCaptureSource(source);
  };

  return (
    <div className="composer-attach" ref={wrapperRef}>
      <Button
        ref={triggerRef}
        size="icon"
        variant="ghost"
        disabled={blocked}
        aria-label="Add attachment"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={title}
        onClick={() => {
          setLibraryOpen(false);
          setMenuOpen((current) => !current);
        }}
      >
        <Paperclip className="size-4" />
      </Button>

      {menuOpen ? (
        <div className="composer-source-menu" role="menu" aria-label="Attachment source">
          <button type="button" role="menuitem" onClick={() => openCapture("upload")}>
            <UploadCloud className="size-4" /> Upload from this device
          </button>
          <button type="button" role="menuitem" onClick={() => openCapture("audio")}>
            <Mic className="size-4" /> Record voice
          </button>
          <button type="button" role="menuitem" onClick={() => openCapture("camera")}>
            <Camera className="size-4" /> Take a photo
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setLibraryOpen(true);
            }}
          >
            <Images className="size-4" /> Choose from media library
          </button>
        </div>
      ) : null}

      {libraryOpen ? (
        <div className="composer-library" role="dialog" aria-label="Choose from media library">
          <header>
            <h3>Media library</h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setLibraryOpen(false);
                triggerRef.current?.focus();
              }}
            >
              Done
            </Button>
          </header>
          <MediaPicker
            media={draft.attachableMedia}
            label="Media library"
            emptyMessage={draft.attachmentIds.length
              ? "Everything stored is already attached."
              : "No stored media yet. Upload, record, or take a photo instead."}
            onSelect={(item) => {
              draft.addAttachment(item.id);
              if (draft.attachmentIds.length + 1 >= MAX_ATTACHMENTS) setLibraryOpen(false);
            }}
          />
        </div>
      ) : null}

      {captureSource ? (
        <MediaCaptureDialog
          controller={c}
          initialSource={captureSource}
          title="Add attachment"
          description="The capture is stored in your media library and attached to this request."
          onClose={() => setCaptureSource(null)}
          onUploaded={(media) => {
            draft.addAttachment(media.id);
            setCaptureSource(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function ShellModeToggle({
  mode,
  onChange,
  disabled = false,
}: {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="composer-mode-toggle"
      data-active={mode === "shell" || undefined}
      aria-pressed={mode === "shell"}
      disabled={disabled}
      title="Shell commands are screened and approved separately, and cannot carry attachments."
      onClick={() => onChange(mode === "shell" ? "prompt" : "shell")}
    >
      <Terminal className="size-3.5" /> Shell
    </button>
  );
}

export interface ComposerShellProps {
  textareaId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  canSend: boolean;
  onSubmit: () => void;
  /** Receives pasted and dropped files; omit to disable both. */
  onFiles?: (files: File[]) => void;
  attachments?: ReactNode;
  actions?: ReactNode;
  send: ReactNode;
  compact?: boolean;
}

export function ComposerShell({
  textareaId,
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  canSend,
  onSubmit,
  onFiles,
  attachments,
  actions,
  send,
  compact = false,
}: ComposerShellProps) {
  const [dropping, setDropping] = useState(false);

  const handleFiles = (files: FileList | null | undefined) => {
    const list = Array.from(files ?? []);
    if (list.length === 0 || !onFiles) return false;
    onFiles(list);
    return true;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    setDropping(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onFiles) return;
    setDropping(false);
    if (handleFiles(event.dataTransfer?.files)) event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!onFiles) return;
    if (handleFiles(event.clipboardData?.files)) event.preventDefault();
  };

  return (
    <div
      className="composer-shell"
      data-compact={compact || undefined}
      data-dropping={dropping || undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {attachments}
      <label htmlFor={textareaId} className="sr-only">{label}</label>
      <textarea
        id={textareaId}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSend) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-footer__actions">{actions}</div>
        <div className="composer-footer__send">{send}</div>
      </div>
      {dropping ? (
        <p className="composer-dropzone" role="status">Drop images or audio to attach</p>
      ) : null}
    </div>
  );
}
