"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { activeWordOf, useEditorStore } from "@/lib/store";

/** Matches the transcript panel's floating header (`h-10` / `pt-10` / `scroll-pt-10`). */
const HEADER_H = 40;
/** Comfort band at the edges of the readable pane. The playhead is only
 *  re-centred once it drifts out of the band, so ordinary word-to-word
 *  progress reads without the text sliding under the eye every few hundred ms.
 *  Kept a little taller than the panel's bottom gradient (`h-20`). */
const EDGE_PAD = 84;

export type FollowDirection = "up" | "down" | null;

/**
 * Keep the active transcript word in view during playback, and get out of the
 * way the moment the user scrolls. Any deliberate scroll pauses following —
 * waiting for the playhead to leave the pane first means small scrolls get
 * yanked back on the next word, which reads as the panel fighting the user.
 * Following resumes on the Follow control, on a word click, or when playback
 * catches back up to whatever the user scrolled to.
 */
export function useTranscriptPlayheadFollow({
  scrollRef,
  containerRef,
  playing,
  activeWordId,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  playing: boolean;
  activeWordId: number;
}) {
  const followPlayheadRef = useRef(true);
  /** Set by wheel/touch/rail before the matching scroll event. */
  const userScrollGestureRef = useRef(false);
  const userScrollGestureTimerRef = useRef(0);
  /** The playhead has left the pane since following was paused — until it
   *  does, "back in view" means nothing and must not resume following. */
  const leftViewRef = useRef(false);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  /** Which way to jump to the playhead when unfollowed; null when it is on screen. */
  const [followDirection, setFollowDirection] = useState<FollowDirection>(null);

  /** Measure whether the active word sits above/below the readable pane. */
  const measurePlayheadAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return { offscreen: false as const };
    const activeId = activeWordOf(useEditorStore.getState());
    const el =
      activeId < 0
        ? null
        : containerRef.current?.querySelector(`[data-wid="${activeId}"]`);
    if (!el) {
      setFollowDirection(null);
      return { offscreen: false as const };
    }
    const wordRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const viewTop = scrollerRect.top + HEADER_H;
    const viewBottom = scrollerRect.bottom;
    if (wordRect.bottom < viewTop) {
      leftViewRef.current = true;
      setFollowDirection("up");
      return { offscreen: true as const, direction: "up" as const };
    }
    if (wordRect.top > viewBottom) {
      leftViewRef.current = true;
      setFollowDirection("down");
      return { offscreen: true as const, direction: "down" as const };
    }
    setFollowDirection(null);
    return { offscreen: false as const };
  }, [scrollRef, containerRef]);

  /** Rail / wheel / touch hint, so the next scroll event is known to be theirs. */
  const markUserScrollGesture = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return;
    userScrollGestureRef.current = true;
    // Keep the gesture armed across momentum / rail-drag scroll bursts.
    window.clearTimeout(userScrollGestureTimerRef.current);
    userScrollGestureTimerRef.current = window.setTimeout(() => {
      userScrollGestureRef.current = false;
    }, 150);
  }, [scrollRef]);

  const resumeFollowPlayhead = useCallback(() => {
    followPlayheadRef.current = true;
    leftViewRef.current = false;
    setFollowPlayhead(true);
    setFollowDirection(null);
  }, []);

  // Any user scroll pauses following immediately — wherever they land is where
  // they want to be. Wheel over a non-scrollable pane never arms the gesture.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onGesture = () => markUserScrollGesture();
    const onScroll = () => {
      if (!playing) return;
      if (userScrollGestureRef.current && followPlayheadRef.current) {
        followPlayheadRef.current = false;
        leftViewRef.current = false;
        setFollowPlayhead(false);
      }
      measurePlayheadAnchor();
    };
    scroller.addEventListener("wheel", onGesture, { passive: true });
    scroller.addEventListener("touchmove", onGesture, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onGesture);
      scroller.removeEventListener("touchmove", onGesture);
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(userScrollGestureTimerRef.current);
    };
  }, [
    scrollRef,
    markUserScrollGesture,
    measurePlayheadAnchor,
    playing,
  ]);

  // Keep the active word inside the comfort band during playback.
  useEffect(() => {
    if (!playing || !followPlayhead || activeWordId < 0) return;
    const scroller = scrollRef.current;
    const el = containerRef.current?.querySelector(
      `[data-wid="${activeWordId}"]`
    );
    if (!scroller || !el) return;
    const wordRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const viewTop = scrollerRect.top + HEADER_H;
    const viewBottom = scrollerRect.bottom;
    if (wordRect.top >= viewTop + EDGE_PAD && wordRect.bottom <= viewBottom - EDGE_PAD)
      return;
    const wordCentre = wordRect.top + wordRect.height / 2;
    const paneCentre = (viewTop + viewBottom) / 2;
    scroller.scrollTo({
      top: scroller.scrollTop + wordCentre - paneCentre,
      behavior: "smooth",
    });
  }, [activeWordId, playing, followPlayhead, scrollRef, containerRef]);

  // While unfollowed, track where the playhead sits so the control points the
  // right way, and hand following back once playback catches up to the reader.
  // Measured in a frame callback so layout has settled for the newly active
  // word (and so the state update stays out of the render pass).
  useEffect(() => {
    if (followPlayhead || !playing || activeWordId < 0) return;
    const raf = requestAnimationFrame(() => {
      const { offscreen } = measurePlayheadAnchor();
      if (!offscreen && leftViewRef.current && !userScrollGestureRef.current)
        resumeFollowPlayhead();
    });
    return () => cancelAnimationFrame(raf);
  }, [
    followPlayhead,
    playing,
    activeWordId,
    measurePlayheadAnchor,
    resumeFollowPlayhead,
  ]);

  return {
    showFollowControl: !followPlayhead && playing,
    followDirection,
    resumeFollowPlayhead,
    markUserScrollGesture,
  };
}
