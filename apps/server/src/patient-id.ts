// The patients.id rule, shared by the agent (src/agent.ts) and the terminal
// simulator (src/cli/simulator.ts) so both name the same senior the same way.

/** Her given name in lower case (anything else becomes "-"), else the FinchNode subject. */
export function patientIdFor(givenName: string | undefined, subject: string): string {
  return (givenName ?? subject).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
