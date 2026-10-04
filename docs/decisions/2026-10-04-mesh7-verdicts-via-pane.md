# mesh7's verdicts reach avatar7 through mesh7-pane

- **Problem**: avatar7 guessed mesh7's refusals and holds by matching the text of mesh7's answers, and polled `/approvals` itself; mesh7-pane, in session scope, showed none of the session's MCP calls, whose traces carry the MCP connection's session id.
- **Decision**: mesh7-pane says refusals (with rule), MCP holds and the human's decision from the structured traces and approvals; avatar7 knows nothing of mesh7, holds its own line on such calls ~1.8 s and drops it when a `say` names the same tool. The pane learns the MCP session by matching a call to its trace.
- **Why**: structured verdicts survive a change of wording in mesh7, and the stage keeps knowing no mod by name.
- **Where**: `mesh7-pane/hooks/register.tsx` (`claudeName`, `verdictSay`, `decisionSay`, MCP session match), `avatar7/hooks/register.tsx` (say `tool`/`hold`/`release`, `SAY_WAIT_FRAMES`). Not tested live: a refusal and a hold on an MCP call.
