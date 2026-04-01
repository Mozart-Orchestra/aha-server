# Account Recovery Implementation Checklist

Goal: same Google identity always resolves to the same canonical account secret, while each device keeps its own `machineId` and machine label so team/group chat continues to route correctly.

## In Progress

- [x] Preserve machine labels across CLI daemon restarts by merging existing machine metadata before re-registration.
- [x] Add server-side account recovery material model and migration.
- [x] Add authenticated bootstrap endpoint for storing wrapped canonical account secret.
- [x] Add Supabase recovery endpoint for returning the canonical secret to a new device.
- [x] Switch Kanban Supabase login flow to: prove secret -> recover secret -> create new secret.
- [x] Bootstrap recovery material from existing authenticated Kanban sessions.
- [x] Unify primary direct-run onboarding command to `npm i aha-agi && npx aha auth login`.
- [x] Keep restore key command as the backup/fallback path.

## Remaining Verification

- [x] Typecheck `happy-server-0330-max-redefine-login`.
- [ ] Typecheck `kanban-0330-max-redefine-login`.
- [x] Typecheck `aha-cli-0330-max-redefine-login`.
- [x] Run targeted auth route tests on `happy-server-0330-max-redefine-login`.
- [ ] Manually verify: existing Google account on a fresh browser recovers the same account secret.
- [ ] Manually verify: renamed machine keeps `displayName` after daemon restart.
- [x] Link New Device page now exposes both the recommended direct-run login command and the fallback restore command in one view.
- [ ] Manually verify: Home onboarding and Link New Device page both offer the unified direct-run command.

Note: full `kanban` typecheck currently OOMs even with an 8 GB heap on this workspace. Use targeted verification for the touched auth/onboarding files until the project-wide TypeScript memory budget is fixed.

## Follow-up

- [ ] Decide whether Kanban should expose `recoveryReady` state explicitly in Account settings.
