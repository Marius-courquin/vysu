import React from 'react';
import {
  CHIMNEY,
  DOT_ORIGIN,
  FILL_FRONT_FROM,
  FILL_FRONT_RECT,
  FILL_FRONT_TO,
  HOUSE_ORIGIN,
  LOADER_GRADIENTS,
  NEST_D,
  NEST_GRADIENT_ID,
  NEST_OPACITY,
  SEED_POINT,
  SEED_RADIUS,
  STEM_BASE,
  STRANDS,
  STROKE_THICK,
  STROKE_THIN,
} from '../brand/loader-geometry.ts';
import {
  chimneyAt,
  fillAt,
  fillFrontAt,
  houseScaleAt,
  seedScaleAt,
  strandAt,
  strandWidthAt,
} from '../brand/loader-timeline.ts';
import { gradientStops, type Palette } from '../brand/palette.ts';

// The app's brand loader, drawn at one instant. The app plays it as generated CSS keyframes; here
// every value is an ATTRIBUTE computed from `t`, because Remotion renders one still frame at a
// time and a CSS animation would be stuck at its first keyframe in every one of them.
//
// One deliberate difference: the app paints the nest at NEST_OPACITY so its background reads
// through, and keeps it there. The film has to LAND on the logo, so the exact silhouette closes to
// full opacity — at t = 1 what is on screen is the mark itself, not a 72 % ghost of it.

const spin = (origin: { x: number; y: number }, transform: string) =>
  `translate(${origin.x} ${origin.y}) ${transform} translate(${-origin.x} ${-origin.y})`;

export const BrandLoader: React.FC<{ t: number; palette: Palette; uid: string }> = ({
  t,
  palette,
  uid,
}) => {
  const nestFill = `url(#${uid}-${NEST_GRADIENT_ID})`;
  const chimney = chimneyAt(t);
  const solid = fillAt(t);
  const nestAlpha = NEST_OPACITY + (1 - NEST_OPACITY) * solid;
  const front = FILL_FRONT_FROM + (FILL_FRONT_TO - FILL_FRONT_FROM) * fillFrontAt(t);
  const seed = Math.max(0, seedScaleAt(t));

  return (
    <>
      <defs>
        {LOADER_GRADIENTS.map((g, gi) => (
          <linearGradient
            key={g.id}
            id={`${uid}-${g.id}`}
            x1={g.x1}
            y1={g.y1}
            x2={g.x2}
            y2={g.y2}
            gradientUnits="userSpaceOnUse"
          >
            {gradientStops(palette, g, gi).map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        ))}
        {/* A stroke is centred on its path, so half of it falls outside the shape: clipping by the
            nest's own fill keeps the strands exact at every frame. */}
        <clipPath id={`${uid}-nest`}>
          <path d={NEST_D} />
        </clipPath>
        <clipPath id={`${uid}-front`}>
          <rect
            x={FILL_FRONT_RECT.x}
            y={front}
            width={FILL_FRONT_RECT.width}
            height={FILL_FRONT_RECT.height}
          />
        </clipPath>
      </defs>

      <g transform={spin(HOUSE_ORIGIN, `scale(${houseScaleAt(t)})`)}>
        <g clipPath={`url(#${uid}-front)`}>
          <path d={NEST_D} fill={nestFill} opacity={NEST_OPACITY} />
        </g>

        <g clipPath={`url(#${uid}-nest)`} opacity={NEST_OPACITY}>
          {STRANDS.map((strand, i) => {
            const grown = strandAt(t, strand.order);
            const segment = strand.length * grown;
            return (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: static path list, order is the identity
                key={i}
                d={strand.d}
                fill="none"
                stroke={nestFill}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={
                  grown === 0 ? 0 : strandWidthAt(t, strand.order, STROKE_THIN, STROKE_THICK)
                }
                strokeDasharray={`${segment} ${strand.length}`}
                strokeDashoffset={-(strand.anchor - segment / 2)}
              />
            );
          })}
          <circle
            cx={SEED_POINT.x}
            cy={SEED_POINT.y}
            r={SEED_RADIUS}
            fill={nestFill}
            transform={spin(SEED_POINT, `scale(${seed})`)}
          />
        </g>

        {/* The exact silhouette, closing over the construction. */}
        <path d={NEST_D} fill={nestFill} opacity={solid} />

        {/* Dot before stem: while it is still inside, it sits behind the chimney. */}
        <g
          opacity={chimney.dot.opacity}
          transform={spin(
            DOT_ORIGIN,
            `translate(0 ${chimney.dot.ty}) scale(${chimney.dot.scale})`,
          )}
        >
          {CHIMNEY.dot.map((path) => (
            <path
              key={path.role}
              d={path.d}
              fill={
                path.role === 'accent' ? palette.accent : `url(#${uid}-${path.gradientId ?? ''})`
              }
            />
          ))}
        </g>
        <g
          opacity={chimney.stem > 0 ? nestAlpha : 0}
          transform={spin(STEM_BASE, `scale(1 ${chimney.stem})`)}
        >
          <path d={CHIMNEY.stem.d} fill={`url(#${uid}-${CHIMNEY.stem.gradientId ?? ''})`} />
        </g>
      </g>
    </>
  );
};
