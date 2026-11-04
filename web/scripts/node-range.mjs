// Understands only the caret ranges engines.node uses, and throws on anything else so an
// unreadable range can't pass as a match.
export function satisfies(version, range) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return range.split("||").some((part) => {
    const match = part.trim().match(/^\^(\d+)(?:\.(\d+))?$/);
    if (!match) throw new Error(`can't read the Node range "${part.trim()}"`);
    return major === Number(match[1]) && minor >= Number(match[2] ?? 0);
  });
}
