/** Time-of-day greeting, shared by the workspace dashboard and the phone home. */
export function greetingFor(name: string) {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = name.split(" ")[0] ?? "there";
  return `${part}, ${first}`;
}
