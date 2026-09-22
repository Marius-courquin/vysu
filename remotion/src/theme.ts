import { useEffect, useState } from 'react';
import { loadFont } from '@remotion/fonts';
import { continueRender, delayRender, staticFile } from 'remotion';
import defaultJson from '../themes/default/theme.json';
import { themeSchema, type Theme } from './schema.ts';

// The theme bundled for Studio's defaultProps; `scripts/render.ts` reads themes/<name>/theme.json
// from disk instead, so adding a theme is a folder and never a code change.
export const defaultTheme: Theme = themeSchema.parse(defaultJson);

// Returns whether the faces are in: anything that MEASURES text (the title's line fit) must wait
// for them, or it measures the fallback font and shrinks a title that would have fitted.
export function useThemeFonts(theme: Theme): boolean {
  const [handle] = useState(() => delayRender('theme fonts'));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Promise.all(
      theme.fonts.faces.map((face) =>
        loadFont({
          family: face.family,
          url: staticFile(face.file),
          weight: String(face.weight),
        }),
      ),
    ).then(
      () => {
        setReady(true);
        continueRender(handle);
      },
      () => {
        setReady(true);
        continueRender(handle);
      },
    );
  }, [handle, theme]);
  return ready;
}
