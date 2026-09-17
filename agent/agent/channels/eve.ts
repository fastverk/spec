import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

/**
 * Who may talk to the agent.
 *
 * ⛔ THERE IS NO BROWSER-USER AUTH HERE YET, AND THAT IS WHY THIS IS NOT MOUNTED
 * IN THE CONSOLE. `localDev()` admits localhost and `vercelOidc()` admits
 * Vercel-issued deployment tokens; neither admits a SAVVI person signing in with
 * Google. Wiring that means reading the console's `spec_session` cookie and
 * turning it into a principal, so that an approval is releasable only by the
 * human it is shown to — and an approval that anyone can release is not an
 * approval, it is a delay.
 *
 * Until that exists this agent runs locally against a local console, which is
 * the honest shape of a thing that has been built and not yet trusted.
 *
 * ⚠ eve's default when this file is absent is `[vercelOidc(), localDev(),
 * placeholderAuth()]`, which rejects all production traffic. The file is written
 * out rather than omitted so that the omission is a decision on the record
 * instead of a default nobody read.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev()],

  // Follow-ups WAIT rather than cancelling the turn in flight. The default
  // ("steer") cooperatively cancels and restarts, which is right for a chat and
  // wrong here: a turn can be parked on an approval for a permanent write, and
  // steering it away mid-approval means the person's decision applies to a turn
  // that no longer exists.
  turnPolicy: "queue",
});
