/**
 * Drag-and-drop and keyboard reordering for the sidebar tree.
 *
 * One hook instance serves every list on screen, because the lists are nested and rendered inside
 * `map` callbacks where a hook per list is not possible. Each row therefore names its own scope and
 * its own sibling ids when it asks for props.
 *
 * Two rules make the nesting safe:
 *
 *   - every handler stops propagation, so dragging a thread does not also register as dragging the
 *     folder that contains it;
 *   - a drop is ignored unless the dragged row belongs to the same list. Moving a thread into a
 *     different folder would be a change to the T3 workspace itself, which this console has no way
 *     to make and must not pretend to.
 */

import { useCallback, useState, type DragEvent, type KeyboardEvent } from "react";

interface RowSpec {
  /** Which list this row belongs to — see the scope helpers in `resourceOrder.ts`. */
  scope: string;
  id: string;
  /** The sibling ids, in the order currently displayed. */
  ids: readonly string[];
  /** Human name for the row, used in the shortcut hint. */
  label: string;
  /** False turns the row back into a plain row — see the filtered-tree note in `App.tsx`. */
  enabled?: boolean;
}

interface Handlers {
  onReorder: (scope: string, ids: readonly string[], sourceId: string, targetId: string) => void;
  onNudge: (scope: string, ids: readonly string[], id: string, delta: number) => void;
}

interface Dragging {
  scope: string;
  id: string;
}

export function useReorderable({ onReorder, onNudge }: Handlers) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const rowProps = useCallback(({ scope, id, ids, label, enabled = true }: RowSpec) => {
    if (!enabled || ids.length < 2) return { title: label };

    const isDragging = dragging?.id === id;
    // Only a row from the same list can be dropped here, so only such a row shows an indicator.
    const isTarget = Boolean(dragging) && dragging?.scope === scope && dragging.id !== id && overId === id;

    return {
      draggable: true,
      "data-dragging": isDragging || undefined,
      "data-drop-target": isTarget || undefined,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      title: `${label} — drag to reorder, or Alt+↑ / Alt+↓`,

      onDragStart: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        setDragging({ scope, id });
        setOverId(null);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          // Firefox refuses to start a drag unless some payload is set.
          event.dataTransfer.setData("text/plain", id);
        }
      },

      onDragEnd: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        setDragging(null);
        setOverId(null);
      },

      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!dragging || dragging.scope !== scope || dragging.id === id) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        setOverId(id);
      },

      onDragLeave: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        setOverId((current) => (current === id ? null : current));
      },

      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!dragging || dragging.scope !== scope || dragging.id === id) return;
        event.preventDefault();
        event.stopPropagation();
        onReorder(scope, ids, dragging.id, id);
        setDragging(null);
        setOverId(null);
      },

      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!event.altKey) return;
        const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        onNudge(scope, ids, id, delta);
      },
    };
  }, [dragging, onNudge, onReorder, overId]);

  return { rowProps, draggingScope: dragging?.scope ?? null };
}
