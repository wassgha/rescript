"use client";

import { useId } from "react";
import { useI18n } from "./I18nProvider";

/** Filled silhouette of the Rescript "R", used to clip the sliding bars. */
const R_PATH =
  "M45.5 44L57 61H4.5C1.71605 60.1158 0.837624 59.04 0 56.5V52V44V35V26.5V17.5V9V4.5C0.902895 2.15806 1.75648 1.08485 4.5 0H37.5C46.5678 1.963 49.8193 4.07203 53.5 9C55.4387 11.5376 56.3089 13.4198 57.5 17.5C57.9279 20.9844 57.8419 22.8121 57.5 26C56.4745 30.0901 55.5524 32.0111 53.5 35C50.039 40.2343 46.4414 42.1446 37.5 44H45.5Z";

const VIEW_W = 58;
const VIEW_H = 61;

// Each row is a pair of rounded bars with a slot between them, both running far
// past the silhouette so the R's outline never breaks as the pair slides — only
// the slot travels across, sweeping the logo's cut-outs left and right.
// Uneven slot centres and widths give every row its own bar lengths, and odd
// rows run the reversed keyframes so neighbours sweep against each other.
const SLOTS = [
  { center: 31, width: 12 },
  { center: 26, width: 19 },
  { center: 33, width: 10 },
  { center: 27, width: 16 },
];
const ROW_GAP = 5.5;
const ROW_HEIGHT = (VIEW_H - (SLOTS.length - 1) * ROW_GAP) / SLOTS.length;
const OVERHANG = 70;
/** Seconds between neighbouring rows, applied as a negative delay so the slots fan out. */
const ROW_STAGGER = 0.11;

export default function LogoLoader({
  size = 44,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  const { t } = useI18n();
  // Ids must be unique per instance, and React's contain colons that trip up url().
  const clipId = `logo-r-${useId().replace(/:/g, "")}`;
  const markHeight = size * 0.56;

  return (
    <div
      role="img"
      aria-label={t("common.loading")}
      className={`flex items-center justify-center rounded-[22%] bg-transparent text-zinc-900 dark:text-zinc-100 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={(markHeight * VIEW_W) / VIEW_H}
        height={markHeight}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        fill="none"
      >
        <defs>
          <clipPath id={clipId}>
            <path d={R_PATH} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`} fill="currentColor">
          {SLOTS.map(({ center, width }, i) => {
            const y = i * (ROW_HEIGHT + ROW_GAP);
            const slotStart = center - width / 2;
            return (
              <g
                key={i}
                className={i % 2 ? "logo-bar logo-bar-alt" : "logo-bar"}
                style={{ animationDelay: `${-i * ROW_STAGGER}s` }}
              >
                <rect
                  x={-OVERHANG}
                  y={y}
                  width={OVERHANG + slotStart}
                  height={ROW_HEIGHT}
                  rx={ROW_HEIGHT / 2}
                />
                <rect
                  x={slotStart + width}
                  y={y}
                  width={OVERHANG}
                  height={ROW_HEIGHT}
                  rx={ROW_HEIGHT / 2}
                />
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
