# Crop Web («چارچوب»)

React + Vite frontend (custom CSS kit, no Tailwind classes in JSX) for the
automatic photo-crop service. Single app at the repo root.

This is a **standalone** app: no Figma Make toolchain. Run it locally with npm.

## Development Server

- Install: `npm install`
- Dev: `npm run dev` → http://localhost:8443 (strict port, HOT reload)
- Prod build: `npm run build` (outputs `dist/`), preview: `npm run preview`
- Backend (Python): `uvicorn server:app --port 8000` — or `start_all.bat`
  (starts backend :8000 + frontend :8443)

## Project Structure

- `src/main.tsx` - React entrypoint; imports `src/index.css` and mounts `src/App.tsx`
- `src/App.tsx` - Everything: header/nav (home / about), 4-stage wizard
  (۱ آپلود و نسبت → ۲ کارگاه برش → ۳ استودیو قاب/لوگو → ۴ خروجی‌ها),
  review modal, custom-crop modal, processing overlay
- `src/api.ts` - Backend contract layer (`/crop/multi`, `/composite` on
  `http://localhost:8000`, override with `VITE_API_BASE_URL`)
- `src/index.css` - Design-system CSS (tokens, kit components, responsive)
- `vite.config.ts` - Vite + React + `@` alias for `src`
- `index.html` - HTML shell (Persian, RTL)

## UX rules (locked)

- The stage-3/4 monitor always shows the latest crop with all changes applied.
- Subject switching happens only via the tools-column list.
- Check all 4 stages together after any change; use kit elements only.

## Dependencies

- Runtime: React 19, React DOM 19
- Build: Vite 8, TypeScript 5.7, `@vitejs/plugin-react`
- Formatting: oxfmt (`npm run format`)

## Code quality

- Export components as default exports.
- Keep files small and focused; put new UI pieces under `src/components/`.
