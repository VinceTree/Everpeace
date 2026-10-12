import React, { useState } from "react";
import { render, Box, Text } from "ink";
import { ActionConfirmation } from "../../src/tui/components/screens/action-confirmation.js";
import { WebSurface } from "../../src/tui/components/screens/web-surface.js";
import { CostSurface } from "../../src/tui/components/screens/cost-surface.js";
let requests = 0, configured = 0;
const panel = process.argv[2];
function Fixture() {
  const [done, setDone] = useState(false);
  function back() { setDone(true); setTimeout(() => handle.unmount(), 150); }
  return <Box flexDirection="column"><Text>Fixture session history</Text>{done ? <Text>{`SESSION_RESTORED requests=${requests} configured=${configured}`}</Text> : ["privacy", "memory"].includes(panel!) ? <ActionConfirmation text={panel === "privacy" ? "Set retention to 90 days? Eligible: 0; excluded: active Session. Logical deletion; independent stores retained." : "Confirm revision-bound Memory renewal? Expired entries pause recall."} start={() => { configured++; back(); }} cancel={back} /> : panel === "doctor" ? <ActionConfirmation text="Live diagnostic preview: endpoint offline; maximum 8 requests; budget 20000" start={() => { requests++; back(); }} cancel={back} /> : panel === "web" ? <WebSurface configure={async () => { configured++; }} onBack={back} /> : <CostSurface modelId="offline" status={async () => "Unknown prices and usage"} configure={async () => { configured++; }} onBack={back} />}</Box>;
}
// The fixture owns a real PTY even when the parent is a CI process.
const handle = render(<Fixture />, { interactive: true });
