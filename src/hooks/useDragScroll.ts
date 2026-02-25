import { useRef, useCallback, type RefObject, type MouseEvent } from 'react';

interface DragScrollReturn {
    ref: RefObject<HTMLElement | null>;
    onMouseDown: (e: MouseEvent) => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
}

/**
 * Hook that enables click-and-drag scrolling on a container.
 * Supports both horizontal and vertical dragging.
 * Uses a threshold so normal clicks on buttons/links aren't swallowed.
 */
export function useDragScroll(): DragScrollReturn {
    const ref = useRef<HTMLElement | null>(null);
    const state = useRef({
        isDown: false,
        startX: 0,
        startY: 0,
        scrollLeft: 0,
        scrollTop: 0,
    });

    const onMouseDown = useCallback((e: MouseEvent) => {
        // Skip if clicking on interactive elements
        const tag = (e.target as HTMLElement).tagName;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

        const el = ref.current;
        if (!el) return;
        state.current = {
            isDown: true,
            startX: e.pageX,
            startY: e.pageY,
            scrollLeft: el.scrollLeft,
            scrollTop: el.scrollTop,
        };
    }, []);

    const onMouseMove = useCallback((e: MouseEvent) => {
        if (!state.current.isDown) return;
        const el = ref.current;
        if (!el) return;

        const dx = e.pageX - state.current.startX;
        const dy = e.pageY - state.current.startY;

        // Only start dragging after a threshold to preserve clicks
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            e.preventDefault();
            el.scrollLeft = state.current.scrollLeft - dx;
            el.scrollTop = state.current.scrollTop - dy;
        }
    }, []);

    const onMouseUp = useCallback(() => {
        state.current.isDown = false;
    }, []);

    const onMouseLeave = useCallback(() => {
        state.current.isDown = false;
    }, []);

    return { ref, onMouseDown, onMouseMove, onMouseUp, onMouseLeave };
}
