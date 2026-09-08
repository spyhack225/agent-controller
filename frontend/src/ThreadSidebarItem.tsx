import { Archive, CircleDot, Ellipsis, Pencil, Trash2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";

import type { T3Thread } from "./types";
import { Button, useConfirm } from "./ui";

interface ThreadSidebarItemProps {
  thread: T3Thread;
  active: boolean;
  status?: string | null;
  rowProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onSelect: () => void;
  onRename: (title: string) => Promise<boolean>;
  onArchive: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

/** One thread row plus its intentionally disclosed, text-labelled management actions. */
export function ThreadSidebarItem({
  thread,
  active,
  status,
  rowProps,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: ThreadSidebarItemProps) {
  const confirm = useConfirm();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(thread.title ?? thread.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const renameDialogRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const displayTitle = thread.title ?? thread.label;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!renameOpen) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameOpen]);

  const closeRename = () => {
    if (pending) return;
    setRenameOpen(false);
    setRenameError(null);
    menuButtonRef.current?.focus();
  };

  const trapRenameDialog = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRename();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...(renameDialogRef.current?.querySelectorAll<HTMLElement>(
      'input, button:not([disabled])',
    ) ?? [])];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const title = renameValue.trim();
    if (!title) {
      setRenameError("Enter a thread name.");
      renameInputRef.current?.focus();
      return;
    }
    setPending(true);
    setRenameError(null);
    let succeeded = false;
    try {
      succeeded = await onRename(title);
    } catch {
      succeeded = false;
    } finally {
      setPending(false);
    }
    if (succeeded) {
      setRenameOpen(false);
      menuButtonRef.current?.focus();
    } else {
      setRenameError("The thread could not be renamed. Try again.");
    }
  };

  const archiveThread = async () => {
    setMenuOpen(false);
    const approved = await confirm({
      title: `Archive “${displayTitle}”?`,
      description: "The thread will leave this workspace. It can still be restored from T3 Code.",
      confirmLabel: "Archive thread",
      tone: "primary",
    });
    if (!approved) {
      menuButtonRef.current?.focus();
      return;
    }
    setPending(true);
    try {
      const succeeded = await onArchive();
      if (!succeeded) menuButtonRef.current?.focus();
    } catch {
      menuButtonRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  const deleteThread = async () => {
    setMenuOpen(false);
    const approved = await confirm({
      title: `Delete “${displayTitle}”?`,
      description: "This permanently deletes the thread and its conversation from T3 Code. This action cannot be undone.",
      confirmLabel: "Delete thread",
      tone: "danger",
    });
    if (!approved) {
      menuButtonRef.current?.focus();
      return;
    }
    setPending(true);
    try {
      const succeeded = await onDelete();
      if (!succeeded) menuButtonRef.current?.focus();
    } catch {
      menuButtonRef.current?.focus();
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="resource-thread"
      {...rowProps}
      data-active={active || undefined}
    >
      <button
        type="button"
        className="resource-thread__select"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
      >
        <CircleDot className="size-3" aria-hidden="true" />
        <span>{thread.label}</span>
        {status ? <span className="resource-thread__status">{status}</span> : null}
      </button>
      <button
        ref={menuButtonRef}
        type="button"
        className="resource-thread__menu-trigger"
        aria-label={`Thread actions for ${displayTitle}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={pending}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <Ellipsis className="size-3.5" aria-hidden="true" />
      </button>

      {menuOpen ? (
        <div className="resource-thread-menu" role="menu" aria-label={`Actions for ${displayTitle}`}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setRenameValue(displayTitle);
              setRenameOpen(true);
            }}
          >
            <Pencil aria-hidden="true" />
            Rename
          </button>
          <button type="button" role="menuitem" onClick={() => void archiveThread()}>
            <Archive aria-hidden="true" />
            Archive
          </button>
          <button
            type="button"
            role="menuitem"
            className="resource-thread-menu__danger"
            onClick={() => void deleteThread()}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </button>
        </div>
      ) : null}

      {renameOpen ? (
        <div className="thread-rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeRename();
        }}>
          <div
            ref={renameDialogRef}
            className="thread-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`rename-thread-${thread.id}`}
            onKeyDown={trapRenameDialog}
          >
            <h2 id={`rename-thread-${thread.id}`}>Rename thread</h2>
            <p>Choose a short name that will stay recognizable in the workspace sidebar.</p>
            <form onSubmit={(event) => void submitRename(event)}>
              <label htmlFor={`rename-thread-input-${thread.id}`}>Thread name</label>
              <input
                ref={renameInputRef}
                id={`rename-thread-input-${thread.id}`}
                value={renameValue}
                maxLength={72}
                disabled={pending}
                aria-invalid={Boolean(renameError)}
                aria-describedby={renameError ? `rename-thread-error-${thread.id}` : undefined}
                onChange={(event) => setRenameValue(event.target.value)}
              />
              {renameError ? (
                <p id={`rename-thread-error-${thread.id}`} className="thread-rename-dialog__error" role="alert">
                  {renameError}
                </p>
              ) : null}
              <div className="thread-rename-dialog__actions">
                <Button type="button" onClick={closeRename} disabled={pending}>Cancel</Button>
                <Button type="submit" variant="primary" busy={pending}>Save name</Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
