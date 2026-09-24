// What a test puts before a .ts file it starts with process.execPath: below Node 22.18 types are
// stripped only when asked, which bin/vysu.mjs does for a real launch.
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
export const TS_FLAGS: string[] = major === 22 && minor < 18 ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : [];
