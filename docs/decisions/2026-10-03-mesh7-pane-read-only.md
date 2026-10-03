# mesh7-pane stays read-only

- **Problem**: approving mesh7 requests from the pane is one `POST /approvals/<id>/approve` away, but the mod runs inside the governed agent's session, and that agent can edit the mod's files.
- **Decision**: the pane shows decisions, pending approvals and emergency stops; it resolves nothing. Approvals go through `mesh approve|deny <id>` or `/mesh-approve`.
- **Why**: an approve button the agent can rewrite hands the agent its own approver; the separation of powers mesh7 exists for would end at the UI.
- **Where**: `mesh7-pane/hooks/register.tsx`; buttons come back only with a mesh7 rule that denies agent writes under `~/flux7-mods/mesh7-pane`.
