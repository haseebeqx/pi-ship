export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! > b.numbers[i]! ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function validateVersion(value: string): void {
  parseVersion(value);
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease?: string } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`Invalid runtime version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const aNumber = /^\d+$/.test(a[i]!) ? Number(a[i]) : undefined;
    const bNumber = /^\d+$/.test(b[i]!) ? Number(b[i]) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== undefined) return -1;
    if (bNumber !== undefined) return 1;
    return a[i]!.localeCompare(b[i]!);
  }
  return 0;
}
